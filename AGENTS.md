# AGENTS.md

README describes the model and the tools; tests pin behavior. When docs and
code disagree, code wins.

## Architectural principles

Violating a principle breaks the system — now, or the first time an upstream
fact changes: a wrong render, a bypassable gate, lost data. Code and tests
implement them; don't treat them as style.

- **Git is the record, not the transport.** No server, no accounts — the repo
  is data, history, and frontend. Only `gb.js publish` ships `site/` to the
  production domain, and only from `main`. Publishing sits outside git — last
  write wins on the CDN, safe because one director ships, everyone else pulls
  and reviews.
- **Never store what can be derived.** Results are stored as the raw facts a
  scorer records — games, scores, winner — never the aggregates built from
  them (standings, ranks, done flags); an aggregate goes silently stale the
  moment a fact is corrected, so everything downstream is recomputed at
  render. Schedules are the exception: they can't be derived, so they're
  stored — generated from a spec for convenience, tweakable via the REPL;
  regeneration rewrites the whole file, so never run it after results are
  in.
- **Times are wall-clock, never offsets.** `scheduled` holds local wall time
  in the tournament's IANA `timezone` — never a UTC instant or an offset. The
  instant is derived at render, so data stays readable local time and stays
  right if clock rules change.
- **derive.js is the single source of the site's domain model.** Validator,
  REPL, generator, and renderers all consume it — extend it, never reimplement
  the model elsewhere. The integrity gate never depends on renderer code, and
  derive.js must run in the browser and under node, so node-only modules stay
  out. Its internal laws: side identity derives from the player set, never
  from list order; memoized state resets every render, so a corrected score
  surfaces on the next poll; resolution is cycle-proof — the validator
  rejects cycles first, so a guard only ever prevents a hang.
- **Slots are category-local, consumed at most once, acyclic.**
- **Every REPL edit validates, writes, and commits itself** — the process can
  die at any instant with nothing lost.
- **One file per tournament, minimal diffs.** Data edits stay byte-identical
  apart from the change, so a commit diff shows only the edit.
- **Renderers never throw, and neither does the gate.** Missing data renders
  empty, unresolvable slots render a descriptive label, malformed data
  reports an error — never a crash. Cycles and reference errors are the
  validator's job. Data from the repo renders as text, never HTML.
- **Markup is semantic, styling is minimal.** Shipped HTML uses real
  elements — headings, sections, articles, tables, `details`, navs, links —
  with one small stylesheet, no framework, no presentational classes from JS.
  State rides `data-*` / `aria-current`, the kiosk palette is one body class,
  and layout is flex/grid + `em` — one font-size knob scales the kiosk, and
  there are no media queries. New markup reuses existing elements and rules;
  a new class is a change to be justified.
- **Never weaken a check to make data pass — fix the data.** Pre-commit runs
  validate + tests (the dev gate); `gb.js publish` re-runs validate (the data
  gate) — a bypassed hook can't ship.

## Where code lives

One question decides placement for any new function: does the browser run it?

- **Yes → `site/`** (the shipping surface). Pure fetch/render/boot in
  `app.js`; markup and styling in `index.html` / `style.css`; shared
  computations in `derive.js` so the gate and the renderer can't drift.
- **No → `src/`** (the tool layer, never ships). Keep it in the tool that
  uses it (`validate.js`, `schedule.js`, `repl.js`); share via `src/tools.js`
  — repo I/O and tool-only predicates already live there. Root files
  (`gb.js`, `.githooks/`) dispatch and gate only; logic lives in `src/`.
- **Specs → `specs/`**, one file per tournament, consumed only by
  `schedule.js`.

## Conventions

Violating a convention costs friction, not correctness — they are working
agreements; if one doesn't fit, raise it instead of breaking it silently.

- **Comments state why, never what** — code and tests carry the what.
  Shipping-surface comments cost transfer bytes on every page load, so keep
  rationale out of `site/` unless it warns against a real trap.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling
  and the upgrade path — the shortcut ledger.
- **A behavior change is a fixture + a test.** New validator rules and derive
  behavior need a committed scenario under `fixtures/` and an assertion in
  `test/`, both loaded via the same `loadRepo` as real checkouts. Tests
  assert domain behavior — ladder order, slot resolution, validation
  outcomes, escaping, no-throw — not markup shape; renderer decisions may
  change without touching tests, and tests never mutate data or depend on
  live `site/tournaments/`.
- **Concurrent edits are rebase conflicts, not lost writes.** A rejected push
  means someone pushed first: `git pull --rebase && git push`.
- **One scorer owns one tournament.**
- **No commits without an ask** — never stage, commit, push, or publish
  unless the user explicitly instructed it; leave the change uncommitted and
  report it as such.
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `perf:`, `ci:`,
  with a scope when it helps, as the existing history does.
- **No package.json, no npm** — scripts run with `node` directly; tests run
  with `node --test` in the repo root, exactly as the pre-commit hook runs
  them.
