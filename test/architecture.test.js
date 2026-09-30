'use strict';

// Architecture invariants (ARCHITECTURE.md): the model is a dependency-free
// source, and the gate can never reach the browser-only views module. Both are
// greppable, so a stray helper can't quietly re-couple the layers.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plRange, koColumn, koOrdinal, placementColumn, plOrdinal } = require('../site/derive.js');
const { catOf } = require('./helpers.js');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('derive.js is the dependency-free model: no requires, no words, no locale', () => {
  const s = read('site/derive.js');
  assert.doesNotMatch(s, /\brequire\s*\(/, 'derive.js must not require anything');
  assert.doesNotMatch(s, /\bt\s*\(/, 'derive.js must not look up words');
  assert.doesNotMatch(s, /\besc\s*\(/, 'derive.js must not emit markup');
  assert.doesNotMatch(s, /\bLOCALE\b/, 'derive.js must not depend on a locale');
});

// Node tools live in src/ or a src/<tool>/ dir; src/admin/ is browser code
// (loopback-served, never shipped) and may reference views globals.
const nodeTools = () => fs.readdirSync(path.join(root, 'src'), { recursive: true })
  .filter(f => f.endsWith('.js') && !f.startsWith('admin' + path.sep))
  .map(f => path.join('src', f));

test('every node tool stays off views.js (browser-only)', () => {
  for (const f of nodeTools()) {
    assert.doesNotMatch(read(f), /require\([^)]*views\.js/, `${f} must not import views.js`);
  }
});

// derive.js is the shipped model. A helper the gate/tools share is exported on
// purpose and named here; anything else must be read by a shipped file, so a
// helper can't quietly drift into node-only or die unused.
const NODE_SHARED_EXPORTS = new Set(['ISO_RE', 'pairSig', 'makeCat', 'matchesOf', 'parentsOf', 'validBestOf']);

test('every derive.js export is read by the shipped site, or is a node-shared primitive', () => {
  const shipped = ['site/app.js', 'site/views.js', 'site/i18n.js']
    .map(f => read(f).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
  const orphans = Object.keys(require('../site/derive.js'))
    .filter(n => !NODE_SHARED_EXPORTS.has(n) && !new RegExp(`\\b${n}\\b`).test(shipped));
  assert.deepEqual(orphans, [], `derive.js exports no shipped file reads (drop it or make it node-shared): ${orphans.join(', ')}`);
});

// A browser loads a page's scripts as separate classic scripts sharing one global
// lexical environment: a name declared twice across two of them is an early error
// that kills the page from that script on (the admin's duplicate wallMin did this).
// Compiling the bundle as one script reproduces the engine's own check, no DOM needed.
const PAGES = [['site/index.html', 'site'], ['src/admin/index.html', 'site']];
const bundleOf = (htmlPath, sharedDir) => {
  const html = read(htmlPath);
  return [...html.matchAll(/<script src="([^"]+\.js)"/g)].map(m => m[1])
    // app.js is the page's own file; the domain modules are served from site/
    .map(src => src === 'app.js' ? path.join(path.dirname(htmlPath), src) : path.join(sharedDir, src));
};

// The model's derived facts hang off ctx._memo, built on first read. Their build
// order must not matter: any read order yields the same facts. This pins the
// demand-driven property that a future builder could quietly break by reading a
// sibling before it is built.
test('derive memo builders are order-independent — any read order yields the same facts', () => {
  const snap = ctx => new Map(ctx.matches.map(m => [m.id, JSON.stringify({
    pl: plRange(m, ctx),
    col: koColumn(m, ctx),
    ord: koOrdinal(m, ctx),
    band: placementColumn(m, ctx),
    plOrd: plOrdinal(m, ctx),
  })]));
  const forward = snap(catOf('place8', 't'));
  assert(forward.size > 0, 'the fixture has matches to compare');
  const hostile = catOf('place8', 't');
  // deepest-first, ordinals before the columns that feed them
  for (const m of [...hostile.matches].reverse()) {
    plOrdinal(m, hostile);
    placementColumn(m, hostile);
    koOrdinal(m, hostile);
    koColumn(m, hostile);
  }
  assert.deepEqual(snap(hostile), forward);
});

test('each page\'s scripts compile together — no top-level declaration is claimed twice', () => {
  for (const [htmlPath, sharedDir] of PAGES) {
    const files = bundleOf(htmlPath, sharedDir);
    assert(files.length >= 2, `${htmlPath} names the scripts it loads`);
    const src = files.map(read).join('\n;\n'); // one script: a duplicate lexical name is an early error here
    assert.doesNotThrow(() => new vm.Script(src, { filename: files.join('+') }),
      `${htmlPath}: ${files.join(', ')} collide on a top-level declaration`);
  }
});

// A lookup of an id no element carries returns null, and a null-guarded read then
// silently no-ops (the admin's $('board') sized nothing for as long as it existed).
// Ids produced dynamically live in the bundle's own markup, so both are searched.
test('every id a page looks up is one that page produces', () => {
  for (const [htmlPath, sharedDir] of PAGES) {
    const files = bundleOf(htmlPath, sharedDir);
    const js = files.map(read).join('\n');
    const produced = new Set([...(read(htmlPath) + js).matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
    const looked = [...js.matchAll(/(?:\$|getElementById)\(['"]([a-zA-Z0-9_-]+)['"]\)/g)].map(m => m[1]);
    for (const id of looked) assert(produced.has(id), `${htmlPath} — ${files.join(', ')} looks up #${id}, which nothing produces`);
  }
});
