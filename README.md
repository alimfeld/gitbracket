# GitBracket

GitBracket runs tournaments as code. A tournament lives in a git repo — the
data, the history, and the frontend are the whole system. No accounts, no
server, no app: a publish deploys, and anyone with the link can follow along.

Works for any win/lose tournament — pickleball, tennis, darts, quiz. Draws
are not supported.

## Model

One file per tournament. `tournaments.json` is the index; each entry's slug
names a file in `site/tournaments/`:

```json
[
  { "slug": "2026-mammut60", "name": "Mammut Open 60+" }
]
```

The tournament file holds everything: venues, categories, players, and all
matches keyed by category:

```jsonc
{
  "name": "Mammut Open 60+",
  "timezone": "America/New_York",
  "venues": [{ "id": "court-3", "name": "Court 3" }],
  "categories": [{ "id": "md40", "name": "Men's Doubles 40+",
    "bestOf": { "groups": 3, "knockout": 5 } }],
  "players": [{ "id": "p1", "name": "Ada Lovelace" }],
  "matches": { "md40": [ /* below */ ] }
}
```

A match has two stages: `groups` (has a `pool`) and `knockout` (no pool).
`bestOf` sets match length per stage; a match can override it with a plain
number. A side is one of three kinds:

```jsonc
// players — the actual people; singles: one id, doubles: two.
// scheduled is local wall time in the tournament's `timezone` — no offset in
// the string, the IANA zone at the top of the file interprets it.
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

Pool rankings use the standard round-robin ladder: wins, then head-to-head
against the tied teams (mutual-match wins, game differential, point
differential), then overall game and point differential. A group still tied
after the whole ladder is a dead tie — its bracket slot stays TBD for the
organizer to settle.

## Views

One page, fragment-routed. `#<slug>` is a tournament's standings;
`/categories`, `/venues`, `/players` switch the view, and an id narrows it:

- `#` — lists tournaments, past and current.
- `#<slug>` — standings, all categories (`#<slug>/categories/<category-id>` narrows to one).
- `#<slug>/venues` — the kiosk, the fullscreen board for the hall showing the day live on every court (`#<slug>/venues/<venue-id>` narrows to one court).
- `#<slug>/players` — the player picker (`#<slug>/players/<player-id>` shows one player's schedule).

## Tools

**`gb.js`** — the one CLI. `node gb.js` starts the match-day REPL (`help` inside for commands — every edit validates and commits itself); `node gb.js validate [slug]` checks data without the REPL; `node gb.js schedule <spec>` generates a tournament file from a spec (`specs/<slug>.json`); `node gb.js publish` ships `site/` to the domain in `site/CNAME`. The commands live as modules under `src/`; `site/` stays the shipping surface.
