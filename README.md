# GitBracket

GitBracket runs tournaments as code. A tournament lives in a git repo — the
data, the history, and the frontend are the whole system. No accounts, no
server, no app: a publish deploys, and anyone with the link can follow along.

Works for any win/lose tournament — pickleball, tennis, darts, quiz. Draws
are not supported.

## Glossary

- **Tournament** — a whole event, from its first group match to its final.
- **Category** — one competition within a tournament (e.g. Men's Doubles
  40+), with its own pools and knockout.
- **Player** — a person taking part.
- **Team** — one player (singles) or two (doubles) competing together in a
  category.
- **Venue** — a court, the physical place a match happens.
- **Pool** — a round-robin group; every team plays every other. Rankings
  decide who advances.
- **Group stage** — the first phase: every team plays the others in its pool.
- **Knockout stage** — the second phase: single-elimination matches; lose and
  you're out. Teams enter as pool ranks or as the winner/loser of an earlier
  match.
- **Round** — one step of the knockout: Final, Semifinals, Quarterfinals,
  Round of 16, and so on.
- **Bracket** — the knockout tree: matches arranged in rounds, from the first
  round to the Final.
- **Seed** — a team's bracket position from its pool ranking; top seeds are
  kept apart so the strongest teams meet as late as possible.
- **Placement match** — a knockout match that settles a lower rank (3rd, 5th,
  …) rather than the title; the bronze match is 3rd place.
- **Match** — one meeting of two sides, the smallest unit of play.
- **Side** — one of the two opponents in a match: players, a previous match's
  winner/loser, or a pool rank.
- **Game** — a single race within a match; games are the evidence a result is
  judged by.

## Tournament files

One file per tournament. `tournaments.json` is the index; each entry's slug
names a file in `site/tournaments/`:

```json
[
  { "slug": "2026-alpineopen", "name": "Alpine Open 60+",
    "location": "Bärenhalle, Grindelwald", "dates": ["2026-10-03"] }
]
```

- `location` — shown on the list page and the tournament heading (instead of
  the timezone). Required, and must match the file's like `name`.
- `dates` — the list page's day list (ascending ISO dates). Once the
  tournament is scheduled it must match the schedule, like `name`.

The tournament file holds everything — venues, categories, players, and all
matches keyed by category:

```jsonc
{
  "name": "Alpine Open 60+",
  "location": "Bärenhalle, Grindelwald",
  "timezone": "Europe/Zurich",
  "venues": [{ "id": "court-3", "name": "Court 3" }],
  "categories": [{ "id": "md40", "name": "Men's Doubles 40+",
    "bestOf": { "groups": 3, "knockout": 5 },
    "slotMinutes": { "groups": 30, "knockout": 45 } }],
  "players": [{ "id": "p1", "name": "Ada Lovelace" }],
  "matches": { "md40": [ /* below */ ] }
}
```

- Matches have two stages: `groups` (has a `pool`) and `knockout` (no pool).
- `bestOf` sets match length per stage, `slotMinutes` the court slot per
  stage; a match can override either with a plain number.
- `scheduled` is local wall time in the tournament's `timezone` — never a UTC
  instant or offset; the IANA zone at the top of the file interprets it.

A side is one of three kinds:

```jsonc
// players — the actual people; singles: one id, doubles: two
{ "id": 1, "pool": "A", "venue": "court-3", "scheduled": "2025-07-14T09:00:00",
  "sides": [
    { "kind": "players", "ids": ["p1", "p3"] },
    { "kind": "players", "ids": ["p2", "p4"] }
  ],
  "games": [{ "a": 11, "b": 9 }, { "a": 11, "b": 7 }],
  "result": { "status": "played", "winner": "a" } }

// match — the winner (or loser) of an earlier match
{ "id": 9, "sides": [
  { "kind": "players", "ids": ["p1", "p3"] },
  { "kind": "match",  "match": 1, "result": "winner" }
] }

// pool — the Nth-ranked team of a pool
{ "id": 12, "sides": [
  { "kind": "pool",  "pool": "A", "rank": 1 },
  { "kind": "match", "match": 9, "result": "loser" }
] }
```

**Outcomes.** Games are the evidence; `result` is the outcome — a match is
done when it has one, in play without one. `winner` is a side letter (`a` or
`b`), the same letters game scores use.

| result | winner | standings impact | notes |
|---|---|---|---|
| `played` | a\|b | win + gd/pd from games | games must reach the best-of target and agree with the winner |
| `walkover` | a\|b | win only, no gd/pd | a side can't play — no games |
| `void` | — | nothing counts | neither side can play — pools still complete |

Nothing else stored can be derived — standings and brackets follow from the
data.

**Pool rankings** use the standard round-robin ladder: wins, then
head-to-head against the tied teams (mutual-match wins, game differential,
point differential), then overall game and point differential. A group still
tied after the whole ladder is a dead tie — its bracket slot stays TBD for
the organizer to settle.

## Views

One page, fragment-routed: `#<slug>[/schedule|venues][?cat=&player=&venue=]`.
The player pick is URL state, never device state — links carry only the
params legal on their target: `cat` and `player` ride between tournament and
schedule so switching views keeps the focus; `venue` lives on the kiosk
alone.

- `#` — the index, listing past and current tournaments; the only page with
  kiosk links.
- `#<slug>` / `#<slug>?cat=<category-id>` — the tournament, one category at a
  time (the first by default); date span and location in the heading, the
  category's span and status under its title. A floating
  `Tournament | Schedule` switch sits above the two views.
- `#<slug>/schedule?player=<player-id>` — a player's Schedule. Without a
  valid `player` (or via "Change") it shows a picker of participating
  players. The URL is the only memory of a pick — share or bookmark it.
- `#<slug>/venues?venue=<venue-id>` — the kiosk, the fullscreen board for the
  hall: the whole day on every court, auto-centered on the current slot (done
  matches stay, muted; overdue red, now green); `venue` narrows to one court.

## Specs

`node gb.js schedule specs/<slug>.json` generates a tournament file from a
spec — the single source of the schedule:

```jsonc
{ "slug": "2026-alpineopen", "name": "Alpine Open 60+",
  "location": "Bärenhalle, Grindelwald",
  "timezone": "Europe/Zurich", "date": "2026-10-03", "poolSize": 5,
  "blocks": { "md": "09:00", "xd": "13:00" },
  "venues": { "court-1": "Court 1" },
  "players": { "ada": "Ada", "ben": "Ben" },
  "categories": [
    { "id": "md", "name": "Men's Doubles", "bestOf": 1, "slotMinutes": 30,
      "knockout": true, "placements": 2, "courts": ["court-1"],
      "final": { "bestOf": 3, "slotMinutes": 60 } }
  ],
  "teams": { "md": [["ada", "ben"]] } }
```

- `date` is the tournament day, `blocks` the first match of each category;
  `poolSize` splits the category's `teams` into round-robin pools. Pools play
  each round in the same time window, so every team carries the same
  back-to-back burden — a packed schedule, no idle slots.
- Each `teams.<cat>` list is **seed / strength order** (best first): the
  generator snakes the list across pools so every pool gets a spread of seeds
  and the top seeds land one per pool, in order — balanced pools whose
  winners still feed the knockout as top seeds.
- `bestOf`/`slotMinutes` are plain numbers applied to both stages;
  `knockout: false` skips the knockout stage; `placements` (a power of 2)
  sizes the classification bracket; `final` overrides the final and bronze
  matches.
- `courts` (optional) lists preferred venue ids per category, in order of
  preference: a match takes the first free preferred court, then any free
  court. It keeps a category clustered for spectators but is soft — spill is
  always legal, so the schedule's order is unchanged by it.
- Knockout draws use the standard S-curve bracket: round 1 pairs best vs
  worst and splits the top seeds across halves, so two pool winners only
  meet late (2 pools: the final; k pools: no earlier than the semis).
- Regeneration rewrites the whole matches map, scores included — run it
  before results go in, never after.
- Match ids follow chronological order (per-category, sequential by
  `scheduled`; build order breaks simultaneous ties). A category's match 5
  is a different match from any other category's match 5.

## Tools

**`gb.js`** is the one CLI.

- `node gb.js` (or `node gb.js admin [slug]`) — the admin daemon, the single
  match-day interface: a calendar grid (venues across, wall-clock minutes
  down, matches as slot-sized blocks), drag-to-reschedule (drops snap to the
  gate's own legal starts), click-to-score/wo/void, a side picker, a
  pending-changes panel (unpushed commits), undo/redo, and a publish button.
  Every edit goes through the one edit engine — validate, write,
  byte-identical diff, commit — so the browser can never outrun the gate.
- `node gb.js validate [slug]` — checks data.
- `node gb.js schedule <specs/xxx.json>` — generates a tournament file (see
  Specs).
- `node gb.js publish` — ships `site/`: from `main` to the production domain
  (proved equal to `origin/main`'s CNAME), from a branch only to its own
  scratch domain.
- `node gb.js sim` — practices the whole pipeline on a `sim/<rand>` branch
  with a scratch surge domain and a kiosk sim clock; `--teardown` undoes it.
  Sim branches are practice, never merged.

Commands live as modules under `src/`; `site/` stays the shipping surface.

## Development

The pre-commit hook (validator + tests) is the dev gate. A fresh clone needs
it wired once:

```bash
git config core.hooksPath .githooks
```

Publish re-runs the validator from disk, so a bypassed hook can't ship bad
data — the hook is the fast local gate, not the last one.