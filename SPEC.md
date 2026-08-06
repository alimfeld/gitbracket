# GitBracket

Tournaments as code: the repo is the database, git is the transaction log,
static pages are the frontend, a push is a deploy.

Runs any win/lose tournament (pickleball, tennis, darts, quiz). No draws in v1 —
chess and football are out.

- **Repo = database.** Structure, schedule, scores are JSON in git.
- **Git = transaction log.** `git log` is the audit, `git revert` the rollback.
- **Auth = push access.** No accounts, no sessions, no server.
- **Frontends are static.** GitHub Pages, vanilla JS, no build step.

```
git push ──▶ Actions deploy ──▶ Pages ──same-origin fetch (poll)──▶ kiosk / schedule / standings
```

Repo must be **public**: GitHub Pages on the free plan serves public repos only.

## Layout

```
tournaments.json            # [{ "slug": "2026-spring", "name": "Spring Open 2026" }, …] — newest last
tournaments/<slug>/
  tournament.json           # meta, timezone, venues, categories, players
  matches/<category-id>.json  # one file per category
index.html                  # links to tournaments
style.css                   # shared; venue.html adds a kiosk override block
venue.html                  # kiosk: now + next, one venue (?t=&v=) or all
player.html                 # mobile schedule (?t=&p=)
standings.html              # tables + bracket (?t=&c=)
app.js                      # fetch, render, derive
validate.js                 # schema + cross-file check (hook, local)
cli.js                      # score entry on match day: list scorable matches, set scores/forfeits (local)
schedule.js                 # one-off match generator (2026-mammut60); its output must be committed
tests.js                    # zero-dep runner: loads fixtures/, asserts (hook, CI)
fixtures/                   # test data — every dir is a mini repo, one scenario each
.github/workflows/pages.yml # upload repo root, deploy to Pages
```

App files sit at the root because that is what the workflow uploads and what the
relative data paths are resolved against.
One repo, one directory per tournament on `main`.

## Data

`tournaments.json` is the index: `slug` is the directory name and `name` the
display label — the name lives only here, nothing repeats it. Order is
chronological, so the last entry is the current event and `index.html` lists past
ones above it.

`tournaments/<slug>/tournament.json`

```jsonc
{
  "timezone": "America/New_York",
  "venues": [
    { "id": "court-3", "name": "Court 3" },
    { "id": "court-4", "name": "Court 4" }
  ],
  "categories": [
    { "id": "md40", "name": "Men's Doubles 40+", "bestOf": { "groups": 3, "knockout": 5 }, "slotMinutes": { "groups": 45, "knockout": 60 } }
  ],
  "players": [
    { "id": "p1", "name": "Ada Lovelace", "categories": ["md40"] },
    { "id": "p2", "name": "Grace Hopper", "categories": ["md40"] }
  ]
}
```

`bestOf` is the **match length in games** per stage, so a side wins at
`ceil(bestOf / 2)`. Always odd — v1 has no draws. There are exactly two stages, `groups` and `knockout`; a match is in
`groups` iff it has a `pool`. A match may carry its own `"bestOf": 3` (a plain
number) that overrides the stage default — that is how a best-of-1 knockout gets
a best-of-3 final and bronze. Venues are referenced by `id` everywhere (they are
URL params); venue `name` is display only.

`slotMinutes` is the **match length in wall-clock minutes per stage** — how long
a match owns its court. Optional; both keys default to 45. A match may carry its
own `"slotMinutes": 90` (a plain number) that overrides the stage default — that
is how a best-of-3 final gets a longer court booking than the group games. One
resolver, `matchSlotMs`, feeds the generator's slot grid, the venue-overlap
check, and the kiosk's "now" window.

No team entity: a doubles side is just its player ids, written inline in each
match. A pair entering two categories repeats its ids in both files — nothing
links them, and nothing needs to.

`tournaments/<slug>/matches/<category-id>.json`

```jsonc
{
  "matches": [{
    "id": "m1",
    "pool": "A",                      // present ⇒ stage "groups", absent ⇒ "knockout"
    "venue": "court-3",               // optional — omit for not-yet-placed
    "scheduled": "2025-07-14T09:00:00-04:00",  // optional — omit for TBD
    "slotMinutes": 90,               // optional — overrides the category slot (best-of-3 final, say)
    "bestOf": 3,                      // optional — overrides bestOf[stage] (final, bronze)
    "sides": [                        // exactly two: sides[0] = "a", sides[1] = "b"
      { "kind": "players", "ids": ["p1", "p3"] },
      { "kind": "players", "ids": ["p2", "p4"] }
    ],
    "games": [{ "a": 11, "b": 9 }, { "a": 11, "b": 7 }],  // prefix; partial while in play
    "forfeit": 1                      // instead of "games": side 1 forfeited, side 0 wins
  }]
}
```

A side is one source object:

```jsonc
{ "kind": "players", "ids": ["p1", "p3"] }               // singles: one id
{ "kind": "match",  "match": "m9", "result": "winner" }  // knockout slot
{ "kind": "match",  "match": "m9", "result": "loser" }   // bronze / placement
{ "kind": "pool",   "pool": "A", "rank": 1 }             // group → knockout
```

This enum covers every v1 format: round robin, single elimination,
group→knockout, placement rounds. Slots are category-local (`match` ids are
unique per category), so the full bracket is committed before a ball is hit.

### Rules

- **Pools are undeclared.** A category's pools are whatever strings its matches
  use. Round robin is the degenerate case: one pool, no knockout matches.
- **Pairs are fixed per category** — the same ids always appear together, no
  player has two partners. Applies to `players` sides only; knockout slots carry
  no ids. `validate.js` enforces it (sets are unordered).
  Rotating-partner formats (americano) are a later addition, not a v1 rule break.
- **Nothing derived is stored**, including "done": a match is done iff it has a
  result. No `status` field. Standings, brackets, "now playing", and slot
  resolution are computed at view time. A corrected score reseeds the bracket at
  render — fixing a wrong score is an ordinary edit, not a special case.
- **Forfeit** = done without play (injury, no-show, disband):
  `"forfeit": 1` names the forfeiting side index (so side 0 wins), no `games`. A
  mid-match retirement is the same record — the played games are discarded,
  because a half-played match has no meaningful game or point differential.
  Counts one win / one loss, no game or point differential; every downstream
  derivation resolves as if played. A double no-show is not representable —
  delete the match instead of inventing a two-sided forfeit. A disbanded pair's
  played results stay on the board — voiding means deleting played matches from
  every derivation. `ponytail:` revisit if an event's rules require voiding.
- **Done** = one side wins `ceil((match.bestOf ?? bestOf[stage]) / 2)` games, or
  a forfeit. `games`
  is a prefix; `validate.js` rejects only an impossible one (a side over the
  target, or a game after one side reached it).
- **Standings** sort by wins, then game differential, then point differential.
  Deliberately no head-to-head tie-break: it needs cycle rules for 3-way ties,
  and dead ties route to a human anyway.
- **Byes** need no schema: no first-round match, point the second-round slot at
  the `pool` rank.
- **Dead ties** at a pool's cutoff keep the dependent slot descriptive ("1st in Pool A" —
  it stays unresolved, as does an unfinished pool), and `validate.js` warns so the admin
  can replace the source with explicit `players` — decider or toss. Never blocks the commit.
  `ponytail:` warn-only; block if a real event ships a bracket seeded off an
  unnoticed coin flip.
- **Times** are ISO-8601 with explicit offset, so they parse as absolute
  instants; frontends render in `timezone` via `Intl`.
- **IDs and slugs** match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, unique per
  scope (players and venues per tournament, matches per category). They become
  file paths and URL params.
- **Categories are independent** data-wise; a player can be in several.

## Read path

`app.js` fetches `tournament.json` (selected by `?t=`, defaulting to the last
entry of `tournaments.json` so a kiosk URL survives the next event), then one
`matches/<id>.json` per entry in its `categories` — there is no directory listing
over HTTP. **Fetches are same-origin relative paths** (`tournaments/<slug>/…`):
the pages and the data ship from the same Pages deploy, so there is no base URL,
no repo `const`, no CORS, and no per-IP fetch throttle — Pages static requests
are unmetered. `?_=Date.now()` cache-buster; one `POLL_MS = 30000` for every
page and every file — requests are free, so there is nothing to tune.

An all-venues kiosk refetches every category each poll. Jitter the interval so a
hall full of screens doesn't hit in lockstep; that is the only reason to touch
the timing.

Per-file fetches aren't atomic — a deploy landing mid-poll yields one mixed
snapshot, self-healing next poll. Renderers never throw on a bad snapshot: a
missing matches file (404) renders empty, an unresolvable slot renders a
descriptive label ("Winner of m9", "1st in Pool A") — never drop the row.
Time and venue render defensively per view: the bracket and player schedule
show "TBD" for a match with no `scheduled` or `venue`; standings pool tables
show the venue with an empty time cell; the kiosk is a timeline, so it shows
only matches that have both a venue and a time. Cycles are rejected by
`validate.js` before a push, so the renderer trusts the gate.

Every URL param (`?t= ?c= ?p= ?v=`) is checked against the id regex before
use — unchecked, `?t=../../` is a path traversal on the fetch URL. Reject →
render an error, fetch nothing.

- **`venue.html?v=…`** — fullscreen dark kiosk; no `?v=` shows all venues.
  Matches are grouped per venue, each group showing its "now" matches and the
  next two; venue filter pills work like the standings category pills
  (`?v=` toggles) and cover only venues with matches — a declared-but-unused
  court gets no pill. All-venues mode lays the venues out side by side, one
  column each. "Now" = any scheduled start already reached with no result
  yet — a match whose slot has fully elapsed stays on the board (a late match
  is still the match on court); only a result removes a match from it. Once the
  day's first match is due, a status line shows "On schedule", or "Behind
  schedule" naming every match whose full slot has elapsed without a result.
- **`player.html?p=…`** — matches by day: venue, time, partner, opponents.
  While the day runs late, an upcoming match on a backed-up venue shows its
  backlog: "~30 min late · est. 15:55" (lower bound — a forfeit can clear it
  sooner).
- **`standings.html?c=…`** — one table per pool plus the bracket view. The
  bracket is laid out by distance from the final: a match's column is its
  winner-edge path to the final (one column per round), placement matches sit
  one column after the round they branch from, bronze is just another member of
  its column. No layout engine, no round metadata in the data.

## Write path

```
node cli.js list                       # what can be scored right now
node cli.js score md m1 11-9 11-7      # set games — a prefix is a mid-match push
node cli.js forfeit md m7 1            # side 1 forfeits, side 0 wins
node cli.js -t 2026-spring …           # pick the tournament (default: last in tournaments.json)
git commit -am "m1 11-9 11-7" && git push   # hook runs validate.js + tests.js
```

`cli.js` is the match-day scorer's tool (zero deps, plain node): `list` shows
every match whose two sides both resolve to players — the same rule
`validate.js` enforces on scored matches — ready (no result) first. `score` and
`forfeit` edit the one category file and run the real `validateRepo` before
writing; a rejected edit rolls the file back, so the CLI never leaves data the
pre-commit hook would refuse. The write is `JSON.stringify(cjson, null, 2)`,
byte-identical to the existing files, so a commit diff shows only the edited
match.

A rejected push means someone pushed first: `git pull --rebase && git push`.
Git's conflict semantics are the concurrency design — no retry loop, no CAS, no
API client. Per-category files stripe writes across categories; two scorers on
one category still hand-merge. One scorer per category is the operating model.

`git config core.hooksPath .githooks` once; `.githooks/pre-commit` runs
`validate.js` then `tests.js` — so "validate and test before commit" is a
mechanism, not discipline.

`validate.js` is where the logic lives: `loadRepo` reads a repo root into
memory, `validateRepo` runs every check on it. Plain node, zero dependencies,
no `package.json`, no schema library — the checks are hand-rolled. It checks
the schema and cross-file references:

- `tournaments.json` slugs exist; ids match the regex and are unique per scope
  (players and venues per tournament, matches per category).
- Every `matches/*.json` file maps to a declared category — an unlisted file is
  never fetched (no directory listing), so a filename typo would silently render
  an empty category.
- `player.categories` and `match.venue` exist.
- `match` slots name a real match in the same category and a `result` of
  `winner`/`loser`; `pool` slots name a pool that category actually uses, with
  `rank` in range.
- No slot source is consumed twice — one match's winner, or pool A rank 1, feeds
  exactly one downstream side.
- Slot references are acyclic.
- No pool has fewer than two distinct sides (that's what an `"a"`/`"A"` typo
  produces).
- Exactly two sides per match; side ids are players of that category; sides are
  constant pairs of a size consistent across the category (a doubles side typed
  with one id is the singles/doubles typo); the two sides aren't the same player
  set.
- Both stages used have a `bestOf` key; every `bestOf`, including a match
  override, is an odd positive integer.
- `games` is a valid prefix and absent when `forfeit` is present; `forfeit`
  indexes a side. Game scores are non-negative integers with a strict winner —
  an odd `bestOf` rules out a drawn match, nothing else rules out a drawn game,
  and one would leave the match permanently unfinished.
- `games` or `forfeit` only on a match whose two sides both resolve to players —
  scoring a match still fed by an unfinished pool is the likeliest scorer typo,
  and it corrupts the bracket at render instead of at commit.
- `scheduled` parses as ISO-8601 with an explicit offset; without it the venue
  overlap check silently skips the match.
- No two unplayed scheduled matches share a venue at overlapping times — across
  categories too, so two categories can't double-book a court. A match's window
  is its effective slot length: per-match `slotMinutes` > per-stage category
  `slotMinutes` (`groups`/`knockout`) > the 45-minute default.

A category with no matches file is valid. Dead-tie pool slots warn.

Player clashes are not checked: behind a `match` or `pool` slot there is no
player id yet, so the check is blind past round 1 anyway.

`tests.js` is the harness, `fixtures/` is the data. Every scenario — the core
validator rules, each derive behavior, plus the dead-tie and cycle corner cases —
is a committed fixture under `fixtures/`: a self-contained mini repo
(`tournaments.json` + `tournaments/<slug>/…`) loaded with the same `loadRepo`
used on real checkouts, so the tests exercise the real I/O path. Tests only load
and assert — none generate or mutate data, and none depend on the live
`tournaments/` data. The hook and CI run `node tests.js` after `node validate.js`;
the deploy workflow strips `fixtures/`, `tests.js`, `schedule.js`, `.git`, and `.github` before uploading.

`ponytail:` no CLI in v1 — `score md40 m1 11-9 11-7` was planned as a wrapper
over one JSON edit; built as cli.js once hand-editing during a live match hurt.
No subcommands beyond list/score/forfeit — add `gitbracket` aliasing if the
wrapper pattern hurts.

## Security

- Write access = push access (SSH key or repo-scoped token in a credential
  helper, ideally expiring). Revoke = rotate. No credential enters the repo.
- Zero secrets in the bundle. Every repo-sourced string renders as text, never
  HTML.
- The repo is public by design — nothing in it that shouldn't be on a billboard.

## Deployment

GitHub Pages on `main`, publishing source **GitHub Actions** — not "deploy from a
branch". `.github/workflows/pages.yml` is the stock
`upload-pages-artifact` + `deploy-pages` pair with the repo root as the artifact.
Two settings carry the whole design:

- The 10 builds/hour Pages cap applies to the legacy branch build only — GitHub's
  docs exempt Actions-published sites. Public repo ⇒ Actions minutes are free, so
  a match day of score pushes has no ceiling.
- `concurrency: { group: pages, cancel-in-progress: true }` — a burst of scorer
  pushes collapses to the latest one instead of queueing behind each other.

A push is live in ~30–60s. Plain static files — host them anywhere if Pages stops
fitting; the fetches are relative, so nothing points at github.com.

`ponytail:` **verify before writing `app.js`** that the `?_=` cache-buster beats
the Pages CDN's `Cache-Control` at the edge, not just in the browser. If it
doesn't, freshness floors at the edge TTL (~600s) and the workaround is a
per-deploy version token in the URL. Target: live in ~1 min.

`ponytail:` Cloudflare Pages was considered and rejected: 500 builds/*month* and
one build at a time, account-wide — a single busy event eats the quota and
serialises the queue.

## User journeys

Two roles, and only one of them touches git.

| Persona | Tool | Needs |
|---|---|---|
| **Dana** (director) and **Sam** (scorer) | laptop, `$EDITOR`, git | push access, `node` |
| **Priya** (player) and the kiosk screen | phone, TV in the hall | a URL |

### 1. Dana sets up a tournament (T-3 weeks → T-1 day)

1. `mkdir tournaments/2026-spring` (or `cp -r` last year's), write
   `tournament.json`: `timezone`, `venues`, `categories` with `bestOf` (e.g.
   `groups: 3`, `knockout: 5`).
2. Registration comes in by whatever channel she already uses (mail, form,
   spreadsheet). She appends each entry to `players` with a slug id and its
   `categories`. Commits whenever, `git log` is the registration history.
3. Deadline hits. She writes `matches/md40.json`: pool matches first (`pool: "A"`),
   then the knockout, whose sides are *slots* — `{"kind":"pool","pool":"A","rank":1}`
   for the quarters, `{"kind":"match","match":"m9","result":"winner"}` upward.
   No player ids past the pools.
4. She assigns `venue` + `scheduled` by hand (or regenerates the mammut60 grid with
   `schedule.js`). `node validate.js` names the first venue double-booking; she fixes
   it and re-runs until clean. **This loop is the real work of v1** — there is no
   general scheduler.
5. Append `2026-spring` and its display name to `tournaments.json`, commit, push.
   Pages redeploys; the kiosk and player pages are live in about a minute. Next
   season's entry goes below it — this one keeps its directory and its URLs, and
   `index.html` moves it into the past list.
6. She hands out each player's link, `…/player.html?t=2026-spring&p=p1`,
   however she already contacts them.

### 2. Sam runs the tournament (match day)

1. Sam owns one category — that is the operating model.
2. Court 3 finishes a game 11-9. Sam appends `{"a":11,"b":9}` to that match's
   `games`, runs `git commit -am "m1 11-9" && git push`. The pre-commit hook
   runs `validate.js` and the test suite, so a typo can't reach the kiosk.
   Partial scores are legal — mid-match pushes show live on the kiosk. Second
   game 11-7 and the match is done, because it *has a result*; standings and
   every downstream slot recompute at the next render.
3. A pair no-shows or retires: `"forfeit": 1`, no `games`. Their remaining
   matches are forfeited in one commit. Already-played results stay.
4. Wrong score, or a rejected push? Ordinary edits and ordinary git — see the
   write path.

### 3. The kiosk shows the hall

A TV in the corner runs `venue.html?t=2026-spring&v=court-3` fullscreen — or
drops `&v=` for an all-venues board. It renders "now" plus the next two.
Nobody logs in, nobody operates it. Unplugged and replugged, it's a URL.

### 4. Priya plays

1. Opens her link, `player.html?t=2026-spring&p=p12`, on her phone and
   bookmarks it; no app, no login.
2. It lists her matches by day: time, court, partner, opponents. Later rounds
   show "TBD" until the pool that feeds them finishes.
3. She refreshes after her pool's last match; the page now names her
   quarter-final opponent and court, because the slot resolved the moment Sam
   pushed the result.
4. Two categories? Both appear in one list — she can see for herself that her
   singles quarter is 20 minutes after her doubles, and tell Dana. **The tool
   does not check player clashes.**

## Non-goals (v1)

Real-time push (polling suffices), accounts/roles/database/SaaS backend, a web admin UI, a generic rules engine (the slot enum is the model), native apps, media upload, streaming, multi-org management, a scheduler.

## Roadmap

- **v1**: data files + kiosk + schedule + standings + validate.js + fixtures/tests.
- **v1.5**: `.ics` export, PWA manifest, draws (points model — unlocks chess and
  football).
- **v2**: per-category durations, CI validation workflow, template-repo distribution,
  Swiss pairing, setup wizard — each only if the hand-run version hurts.
```
