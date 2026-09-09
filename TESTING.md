# Testing and rehearsing a tournament day

## The rehearsal: the real pipeline, practiced end to end

`node gb.js sim [slug]` is the one rehearsal command. It creates a
`rehearsal/<slug>-<rand>` branch off a clean `main`, commits a generated
scratch surge domain as `site/CNAME`, pushes the branch (so admin's publish
can push it onward), starts the admin daemon, and prints the scratch URL.

```bash
node gb.js sim 2026-mammut60
# → rehearsal/2026-mammut60-k3f2x, scratch domain rehearsal-2026-mammut60-k3f2x.surge.sh
# → admin at http://127.0.0.1:<port>/ — Publish ships the scratch domain
# → kiosk: after publishing, open https://rehearsal-<…>.surge.sh/?sim#2026-mammut60/venues
```

Every part of the day is practiced on the branch — the staging, the commits,
the pushes, the surge deploy — against a site that can never reach the
production domain (the publish gate proves it: production is `origin/main`'s
CNAME, a branch may only ship a CNAME that differs from it).

- **Score the day with the admin UI** — drag to reschedule, click to score,
  undo/redo, pending list. On a rehearsal branch a **Score wave** button (or
  the `x` key) scores the whole playable wave with random games through the
  same validate-write-commit funnel, so the kiosk's statuses and board
  progress the way a real day does.
- **Rehearse the kiosk clock** — open the scratch site with `?sim`: the kiosk
  runs on a rehearsal clock an operator controls — the `◀`/`▶` panel (and
  `]`/`[`) step it ±30 minutes, reset returns to real time, and the first
  load aims at the event's first scheduled match, so the kiosk opens on the
  event. Statuses, auto-centering, and the board clock all track the
  rehearsal; the clock never changes what's scoreable.
- **Iterate** — edit in admin, hit Publish (validate + push + surge to the
  scratch domain), watch the deployed kiosk. Every edit validates and
  commits itself; nothing is ever lost mid-process.

A rehearsal branch is practice, never merged — its scores are fabricated, and
its scratch CNAME must not ride into production history. When the rehearsal
is done:

```bash
node gb.js sim --teardown   # surges the scratch domain down, deletes branch (local + origin)
```

The surge domain stays hosted until torn down — teardown is the only exit,
and it refuses to touch a non-scratch CNAME. Then the real day happens on
`main`, where the clock is real and the scores are real.

## The real day: admin on main

`node gb.js` (or `node gb.js admin`) starts the admin daemon — the single
match-day interface. Drag reschedule, click-to-score/wo/void, side-entry
picker, pending-changes panel (unpushed commits), undo, redo, and a publish
button (validate + push + deploy). The daemon reads `site/` when it starts,
so restart it after edits made in another terminal.

The deploy gate (shared by the admin publish button and `node gb.js publish`):

- **on `main`**: ships the domain in `site/CNAME`, which must be the
  production domain (the one `origin/main` carries) — a scratch CNAME on main
  refuses loudly.
- **off `main`**: ships only if `site/CNAME` differs from production (a branch
  carrying the production CNAME refuses), and only when `origin/main` exists
  to prove that difference. Rehearsal branches ship their scratch domain;
  nothing else can.
- `site/` must be clean (no uncommitted changes) — the daemon commits every
  edit, so a dirty tree is a hand-edit history would never see.

## Prerequisites

- **Rehearsal:** Git, Node.js, the [surge CLI](https://surge.sh)
  (one-time `npm install -g surge` + `surge login`), and an `origin` whose
  `main` carries the production `site/CNAME` (push main once).
- **Real day:** Git and Node.js — surge only when you publish.