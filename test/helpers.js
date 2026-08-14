'use strict';

// Shared helpers for the test suites: fixture paths + repo loading.
// Auto-discovery runs this file too; it defines no tests, which is fine.

const path = require('path');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');

const FIX = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context from a fixture repo — loaded through
// the same loadRepo as real checkouts, per AGENTS.md
function catOf(name, catId) {
  const info = loadRepo(FIX(name)).tournaments.get(name);
  return makeCat({ meta: info.tjson.categories.find(c => c.id === catId), matches: (info.matches.get(catId) || {}).matches || [] }, info.tjson);
}

module.exports = { FIX, hasErr, hasWarn, validateFixture, catOf };
