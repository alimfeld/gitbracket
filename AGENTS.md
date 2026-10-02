# AGENTS.md

Rules for changing GitBracket. Each fact has one home:

- **README.md** — the model and the tools: data format, outcomes, views, specs, CLI.
- **ARCHITECTURE.md** — module boundaries and where new code goes.
- **TESTING.md** — running a match day (sim and real).
- **fixtures/** and **test/** — behavior is pinned by tests; when docs and code
  disagree, code wins.

## Principles

Breaking a principle breaks the system — now, or the first time an upstream
fact changes: a wrong render, a bypassable gate, lost data. Code and tests
implement them; treat them as rules, not style.

### Data

- **Never store what can be derived.** Keep only the raw facts a scorer
  records — games, scores, winner; standings, ranks, and done flags are
  recomputed at render, so a corrected fact can never leave a stale aggregate.
  Two exceptions: schedules, which can't be derived, and the index's
  `name`/`location`/`dates`, a deliberate copy so the list page is one fetch —
  the validator keeps it equal to the tournament file.
- **Times are wall-clock, never offsets.** `scheduled` is local wall time in
  the tournament's `timezone`; the instant is derived at render, so data stays
  readable and stays right if clock rules change.
- **A result is side-relative.** `winner` names a side (`a`/`b`), never a team;
  the team is derived from the side, so correcting a side reinterprets the
  result — including an already-decided match fed by that side, which keeps its
  side-letter result and follows the new team. Re-score it if the new meaning
  is wrong; nothing stores the attribution.
- **Slots are category-local, consumed at most once, acyclic.**
- **One file per tournament, minimal diffs.** Data edits stay byte-identical
  apart from the change, so a commit diff shows only the edit.

### Code

- **derive.js is the single source of the domain model.** Validator, editor,
  generator, and renderers all consume it — extend it, never reimplement it.
  Every export must be reachable from a shipped render path; node-tool-only
  helpers belong in `src/tools.js` or the tool that owns them. Internal laws:
  side identity derives from the player set, never from list order; memoized
  state resets every render, so a corrected score surfaces on the next poll;
  resolution is cycle-proof — a cycle is a reported conflict, not a barrier, so
  the guard keeps a render from hanging.
- **Facts and words do not mix.** `derive.js` depends on nothing and runs in
  the browser and under node — no node-only module, no markup, no `t`/`esc`, no
  `LOCALE`. Words and markup live in `views.js`, browser-only. Boundaries and
  the tests that pin them: ARCHITECTURE.md.
- **Renderers never throw, and neither does the gate.** Missing data renders
  empty, unresolvable slots a descriptive label, malformed data an error
  report — never a crash. Cycles and reference errors are the validator's job.
  Data from the repo renders as text, never HTML.
- **Markup is semantic, styling is minimal.** Shipped HTML uses real elements
  — headings, sections, articles, tables, `details`, navs, links — with one
  small stylesheet, no framework, no presentational classes from JS. State
  rides `data-*` / `aria-current`; body classes layer per-page layout (e.g.
  `venue` on the kiosk); layout is flex/grid + `em`, so browser zoom scales
  the kiosk — no layout/width breakpoints (`@media (hover:hover)` and the static
  print sheet's `@media print` are capability queries, allowed). A board too
  wide for the viewport pans horizontally rather than squeezing its columns. New markup reuses existing
  elements and rules; a new class is a change to be justified.

### Process & Deploy

- **Git is the record, not the transport.** No server, no accounts — the repo
  is data, history, and frontend. Only publish ships `site/`; the deploy follows
  the branch, never the operator's intent, and refuses without an anchor (the
  gate: TESTING.md). Publishing sits outside git: last write wins on the CDN,
  safe because one director ships, everyone else pulls and reviews. Sim branches
  (`gb.js sim`) practice the whole pipeline and are never merged; `--teardown` is
  the only exit. The venue board is public — off match day its clock shows the
  date, a plain readout; the status dot every polling view carries is the only
  freshness signal, so never let a frozen page read as live.
- **Every editor edit commits itself; only the ship is gated.** An edit
  passes the syntactic check — unparseable or unreferenceable data blocks it
  — then writes and commits. Semantic conflicts (data that parses but
  contradicts the model: a double-booked court, a consumed-twice slot, a
  second final) ride along, surface in the admin, and block `publish` until
  resolved. A conflicting state is a repairable step, never a dead end, and
  the process can die at any instant with nothing lost.
- **Never weaken a check to make data pass — fix the data.** The pre-commit
  gate is local and fast; `gb.js publish` re-runs the validator and refuses on
  syntactic errors and conflicts alike, so a bypassed hook can't ship bad data
  (setup: README → Development).

## Conventions

Violating a convention costs friction, not correctness — these are working
agreements; if one doesn't fit, raise it instead of breaking it silently.

- **Comments state why, never what.** Shipping-surface comments cost transfer
  bytes on every page load, so keep rationale out of `site/` unless it warns
  against a real trap.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling
  and the upgrade path.
- **A behavior change is a fixture + a test.** New validator rules and derive
  behavior need a committed scenario under `fixtures/` and an assertion in
  `test/`, both loaded via the same `loadRepo` as real checkouts. Tests
  assert domain behavior — ladder order, slot resolution, validation
  outcomes, escaping, no-throw. Renderer tests are smoke checks only: shipped
  state survives — an a11y state, a status flag, a data-jump target, an
  escape, a no-throw — never the words, columns, tags, or layout carrying it;
  copy and layout are review changes, not test changes. Derive helpers that
  only feed the renderer (labels, status words, layout columns, scroll
  anchors) get smoke coverage or none. Neither layer mutates committed data
  or depends on live `site/tournaments/`.
- **Concurrent edits are rebase conflicts, not lost writes.** A rejected push
  means someone pushed first: `git pull --rebase && git push`.
- **One scorer owns one tournament.**
- **No commits without an ask** — never stage, commit, push, or publish
  unless the user explicitly instructed it; leave the change uncommitted and
  report it as such.
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `perf:`, `ci:`,
  with a scope when it helps, as the existing history does.
- **No package.json, no npm scripts** — scripts run with `node` directly,
  tests with `node --test` from the repo root, as the pre-commit hook runs
  them.
