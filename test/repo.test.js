'use strict';

// repo.js: shared repo I/O. writeTournament is exercised through repl.js's
// writeEdit disk test; the readErrs path below is the one loadRepo behavior
// no other suite touches (every fixture parses cleanly).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/repo.js');
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
