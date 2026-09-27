'use strict';

// admin.js: unpushed / undo / redo — the pending list and the reset pair over
// that history. Run against a scratch git repo (see admin-helpers.js).

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const admin = require('../src/admin.js');
const { git, scratchWithRemote } = require('./admin-helpers.js');

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


test('admin undo/redo: redo restores exactly the undone commits, LIFO — tree clean, pending returns', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const m = id => loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(x => x.id === id);
    const score = id => admin.doEdit(state, 'result', 'md40', String(id), { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(score(8).ok, true, 'the semifinal scores');
    assert.equal(score(9).ok, true, 'the final scores on top (feeder 8 is now done)');
    assert.equal(admin.unpushed(tmp).commits.length, 2, 'two pending edits');
    assert.equal(admin.undo(state).error, undefined, 'undo drops the newest (md40/9)');
    assert(m(9).result === undefined && m(8).result !== undefined, 'only the newest edit is gone');
    assert.equal(admin.undo(state).error, undefined, 'second undo drops md40/8 too');
    assert(m(8).result === undefined, 'both edits undone');
    assert.equal(admin.redo(state).error, undefined, 'redo restores the last-undone first');
    assert(m(8).result !== undefined && m(9).result === undefined, 'LIFO: md40/8 back, md40/9 still gone');
    assert.equal(admin.redo(state).error, undefined, 'and the second redo restores md40/9');
    assert(m(9).result !== undefined, 'both edits back');
    assert.equal(admin.unpushed(tmp).commits.length, 2, 'the two commits are pending again');
    assert.equal(git(tmp, ['status', '--porcelain']).out.trim(), '', 'working tree clean through the round trip');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'snapshot validates after redo');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin undo: once the tip is on a remote ref, undo refuses — the fallback window never rewinds a pushed commit', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    git(tmp, ['checkout', '-qb', 'foo']); // a branch with no upstream — the @{upstream} window falls back to origin/main
    const score = admin.doEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(score.ok, true, 'the edit commits on the branch');
    const before = git(tmp, ['rev-parse', 'HEAD']).out.trim();
    assert.equal(admin.unpushed(tmp).commits.length, 1, 'one pending commit — undo is offered');
    const ok = admin.undo(state);
    assert(ok.sha, 'an unpushed commit undoes cleanly');
    git(tmp, ['reset', '--hard', before]).status; // put the commit back
    git(tmp, ['push', '-q', 'origin', 'foo']); // pushed without -u: origin/foo has the tip, no upstream, the fallback window still counts it
    const refused = admin.undo(state);
    assert(refused.error && /already pushed/.test(refused.error), `a remote-held tip refuses, got: ${refused.error}`);
    assert.equal(git(tmp, ['rev-parse', 'HEAD']).out.trim(), before, 'HEAD untouched by the refusal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin undo: an untracked file does not block undo — reset leaves it alone', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    fs.writeFileSync(path.join(tmp, 'results.csv'), 'scratch\n'); // untracked — a day-of export on the desktop
    assert.equal(admin.doEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] }).ok, true, 'the edit commits');
    const r = admin.undo(state);
    assert(r.sha, `undo runs with an untracked file present, got: ${r.error}`);
    assert(fs.existsSync(path.join(tmp, 'results.csv')), 'the untracked file survives the reset');
    assert.equal(admin.unpushed(tmp).commits.length, 0, 'the edit was rewound');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin redo: a daemon edit after the undo clears the stack — redo reports nothing', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    const score = id => admin.doEdit(state, 'result', 'md40', String(id), { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(score(8).ok, true, 'the edit lands');
    assert.equal(admin.undo(state).error, undefined, 'the edit is undone');
    assert.equal(score(8).ok, true, 're-scoring is a new edit on the undone state');
    assert.equal(admin.redo(state).error, 'nothing to redo', 'the committed edit cleared the stack — no redo across the divergence');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin redo: an out-of-band commit trips the parent guard and self-clears the stale stack', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    const m = id => loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(x => x.id === id);
    admin.doEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(admin.undo(state).error, undefined, 'the edit is undone');
    assert.equal(git(tmp, ['commit', '--allow-empty', '-qm', 'out-of-band']).status, 0, 'an out-of-band commit moves HEAD behind the daemon\'s back');
    const r1 = admin.redo(state);
    assert.equal(r1.error, 'nothing to redo — the branch moved on', 'the guard refuses — HEAD is no longer the undone commit\'s parent');
    assert(m(8).result === undefined, 'and nothing was reset');
    assert.equal(admin.redo(state).error, 'nothing to redo', 'the stale stack self-cleared');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin undo: a root commit (orphan branch) reports the ceiling, never git\'s raw error', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    // an orphan branch has one root commit with no parent — not on any remote,
    // so it counts as pending, but there is nothing to reset back to
    git(tmp, ['checkout', '-q', '--orphan', 'single']);
    git(tmp, ['add', '-A']);
    git(tmp, ['commit', '-qm', 'sole']);
    assert.equal(admin.unpushed(tmp).commits.length, 1, 'the root commit is pending against origin/main');
    const r = admin.undo(state);
    assert.equal(r.error, 'nothing to undo — the branch is at its first commit', `got: ${r.error}`);
    assert.equal(git(tmp, ['rev-parse', 'HEAD']).out.trim().length, 40, 'HEAD untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('admin unpushed: the undo window is the branch\'s own upstream — a pushed sim commit leaves it', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    git(tmp, ['checkout', '-qb', 'sim/sample-x']);
    git(tmp, ['commit', '--allow-empty', '-qm', 'chore(sim): scratch domain']);
    git(tmp, ['push', '-qu', 'origin', 'sim/sample-x']); // sim's own push -u — the sim gets its upstream
    assert.equal(admin.unpushed(tmp).commits.length, 0, 'a pushed sim commit is not pending — an origin/main..HEAD window would still count it');
    assert.equal(admin.undo(state).error, 'nothing to undo', 'undo refuses after the push — append-only holds on the sim branch too');
    admin.doEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(admin.unpushed(tmp).commits.length, 1, 'a fresh score is pending against the branch\'s own upstream');
    assert.equal(git(tmp, ['push']).status, 0, 'the bare push the daemon runs after an edit is clean — undo can never strand the branch behind its remote');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
