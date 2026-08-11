'use strict';

// Shared helpers for the test suites: fixture paths + repo loading.
// Auto-discovery runs this file too; it defines no tests, which is fine.

const path = require('path');
const { loadRepo } = require('../src/repo.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/app.js');

const FIX = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context straight from a fixture's JSON
function catOf(name, catId) {
  const tjson = require(FIX(name, 'tournaments', `${name}.json`));
  return makeCat({ meta: tjson.categories.find(c => c.id === catId), matches: (tjson.matches || {})[catId] || [] }, tjson);
}

module.exports = { FIX, hasErr, hasWarn, validateFixture, catOf };
