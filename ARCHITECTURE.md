# Architecture

The site is data plus a small pipeline. Two rules shape every module boundary:

- **The model depends on nothing.** `site/derive.js` is a source: facts in, facts
  out, no requires, no locale, no markup.
- **The gate never reaches presentation.** `src/validate.js` and `src/publish.js`
  import `derive.js` only.

Notation: `A ──▶ B` means **A depends on B** — every arrowhead lands on the thing
being depended on.

## Module graph

```
NODE    → site/derive.js                 (facts, no deps)
NODE    → src/tools.js → site/derive.js  (repo I/O + tool-only predicates)
BROWSER → site/app.js, src/admin/app.js → site/views.js → site/derive.js, site/i18n.js
both browser consumers also read derive.js directly
```

Node tools never touch `views.js` — the editor's commit message formats its own
locale-free team names and structural refs instead.

## Responsibilities

| Module | Owns | Depends on | Must not |
|---|---|---|---|
| `site/derive.js` | raw facts → derived facts: categories, standings, slot resolution, bracket shape, placement bands, wall-clock instants | — (nothing) | call `t`/`esc`, hold `LOCALE`, `require` anything |
| `site/views.js` | facts → human words and markup: labels, status lines, formatting | `derive`, `i18n` | be imported by any node tool |
| `site/i18n.js` | word bundles as data | — | contain logic |
| `site/app.js` | public + kiosk rendering, routing, polling | `derive`, `views`, `i18n` | |
| `src/admin/app.js` | admin edit UI (browser, served loopback-only) | `derive`, `views`, `i18n` | be published |
| `src/admin.js` | daemon: serve the admin page + site modules, edit/publish API | `derive`, `edits`, `publish` | import `views` |
| `src/tools.js` | node-only shared substrate: repo I/O (`loadRepo`), git, and the tool-only domain predicates the site never ships (`schedEntries`, `pairBusy`, `consumedSlots`, `winTarget`, `reachedWinner`, `feederBounds`) | `derive` | import `views`, hold shipped markup |
| `src/*.js` | node tools: gate, generator, editor, publish, sim | `derive` | import `views` |

## Invariants

Pinned by `test/architecture.test.js`:

- `site/derive.js` contains no `require(`, no `t(`, no `esc(`, no `LOCALE`.
- No node tool under `src/` (outside `src/admin/`, which is browser code) imports
  `views.js`.
- Every `derive.js` export is read by a shipped file, or is a named node-shared
  primitive (`ISO_RE`, `pairSig`, `makeCat`, `matchesOf`, `parentsOf`) — no dead
  or node-only drift.
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

A function that returns **words or tags** belongs in `views.js`; one that returns
**facts** belongs in `derive.js`. When unsure, ask whether the gate could ever
call it — if yes, it is a fact.
