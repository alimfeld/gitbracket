'use strict';

// admin.js: the localhost admin daemon's write funnel — doEdit (validate →
// write → commit, one path for every verb the page sends). Run against a
// scratch git repo so the commit path is real; the real repo is never touched.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const admin = require('../src/admin.js');
const { git, scratchWithRemote } = require('./admin-helpers.js');

test('admin doEdit: a raw result string is parsed with the shared grammar — page and typed entries can never drift', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const good = admin.doEdit(state, 'result', 'md40', '8', '21-19 21-18'); // the display form, typed raw
    assert.equal(good.ok, true, 'a raw score string lands');
    assert(/^score\(sample\): md40\/8 /.test(admin.unpushed(tmp).commits[0].msg), 'the raw string parses into the score kind');
    const m8 = loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8.result.status === 'played' && m8.result.winner === 'a', 'raw games apply as a played result');
    const bad = admin.doEdit(state, 'result', 'md40', '8', 'wo a x'); // the grammar's own refusal, daemon-side
    assert.equal(bad.ok, false, 'a bad grammar is refused');
    assert(/wo takes nothing else/.test(bad.error), 'the refusal speaks the grammar\'s words');
    assert.equal(admin.unpushed(tmp).commits.length, 1, 'a refused grammar never commits');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit: the commit takes only the edited tournament file — other staged changes stay put', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'staged but unrelated\n');
    git(tmp, ['add', 'note.txt']);
    const r = admin.doEdit(state, 'result', 'md40', '8', '21-19 21-18');
    assert.equal(r.ok, true, 'the edit lands');
    const only = git(tmp, ['show', '--name-only', '--format=', 'HEAD']).out.trim().split('\n');
    assert.deepEqual(only, ['site/tournaments/sample.json'], 'the commit names only the tournament file');
    const staged = git(tmp, ['diff', '--cached', '--name-only']).out.trim().split('\n');
    assert(staged.includes('note.txt'), 'the unrelated staged file is still staged, not swept into the commit');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit: a score commits with a conventional message and shows as pending until reset', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const r = admin.doEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(r.ok, true, 'the edit lands');
    assert(r.sha, 'the receipt carries the short sha');
    const pend = admin.unpushed(tmp);
    assert.equal(pend.commits.length, 1, 'one pending commit');
    assert(/^score\(sample\): md40\/8 /.test(pend.commits[0].msg), 'pending list shows the commit message');
    // file on disk tells the same story as the commit
    const m8 = loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8.result.status === 'played' && m8.result.winner === 'a', 'games applied with a result');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'scratch still validates');
    // undo (reset --hard HEAD~1, the daemon's own semantics) restores origin
    assert.equal(git(tmp, ['reset', '--hard', 'HEAD~1']).status, 0);
    const m8b = loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8b.result === undefined, 'undo restores the unscored match');
    assert.equal(git(tmp, ['status', '--porcelain']).out.trim(), '', 'working tree clean after undo');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit: an invalid edit is rejected with the validator errors and nothing commits', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const gitHead = git(tmp, ['rev-parse', 'HEAD']).out.trim();
    const before = fs.readFileSync(path.join(siteRoot, 'tournaments', 'sample.json'), 'utf8');
    const m8t = loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8).scheduled;
    const r = admin.doEdit(state, 'move', 'md40', '8', { time: m8t, venue: 'bogus-court' });
    assert.equal(r.ok, false);
    assert(r.errors && r.errors.some(e => /unknown venue/.test(e)), 'the validator message comes back');
    assert.equal(git(tmp, ['rev-parse', 'HEAD']).out.trim(), gitHead, 'no new commit');
    assert.equal(fs.readFileSync(path.join(siteRoot, 'tournaments', 'sample.json'), 'utf8'), before, 'file unchanged on refusal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit move: clearing time+venue is one atomic commit, a real move is one too', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const m8 = () => loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    const m9 = () => loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 9);
    const r = admin.doEdit(state, 'move', 'md40', '8', { time: null, venue: null });
    assert.equal(r.ok, true, 'unscheduling lands');
    assert(m8().scheduled === undefined && m8().venue === undefined, 'both keys drop — atomic');
    assert.equal(admin.unpushed(tmp).commits.length, 1, 'exactly one commit for the pair');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'cleared snapshot validates');
    // and a real move — md40/9 is the final: feeders 7/8 end at 12:00 (45-min
    // group slots), nothing consumes it, court-1 is free at 12:00 exactly; the
    // 45-min grid makes 12:00 the slot before its own 12:15
    const r2 = admin.doEdit(state, 'move', 'md40', '9', { time: '2025-07-14T12:00:00', venue: 'court-1' });
    assert.equal(r2.ok, true, 'the legal move lands');
    assert.equal(m9().scheduled, '2025-07-14T12:00:00', 'time set');
    assert.equal(m9().venue, 'court-1', 'venue set');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'moved snapshot validates');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit clear: its commit kind mirrors what was removed (score/walkover), like a typed entry', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    // xd/1 is a played group match with no undone consumer, so clearing is legal
    admin.doEdit(state, 'result', 'xd', '1', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    admin.doEdit(state, 'result', 'xd', '1', { shape: 'clear' });
    admin.doEdit(state, 'result', 'xd', '1', { shape: 'walkover', winner: 'a' });
    admin.doEdit(state, 'result', 'xd', '1', { shape: 'clear' });
    // git log is newest-first: [walkover-clear, walkover, score-clear, score]
    const msgs = admin.unpushed(tmp).commits.map(c => c.msg);
    assert(/^score\(sample\)/.test(msgs[2]), 'a clear of a score commits as score');
    assert(/^walkover\(sample\)/.test(msgs[0]), 'a clear of a walkover commits as walkover');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit: an out-of-band hand edit is refused once, reloaded, and the retry applies onto it — nothing clobbered', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const file = path.join(siteRoot, 'tournaments', 'sample.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.players[0].name = 'Hand-Edited Name'; // the operator's out-of-band fix after boot
    fs.writeFileSync(file, JSON.stringify(disk, null, 2) + '\n');
    const first = admin.doEdit(state, 'result', 'md40', '8', '21-19 21-18');
    assert.equal(first.ok, false, 'the stale-memory edit is refused');
    assert(/changed on disk/.test(first.error), `the refusal names the cause, got: ${first.error}`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).players[0].name, 'Hand-Edited Name', 'the hand edit survives the refusal');
    const second = admin.doEdit(state, 'result', 'md40', '8', '21-19 21-18'); // the failure reloaded the daemon's view
    assert.equal(second.ok, true, 'the retry applies onto the reloaded state');
    const after = loadRepo(siteRoot).tournaments.get('sample').tjson;
    assert.equal(after.players[0].name, 'Hand-Edited Name', 'the hand edit rides into the commit');
    assert.equal(after.matches.md40.find(m => m.id === 8).result.status, 'played', 'the score lands too');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin doEdit: a malformed file on disk is a refusal, never a throw — the daemon survives the match day', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const file = path.join(siteRoot, 'tournaments', 'sample.json');
    fs.writeFileSync(file, '{ hand edit gone wrong');
    let first;
    assert.doesNotThrow(() => { first = admin.doEdit(state, 'result', 'md40', '8', '21-19 21-18'); },
      'a corrupt disk file must not throw out of the request handler');
    assert.equal(first.ok, false, 'the edit is refused');
    assert(/not readable JSON/.test(first.error), `the refusal names the cause, got: ${first.error}`);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ hand edit gone wrong', 'nothing was overwritten');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

