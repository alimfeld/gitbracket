# AGENTS.md

README describes the model and the tools; tests pin behavior; comments carry
only what is not apparent. Shipping-surface comments cost transfer bytes on
every page load, so keep rationale out of `site/` unless it warns against a
real trap — `ponytail:` markers stay (they are the shortcut ledger). When
docs and code disagree, code wins.

## Architectural principles

- **Git is the record, not the transport.** No server, no accounts — the repo
  is data, history, and frontend. Only `gb.js publish` ships, and only from
  `main`, uploading `site/` to the domain in `site/CNAME`; one director
  publishes, everyone else pulls and reviews. Publishing is outside git
  (last-write-wins on the CDN) — safe because one director ships.
- **A corrected score reseeds the bracket at render.** Nothing about results is
  stored; a match is done when it has a result. Schedules are the exception —
  generated from a spec and stored, never hand-edited; regenerate before
  results go in.
- **derive.js is the single source of the site's domain model.** Validator,
  REPL, generator, and renderers all consume it — extend it, never reimplement
  the model elsewhere. The integrity gate must not depend on renderer code.
  derive.js is dual-loaded (browser global script + CommonJS), so it stays
  free of node-only modules.
- **Slots are category-local, consumed at most once, acyclic.**
- **Every REPL edit validates, writes, and commits itself** — the process can
  die at any instant with nothing lost. One scorer owns one tournament.
- **One file per tournament, minimal diffs.** Atomic reads, cross-category
  edits in one place; data edits stay byte-identical apart from the change, so
  a commit diff shows only the edit.
- **Concurrent edits are rebase conflicts, not lost writes.** A rejected push
  means someone pushed first: `git pull --rebase && git push`. No retry loops,
  no CAS.
- **Never weaken a check to make data pass — fix the data.** Pre-commit runs
  validate + tests (the dev gate); `gb.js publish` re-runs validate (the data
  gate) — so a bypassed hook can't ship.
- **Renderers never throw, and neither does the gate.** Missing data renders
  empty, unresolvable slots render a descriptive label, malformed data reports
  an error — never a crash. Cycles and reference errors are the validator's
  job. Repo-sourced strings render as text, never HTML.
- **A behavior change is a fixture + a test.** New validator rules and derive
  behavior need a committed scenario under `fixtures/` (a self-contained mini
  site root) and an assertion in `test/`, loaded through the same `loadRepo` as
  real checkouts. Tests assert domain behavior — ladder order, slot
  resolution, validation outcomes, escaping, no-throw — not markup shape;
  renderer decisions (class names, DOM structure, meta layout) may change
  without touching tests. Tests load and assert only: never mutate data, never
  depend on live `site/tournaments/`.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling
  and the upgrade path.

## Where code lives

One question decides placement for any new function: does the browser run it?

- **Yes → `site/`** (the shipping surface). Shared computations go in
  `derive.js` — the gate and the renderer
  must not drift apart. Pure fetch/render/boot goes in `app.js`; markup and
  styling in `index.html` / `style.css`.
- **No → `src/`** (the tool layer, never ships). Keep it in the tool that
  uses it (`validate.js`, `schedule.js`, `repl.js`); put it in `src/tools.js`
  when two or more tools share it — repo I/O and tool-only predicates already
  live there. Root files (`gb.js`, `.githooks/`) dispatch and gate only; logic
  lives in `src/`.
- **Specs → `specs/`**, one file per tournament, consumed only by `schedule.js`;
  regenerate before results go in.

## Conventions

- **No commits without an ask** — never stage, commit, push, or publish
  unless the user explicitly instructed it; leave the change uncommitted and
  report it as such.
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `perf:`, `ci:`,
  with a scope when it helps, as the existing history does.
- **No package.json, no npm** — scripts run with `node` directly; tests run
  with `node --test` (node:test), in the repo root, exactly as the pre-commit
  hook runs them.
