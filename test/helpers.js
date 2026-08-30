'use strict';

// Shared helpers for the test suites: fixture paths + repo loading.
// Auto-discovery runs this file too; it defines no tests, which is fine.

const path = require('path');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');

const FIX = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

// Shared between the schedule and sim suites: a spec that generates both
// pools (3+2 teams) and a knockout with pool-rank and match-winner feeders.
const MINI = {
  slug: 'mini',
  name: 'Mini Open',
  location: 'Zurich',
  timezone: 'Europe/Zurich',
  date: '2026-05-02',
  poolSize: 4,
  blocks: { md: '09:00', xd: '13:00' },
  venues: { 'court-1': 'Court 1', 'court-2': 'Court 2' },
  players: { ada: 'Ada', ben: 'Ben', cid: 'Cid', dan: 'Dan', eve: 'Eve', fin: 'Fin', gus: 'Gus', huw: 'Huw', ida: 'Ida', jan: 'Jan', kim: 'Kim' },
  categories: [
    { id: 'md', name: 'Men', bestOf: 1, slotMinutes: 30, final: { bestOf: 3, slotMinutes: 60 } },
    { id: 'xd', name: 'Mixed', bestOf: 1, slotMinutes: 30 },
  ],
  teams: {
    md: [['ada', 'ben'], ['cid', 'dan'], ['eve', 'fin'], ['gus', 'huw'], ['ida', 'jan']],
    xd: [['ada', 'cid'], ['ben', 'eve']],
  },
};

const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context from a fixture repo — loaded through
// the same loadRepo as real checkouts, per AGENTS.md
function catOf(name, catId) {
  const info = loadRepo(FIX(name)).tournaments.get(name);
  return makeCat({ meta: info.tjson.categories.find(c => c.id === catId), matches: (info.tjson.matches || {})[catId] || [] }, info.tjson);
}

module.exports = { FIX, MINI, hasErr, hasWarn, validateFixture, catOf };
