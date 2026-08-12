'use strict';

// tools.js: shared tool logic — repo I/O + tool-only predicates. writeTournament
// is exercised through repl.js's writeEdit disk test; the readErrs path below is
// the one loadRepo behavior no other suite touches (every fixture parses cleanly).
// isRealDate gets a direct check because its all-integer guard is new behavior:
// the old inline rollover checks let a non-numeric month (2025-xx-01) slip past
// (NaN !== NaN is false).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo, isRealDate } = require('../src/tools.js');
const { FIX } = require('./helpers.js');

test('repo loadRepo: unreadable tournament files land in readErrs, the rest still load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tournaments'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tournaments.json'), JSON.stringify([{ slug: 'ok', name: 'Ok' }, { slug: 'bad', name: 'Bad' }]));
    fs.cpSync(FIX('sample', 'tournaments', 'sample.json'), path.join(tmp, 'tournaments', 'ok.json'));
    fs.writeFileSync(path.join(tmp, 'tournaments', 'bad.json'), '{ not json');
    const repo = loadRepo(tmp);
    assert.equal(repo.readErrs.length, 1, 'one unreadable file reported');
    assert(/bad\.json/.test(repo.readErrs[0]), 'readErrs names the file');
    assert(repo.tournaments.has('ok'), 'readable tournaments still load');
    assert(repo.tournaments.get('bad').tjson === undefined, 'unreadable tournament keeps its placeholder entry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tools isRealDate: real dates pass, rolled-over and non-numeric dates fail', () => {
  assert(isRealDate(2026, 2, 28) && isRealDate(2024, 2, 29) && isRealDate(2026, 11, 1), 'real calendar dates');
  assert(!isRealDate(2026, 2, 30), '2026-02-30 rolls over');
  assert(!isRealDate(2026, 13, 1) && !isRealDate(2026, 0, 1), 'months out of range');
  assert(!isRealDate(2026, 'xx', 1) && !isRealDate('x', 2, 30), 'non-numeric parts — the guard the old inline check missed');
});
