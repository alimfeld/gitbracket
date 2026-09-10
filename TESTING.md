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
# → after publishing, open the scratch site and press the LIVE chip on a venue board
```

- **Score the day in the admin** — drag to reschedule, click to score. The
  **Score wave** button (or the `x` key) scores the whole playable wave with
  random games, through the same validate-write-commit funnel as every other
  edit, so the deployed kiosk progresses like a real day.
- **Sim the kiosk clock** — on a venue board, the bare `LIVE` chip in the
  lower-right corner (it appears only there) toggles the sim clock: `◀`/`▶`
  (or `]`/`[`) step it ±30 minutes, switching it on aims it at the event's
  first scheduled match, and `✕` puts it back on real time. The clock is a
  view only — it never changes what's scoreable.
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

`node gb.js` (or `node gb.js admin`) starts the admin daemon — the one
match-day interface: drag to reschedule, click to score/wo/void, side picker,
pending list (unpushed commits), undo/redo, and publish. The daemon reads
`site/` at startup, so restart it after edits made in another terminal.

The deploy gate (shared by the admin Publish button and `node gb.js publish`):

- **on `main`** — ships only if `site/CNAME` is the production domain (the one
  `origin/main` carries). A scratch CNAME on main refuses loudly; with no
  `origin/main` nothing can prove what production is, so every deploy refuses
  until main is pushed once.
- **off `main`** — ships only a CNAME that differs from production, and only
  when `origin/main` exists to prove the difference. Sim branches ship their
  scratch domain; nothing else can.
- **`site/` must be clean** — the daemon commits every edit, so uncommitted
  changes mean an out-of-band hand edit.

## Prerequisites

- **Always:** Git and Node.js.
- **To publish (sim or real day):** the [surge CLI](https://surge.sh) — install
  once with `npm install -g surge` and `surge login`.
- **Once:** push `main` so `origin/main` carries the production `site/CNAME` —
  without it every deploy refuses, because nothing can prove what production is.