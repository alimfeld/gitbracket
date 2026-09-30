'use strict';

// Architecture invariants (ARCHITECTURE.md): the model is a dependency-free
// source, and the gate can never reach the browser-only views module. Both are
// greppable, so a stray helper can't quietly re-couple the layers.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

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
