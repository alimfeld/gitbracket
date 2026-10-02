# Testing and simulating a tournament day

Two ways to run a match day:

- **Sim** — practice the whole pipeline (commits, pushes, deploy) on a throwaway
  branch that can never reach production.
- **Real day** — score on `main`, publish to the production domain.

## Sim: practice the real pipeline

`node gb.js sim` does the setup in one command: it creates a `sim/<rand>` branch
off a clean `main`, commits a scratch surge domain (`bracket-sim-<rand>.surge.sh`)
as `site/CNAME`, pushes the branch (so the admin can publish it onward), and
prints the next steps.

```bash
node gb.js sim
# → sim/k3f2x — start the daemon: node gb.js admin
# → after publishing, open the scratch site and watch the board
```

- **Score the day in the admin** — drag to reschedule, click to score, through
  the same validate-write-commit funnel as every other edit, so the deployed
  kiosk progresses like a real day.
- **Sim the kiosk clock** — the board reads the machine clock, so rehearse a
  day by faking it in the browser driving the kiosk (e.g. the "Fake Date"
  extension). The clock is a view only — it never changes what's scoreable.
- **Iterate** — edit in admin, hit Publish (validate + push + deploy to the
  scratch domain), watch the kiosk. Every edit validates and commits itself,
  so nothing is lost mid-process.

A sim branch is practice, never merged: its scores are fabricated, and its
scratch CNAME must never reach production history. When the sim is done:

```bash
node gb.js sim --teardown   # takes the scratch domain down, deletes the branch (local + origin)
```

The surge domain stays hosted until torn down — teardown is the only exit, and
it only runs on a sim branch whose CNAME isn't production. Then the real day
happens on `main`.

## Real day: admin on main

`node gb.js` (or `node gb.js admin`) starts the admin daemon: score,
reschedule, undo/redo, publish. The daemon reads `site/` at startup, so restart
it after edits made in another terminal.

## Printing the match cards

Match day runs on paper too: each match gets a card the players fill in, and the
operator types its scores into the admin. `print/match-card.html` is a static
sheet — six blank cards to an A4 page, cut along the dashed rules.

Open it in a browser and Print: set **copies to one per match** (a full day of
70 matches is 12 copies). Every field is pen — court, time, side names, game
scores; a group match uses Game 1 only, a final uses up to Game 3. `Save as PDF`
gives a print shop the same sheet. The sheet fills the page's printable area (up
to 180mm wide), so it stays one page without an `@page` margin.

The deploy gate (shared by the admin Publish button and `node gb.js publish`):

- **on `main`** — ships only if `site/CNAME` is the production domain (the one
  `origin/main` carries). A scratch CNAME on main refuses loudly; with no
  `origin/main` nothing can prove what production is, so every deploy refuses
  until main is pushed once.
- **off `main`** — ships only a CNAME that differs from production, and only
  when `origin/main` exists to prove the difference. A sim branch ships its
  scratch domain; a branch still carrying production's CNAME refuses.
- **`site/` must be clean** — the daemon commits every edit, so uncommitted
  changes mean an out-of-band hand edit.

## Prerequisites

- **Always:** Git and Node.js.
- **To publish (sim or real day):** the [surge CLI](https://surge.sh) — install
  once with `npm install -g surge` and `surge login`.
- **Once:** push `main` so `origin/main` carries the production `site/CNAME` —
  without it every deploy refuses, because nothing can prove what production is.
