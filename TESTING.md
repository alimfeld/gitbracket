# Testing and simulating a tournament day

## The sim: the real pipeline, practiced end to end

`node gb.js sim` is the one sim command. It creates a `sim/<rand>` branch off a
clean `main`, commits a generated scratch surge domain as `site/CNAME`, pushes
the branch (so admin's publish can push it onward), and prints the next steps.
Starting the daemon is yours.

```bash
node gb.js sim
# → sim/k3f2x, scratch domain bracket-sim-k3f2x.surge.sh
# → start the daemon: node gb.js admin
# → kiosk: after publishing, open https://bracket-sim-<…>.surge.sh/ and press sim in the corner
```

Everything is practiced on the branch — the commits, the pushes, the surge
deploy — against a site that can never reach production (the deploy gate
below). A sim is site-wide: the branch carries every tournament, and the
admin's tournament picker chooses which one you work on.

- **Score the day with the admin UI** — drag to reschedule, click to score,
  undo/redo, pending list. On a sim branch a **Score wave** button (or the `x`
  key) scores the whole playable wave with random games through the same
  validate-write-commit funnel, so the deployed kiosk progresses like a real
  day.
- **Sim the kiosk clock** — open a venue board on the scratch site and press
  the `LIVE` chip in the lower-right corner (it appears only there, and reads
  `LIVE` until pressed): the board runs on a sim clock an operator controls — the `◀`/`▶` controls (and `]`/`[`)
  step it ±30 minutes, turning it on aims at the event's first scheduled match,
  and turning it off returns the board to real time. Statuses, auto-centering,
  and the board clock all track the sim; the clock never changes what's
  scoreable.
- **Iterate** — edit in admin, hit Publish (validate + push + surge to the
  scratch domain), watch the deployed kiosk — every edit validates and
  commits itself, so nothing is lost mid-process.

A sim branch is practice, never merged — its scores are fabricated, and its
scratch CNAME must not ride into production history. When the sim is done:

```bash
node gb.js sim --teardown   # surges the scratch domain down, deletes branch (local + origin)
```

The surge domain stays hosted until torn down — teardown is the only exit,
and it refuses to touch a non-scratch CNAME. Then the real day happens on
`main`, where the clock is real and the scores are real.

## The real day: admin on main

`node gb.js` (or `node gb.js admin`) starts the admin daemon — the one
match-day interface: drag reschedule, click to score/wo/void, side picker,
pending list (unpushed commits), undo/redo, and publish (validate + push +
deploy). The daemon reads `site/` when it starts, so restart it after edits
made in another terminal.

The deploy gate (shared by the admin publish button and `node gb.js publish`):

- **on `main`**: ships the domain in `site/CNAME`, which must be the
  production domain (the one `origin/main` carries) — a scratch CNAME on main
  refuses loudly.
- **off `main`**: ships only if `site/CNAME` differs from production (a branch
  carrying the production CNAME refuses), and only when `origin/main` exists
  to prove that difference. Sim branches ship their scratch domain;
  nothing else can.
- `site/` must be clean (no uncommitted changes) — the daemon commits every
  edit, so a dirty tree is a hand-edit history would never see.

## Prerequisites

- **Sim:** Git, Node.js, the [surge CLI](https://surge.sh)
  (one-time `npm install -g surge` + `surge login`), and an `origin` whose
  `main` carries the production `site/CNAME` (push main once).
- **Real day:** Git and Node.js — surge only when you publish.