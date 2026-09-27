'use strict';

// admin.js: the board's write path — doEdit — plus the pairBusy atom the gate
// and the validator share. Pure computations over a tjson; no git, no daemon.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo, schedEntries, pairBusy } = require('../src/tools.js');
const admin = require('../src/admin.js');
const { FIX } = require('./helpers.js');

test('admin pairBusy: the validator\'s conflict kinds — the same atom the gate runs', () => {
  const db = schedEntries(loadRepo(FIX('bad-player-doublebook')).tournaments.get('bad-player-doublebook').tjson).entries;
  assert.deepEqual(pairBusy(db[0], db[1]), ['player'], 'shared players in the same window, different courts');
  const ov = schedEntries(loadRepo(FIX('bad-venue-overlap')).tournaments.get('bad-venue-overlap').tjson).entries;
  assert.deepEqual(pairBusy(ov[0], ov[1]), ['venue'], 'same court in the same window');
  assert.deepEqual(pairBusy(db[0], ov[0]), [], 'disjoint windows conflict with nothing');
});

test('admin doEdit: a shape-broken hand edit reports, never throws', () => {
  // doEdit's catCtx runs before the write — the unknown category must report.
  const repo = loadRepo(FIX('bad-null-category'));
  const state = { root: '/', siteRoot: FIX('bad-null-category'), repo, slug: 'bad-null-category', redo: [] };
  assert.equal(admin.doEdit(state, 'move', 't', '1', { time: null, venue: null }).ok, false, 'the unknown category is reported');
});
