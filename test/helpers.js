'use strict';

// Shared helpers for the test suites: fixture paths + repo loading.
// Auto-discovery runs this file too; it defines no tests, which is fine.

const path = require('path');
const { loadRepo, validateRepo } = require('../validate.js');
const { makeCat } = require('../site/app.js');

const FIX = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context straight from a fixture's JSON
function catOf(name, catId) {
  const base = FIX(name, 'tournaments', name);
  const tjson = require(path.join(base, 'tournament.json'));
  const cjson = require(path.join(base, 'matches', `${catId}.json`));
  return makeCat({ meta: tjson.categories.find(c => c.id === catId), matches: cjson.matches }, tjson);
}

module.exports = { FIX, hasErr, hasWarn, validateFixture, catOf };
