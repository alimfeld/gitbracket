# AGENTS.md

The README describes the model and the tools; the code comments carry the
details. When docs and code disagree, code wins.

## Architectural principles

- **Write is edit, ship is publish.** No server, no accounts — git is the
  record, not the transport: only `gb.js publish` ships, uploading `site/` to
  the domain in `site/CNAME`. One director publishes; git stays the audit
  trail and the rollback.
- **derive.js is the single source of the site's domain model.** Validator, REPL,
  generator, and renderers all consume it — extend it, never reimplement the
  model elsewhere. The integrity gate must not depend on renderer code.
  Tool-only logic lives in `src/`, never in the shipping surface.
- **A corrected score reseeds the bracket at render.** Nothing about results is
  stored; a match is done when it has a result. Schedules are the exception —
  generated from a spec and stored, so regenerate before results go in.
- **Slots are category-local, consumed at most once, acyclic.**
- **One file per tournament** — atomic reads, cross-category edits in one
  place.
- **Dev tooling stays at the root and never ships.** `site/` is the shipping
  surface.
- **Never weaken a check to make data pass — fix the data.** Pre-commit runs
  validate + tests; `gb.js publish` (the only shipper) re-runs validate as
  its first step — tests are the dev gate, validate is the data gate, and
  only the director ships — so a bypassed hook can't ship.
- **A behavior change is a fixture + a test.** New validator rules and derive
  behavior need a committed scenario under `fixtures/` (a self-contained mini
  site root) and an assertion in `test/`, loaded through the same `loadRepo` as
  real checkouts. Tests load and assert only — never mutate data, never
  depend on live `site/tournaments/`.
- **Git is the concurrency design.** A rejected push means someone pushed
  first: `git pull --rebase && git push`. No retry loops, no CAS. One scorer
  owns one tournament. Publishing is outside git — last-write-wins on the
  CDN, safe because one director ships.
- **Renderers never throw** — missing data renders empty, unresolvable slots
  render a descriptive label. Cycles and reference errors are the validator's
  job.
- **Repo-sourced strings render as text, never HTML.**
- **Minimal diffs.** Data edits stay byte-identical apart from the change, so
  a commit diff shows only the edit.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling
  and the upgrade path.

## Where code lives

One question decides placement for any new function: does the browser run it?

- **Yes → `site/`** (the shipping surface). Shared computations go in
  `derive.js` — the gate and the renderer must not drift apart. Pure
  fetch/render/boot goes in `app.js`; markup and styling in `index.html` /
  `style.css`.
- **No → `src/`** (the tool layer, never ships). Keep it in the tool that
  uses it (`validate.js`, `schedule.js`, `repl.js`); put it in `src/tools.js`
  when two or more tools share it — repo I/O and tool-only predicates already
  live there. Root files (`gb.js`, `.githooks/`) dispatch and gate only; logic
  lives in `src/`.
- **Specs → `specs/`**, one file per tournament, consumed only by `schedule.js`;
  regenerate before results go in.

## Conventions

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `perf:`, `ci:`,
  with a scope when it helps, as the existing history does.
- **No package.json, no npm** — scripts run with `node` directly; tests run
  with `node --test` (node:test), in the repo root, exactly as the pre-commit
  hook runs them.
