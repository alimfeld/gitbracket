# Architecture

The site is data plus a small pipeline. Two rules shape every module boundary:

- **The model depends on nothing.** `site/derive.js` is a source: facts in, facts
  out, no requires, no locale, no markup.
- **The gate never reaches presentation.** Of the shipped site modules, the gate
  imports `derive.js` only — never `views.js`; it also imports `src/tools.js` for
  repo I/O and tool-only predicates.

Notation: `A ──▶ B` means **A depends on B** — every arrowhead lands on the thing
being depended on.

## Module graph

```
NODE    → site/derive.js                              (facts, no deps)
NODE    → src/tools.js → site/derive.js               (repo I/O + tool-only predicates)
            src/validate.js  → tools.js, derive.js
            src/edits.js     → tools.js, validate.js, derive.js
            src/schedule.js  → tools.js, validate.js, derive.js
            src/publish.js   → tools.js, validate.js
            src/admin.js     → tools.js, edits.js, validate.js, publish.js
            src/sim.js       → tools.js, publish.js
BROWSER → site/app.js, src/admin/app.js → site/views.js → site/derive.js, site/i18n.js
both browser consumers also read derive.js directly
```

Node tools may depend on one another (never upward into a browser module); the
site is a strict chain — `views.js` never depends on a tool.

Node tools never touch `views.js` — the editor's commit message formats its own
locale-free team names and structural refs instead.

## The category context

Every derived read takes the `ctx` a category builds — `makeCat`/`toCats` in
`derive.js`, `catCtx` for a tool. It carries the matches, the `byId` map, names,
timezone, and a per-render `_memo` bucket. The memoized builders form a **DAG,
not a pipeline**: `koColumn` reads `plRange` and `wdOf`; `plBuild` reads
`parentsOf` and `wdOf`; `plOrdinal` reads `plRange` and `koOrdinal`. Each builder
memoizes on first use, so any read order yields the same facts (pinned by
`test/architecture.test.js`). A **fresh `ctx` per render** discards the memo, so a
corrected score surfaces on the next poll. A new builder must follow the same
shape: memoize under a unique key, and read other builders only through their
public function. The only caches that outlive a render are keyed by immutable
inputs — the formatter/offset maps (`zoneFormatters`, `wallOffsets` in derive;
`locFmts` in views) — so they stay put on purpose; anything keyed by match data
belongs in `ctx._memo`.

## Responsibilities

| Module | Owns | Depends on | Must not |
|---|---|---|---|
| `site/derive.js` | raw facts → derived facts: categories, standings, slot resolution, bracket shape, placement bands, wall-clock instants | — (nothing) | call `t`/`esc`, hold `LOCALE`, `require` anything |
| `site/views.js` | facts → human words and markup: labels, status lines, formatting | `derive`, `i18n` | be imported by any node tool |
| `site/i18n.js` | word bundles as data, plus the `t`/`bundle` substitution mechanism and the per-locale formatters the bundles name (`fmt`) | — | hold markup or domain facts; make a word rule a code branch instead of bundle data |
| `site/app.js` | public + kiosk rendering, routing, polling | `derive`, `views`, `i18n` | |
| `src/admin/app.js` | admin edit UI (browser, served loopback-only) | `derive`, `views`, `i18n` | be published |
| `src/admin.js` | daemon: serve the admin page + site modules, edit/publish API | `derive`, `edits`, `publish` | import `views` |
| `src/tools.js` | node-only shared substrate: repo I/O (`loadRepo`), git, and the tool-only domain predicates the site never ships (`schedEntries`, `pairBusy`, `consumedSlots`, `winTarget`, `reachedWinner`, `feederBounds`) | `derive` | import `views`, hold shipped markup |
| `src/*.js` | node tools: gate, generator, editor, publish, sim | `derive`, `tools`, other node tools | import `views` |

## Invariants

Pinned by `test/architecture.test.js`:

- `site/derive.js` contains no `require(`, no `t(`, no `esc(`, no `LOCALE`.
- No node tool under `src/` (outside `src/admin/`, which is browser code) imports
  `views.js`.
- Every `derive.js` export is read by a browser consumer (the shipped site or the
  loopback admin), or is a named node-shared primitive (`ISO_RE`, `pairSig`,
  `makeCat`, `matchesOf`, `parentsOf`, `validBestOf`) — no dead or node-only drift.
- Each page's scripts compile together with no top-level name declared twice —
  classic scripts share one global lexical scope.
- Every id a page looks up (`$('…')` / `getElementById('…')`) is produced by that
  page's HTML or its own markup.

## Where new code goes

One question decides placement: does the browser run it?

- **Yes, on the shipped site → `site/`**: fetch/render/boot in `app.js`, markup
  and styling in `index.html` / `style.css`, facts in `derive.js`, words and
  markup in `views.js`.
- **Yes, but never shipped → `src/<tool>/`**, beside the server that serves it —
  the admin page in `src/admin/`, served loopback-only by the daemon.
- **No → `src/`**: keep it in the tool that uses it, share via `src/tools.js`.
  Root files (`gb.js`, `.githooks/`) dispatch and gate only.
- **Specs → `specs/`**, one file per tournament, consumed only by `schedule.js`.
- **Print → `print/`**: static print assets — `print/match-card.html`, the blank
  match-day card sheet: no data, no generator, nothing in the pipeline reads it.

A function that returns **words or tags** belongs in `views.js`; one that returns
**facts** belongs in `derive.js`. When unsure, ask whether the gate could ever
call it — if yes, it is a fact.
