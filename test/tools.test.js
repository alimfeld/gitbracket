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
const { loadRepo, isRealDate, findRoot, writeTournamentIndex } = require('../src/tools.js');
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

test('tools writeTournamentIndex: one entry per line — index diffs stay per-tournament', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    writeTournamentIndex(tmp, [
      { slug: 'one', name: 'One', dates: ['2026-07-11'] },
      { slug: 'two', name: 'Two' },
    ]);
    const out = fs.readFileSync(path.join(tmp, 'tournaments.json'), 'utf8');
    assert.equal(out, '[\n  {"slug":"one","name":"One","dates":["2026-07-11"]},\n  {"slug":"two","name":"Two"}\n]\n', 'the byte shape is a contract, not an accident');
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

test('tools findRoot: walks up to the repo root from a nested dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    fs.mkdirSync(path.join(tmp, 'site', 'tournaments'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'site', 'tournaments.json'), '[]');
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    assert.equal(findRoot(path.join(tmp, 'a', 'b')), tmp, 'nested dir resolves to the repo root');
    assert.equal(findRoot(tmp), tmp, 'the repo root resolves to itself');
    assert.equal(findRoot('/'), '/', 'no repo above: stops at the filesystem root');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
