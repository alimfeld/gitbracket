'use strict';

// admin.js: the localhost admin daemon's write funnel — doEdit (validate →
// write → commit, one path for every verb the page sends) and unpushed (the
// pending list). Run against a scratch git repo so the commit path is real;
// the real repo is never touched (same rule as every suite here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const admin = require('../src/admin.js');
const { FIX } = require('./helpers.js');

const git = (root, args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return { ...r, out: r.stdout || '' }; };
// the admin daemon's own git() renames stdout → out; the helper aliases it so
// tests read the same shape the daemon does

// A scratch repo: site copy from the sample fixture + git, with an origin so
// unpushed() can see origin/main..HEAD (the real deployment shape).
function scratchWithRemote() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbadmin-'));
  const siteRoot = path.join(tmp, 'site');
  fs.mkdirSync(siteRoot, { recursive: true });
  fs.cpSync(FIX('sample'), siteRoot, { recursive: true });
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.email', 't@t']);
  git(tmp, ['config', 'user.name', 'test']);
  git(tmp, ['add', '-A']);
  git(tmp, ['commit', '-qm', 'init']);
  git(tmp, ['branch', '-M', 'main']);
  const origin = path.join(tmp, 'origin.git');
  git(tmp, ['init', '-q', '--bare', origin]);
  // the bare origin lives inside the scratch repo — exclude it so the working
  // tree stays clean for the undo assertions
  fs.appendFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'origin.git/\n');
  git(tmp, ['remote', 'add', 'origin', origin]);
  git(tmp, ['push', '-q', 'origin', 'main']);
  const repo = loadRepo(siteRoot);
  return { tmp, siteRoot, state: { root: tmp, siteRoot, repo, slug: 'sample' } };
}

test('admin unpushed: no remote reports hasRemote false — undo/publish stay off', () => {
  const { tmp } = scratchWithRemote();
  try {
    git(tmp, ['remote', 'remove', 'origin']); // a repo with no remote — nothing is provably pending
    const p = admin.unpushed(tmp);
    assert.equal(p.hasRemote, false, 'no origin/main → nothing is provably pending');
    assert.deepEqual(p.commits, [], 'and the list is empty — undo would reset a possibly-shared commit');
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
    assert(/\[[0-9a-f]{7}\]/.test(r.text), 'the echo carries the sha receipt');
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
    const r = admin.doEdit(state, 'venue', 'md40', '8', 'bogus-court');
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

test('admin doEdit: panel clears send null through the shared funnel — time and venue both land', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const m8 = () => loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8().scheduled && m8().venue, 'precondition: md40/8 is scheduled on a court');
    assert.equal(admin.doEdit(state, 'time', 'md40', '8', null).ok, true, 'a null time clears the slot');
    assert.equal(m8().scheduled, undefined, 'scheduled drops — nothing is written as null');
    assert.equal(admin.doEdit(state, 'venue', 'md40', '8', null).ok, true, 'a null venue clears the court');
    assert.equal(m8().venue, undefined, 'venue drops');
    assert.equal(admin.unpushed(tmp).commits.length, 2, 'two atomic commits');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'cleared snapshot validates');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('admin doEdit clear: its commit kind mirrors what was removed (score/walkover), like the terminal', () => {
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

test('admin legalSlots: legal starts come from the gate\'s own rules (venue, feeder), the dragged match off the board', () => {
  const tjson = loadRepo(FIX('sample')).tournaments.get('sample').tjson;
  const ok = admin.legalSlots(tjson, 'md40', '9', '2025-07-14', 45);
  const c1 = new Set(ok['court-1']), c2 = new Set(ok['court-2']);
  assert(!c1.has(675), '11:15 on court-1 is its feeder md40/7\'s window — excluded');
  assert(c1.has(720), '12:00 clears the feeders (7/8 end at 12:00) and court-1 is free');
  assert(!c2.has(720) && !c2.has(765), '12:00/12:45 on court-2 collide with md40/10 (12:15, 45-min)');
  assert(c2.has(810), '13:30 on court-2 is past md40/10\'s window');
  const ok8 = admin.legalSlots(tjson, 'md40', '8', '2025-07-14', 45);
  assert.deepEqual(ok8['court-2'], [675], 'the semi\'s only legal start is 11:15 — the feeder floor, before its consumer 9');
});

test('admin pairBusy: the validators\' conflict kinds served to the preview — the same code the gate runs', () => {
  const { schedEntries, pairBusy } = require('../src/tools.js');
  const db = schedEntries(loadRepo(FIX('bad-player-doublebook')).tournaments.get('bad-player-doublebook').tjson).entries;
  assert.deepEqual(pairBusy(db[0], db[1]), ['player'], 'shared players in the same window, different courts');
  const ov = schedEntries(loadRepo(FIX('bad-venue-overlap')).tournaments.get('bad-venue-overlap').tjson).entries;
  assert.deepEqual(pairBusy(ov[0], ov[1]), ['venue'], 'same court in the same window');
  assert.deepEqual(pairBusy(db[0], ov[0]), [], 'disjoint windows conflict with nothing');
});
