# AGENTS.md

The README describes the model and the tools; the code comments carry the
details. When docs and code disagree, code wins.

## Architectural principles

- **Write access is push access.** No server, no accounts — git is the whole
  system.
- **derive.js is the single source of the domain model.** Validator, CLI,
  generator, and renderers all consume it — extend it, never reimplement the
  model elsewhere. The integrity gate must not depend on renderer code.
- **A corrected score reseeds the bracket at render.** Nothing derived is
  stored; a match is done when it has a result.
- **Slots are category-local, consumed exactly once, acyclic.**
- **One file per tournament** — atomic reads, cross-category edits in one
  place.
- **Dev tooling stays at the root and never ships.** `site/` is the shipping
  surface.
- **Never weaken a check to make data pass — fix the data.** Pre-commit and
  the Pages workflow both run validate + tests, so a bypassed hook can't
  ship.
- **A behavior change is a fixture + a test.** New validator rules and derive
  behavior need a committed scenario under `fixtures/` (a self-contained mini
  repo) and an assertion in `test/`, loaded through the same `loadRepo` as
  real checkouts. Tests load and assert only — never mutate data, never
  depend on live `site/tournaments/`.
- **Git is the concurrency design.** A rejected push means someone pushed
  first: `git pull --rebase && git push`. No retry loops, no CAS. One scorer
  owns one tournament.
- **Renderers never throw** — missing data renders empty, unresolvable slots
  render a descriptive label. Cycles and reference errors are the validator's
  job.
- **Repo-sourced strings render as text, never HTML.**
- **Minimal diffs.** Data edits stay byte-identical apart from the change, so
  a commit diff shows only the edit.
- **Never stamp `?v=` manually, never commit stamped URLs** — the deploy
  workflow stamps them.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling
  and the upgrade path.

## Conventions

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `perf:`, `ci:`,
  with a scope when it helps, as the existing history does.
