'use strict';

// admin.js: the localhost admin daemon's write funnel — doEdit (validate →
// write → commit, one path for every verb the page sends), undo/redo (the
// reset pair over that history) and unpushed (the pending list). Run against a
// scratch git repo so the commit path is real; the real repo is never touched
// (same rule as every suite here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const admin = require('../src/admin.js');
const publish = require('../src/publish.js');
const { FIX } = require('./helpers.js');

const git = (root, args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return { ...r, out: r.stdout || '' }; };
// the admin daemon's own git() renames stdout → out; the helper aliases it so
// tests read the same shape the daemon does

// A scratch repo: site copy from the sample fixture + git, with an origin so
// unpushed() can see a base to measure against (the real deployment shape).
// main is pushed without -u, so the daemon's @{upstream} window falls back to
// origin/main here — exactly the shape a director's own clone has.
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
  return { tmp, siteRoot, state: { root: tmp, siteRoot, repo, slug: 'sample', redo: [] } };
}

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

test('admin legalSlots: a pool match cannot push its pool past a rank-consumer\'s start — the ghost respects the consumers\' gate bounds', () => {
  const tjson = loadRepo(FIX('sample')).tournaments.get('sample').tjson;
  // md40/1 is a pool-A match; the QFs 7/8 hold pool-A rank slots at 11:15 and
  // gate the pool's last scheduled end there — no start may end later, on any
  // court (the QF holds no venue in common; only the pool end binds it)
  const ok = admin.legalSlots(tjson, 'md40', '1', '2025-07-14', 15);
  for (const v of ['court-1', 'court-2']) {
    assert(ok[v].every(wm => wm + 45 <= 675), `${v}: every pool-A start must end by the consumers' 11:15 start`);
  }
  assert(ok['court-1'].includes(450), 'a free morning slot is still offered');
});

test('admin legalSlots: the overlap window is the dragged match\'s own slotMinutes — a category default can\'t undersize it', () => {
  const tjson = loadRepo(FIX('bad-slot-overlap')).tournaments.get('bad-slot-overlap').tjson;
  // t/1 is a 60-minute pool match and t/2 (09:50-10:50, same court) shares the
  // 60-minute groups default; the candidate must be sized from the real match
  // — a default-less `{ venue }` window would make the overlap test vacuous
  const ok = admin.legalSlots(tjson, 't', '1', '2025-07-14', 15);
  const c1 = new Set(ok['court-1']);
  for (const wm of [540, 555, 570, 585, 600, 615, 630, 645]) {
    assert(!c1.has(wm), `tick ${wm} collides with t/2's 09:50-10:50 window`);
  }
  assert(c1.has(660), '11:00 clears t/2 and is offered');
});

test('admin legalSlots: a match without sides never throws — the daemon reports, the preview offers nothing', () => {
  const tjson = loadRepo(FIX('bad-pool-missing-sides')).tournaments.get('bad-pool-missing-sides').tjson;
  assert.deepEqual(admin.legalSlots(tjson, 't', '2', '2026-05-02', 30), {}, 'sides-less match 2 gets no offers and no crash');
});

test('admin pairBusy: the validators\' conflict kinds served to the preview — the same code the gate runs', () => {
  const { schedEntries, pairBusy } = require('../src/tools.js');
  const db = schedEntries(loadRepo(FIX('bad-player-doublebook')).tournaments.get('bad-player-doublebook').tjson).entries;
  assert.deepEqual(pairBusy(db[0], db[1]), ['player'], 'shared players in the same window, different courts');
  const ov = schedEntries(loadRepo(FIX('bad-venue-overlap')).tournaments.get('bad-venue-overlap').tjson).entries;
  assert.deepEqual(pairBusy(ov[0], ov[1]), ['venue'], 'same court in the same window');
  assert.deepEqual(pairBusy(db[0], ov[0]), [], 'disjoint windows conflict with nothing');
});

test('admin sideOpts: the picker greys what the gate would reject — consumed slots, cycle feeders, busy players', () => {
  // an in-memory mini tournament: pool A, then a knockout chain 3→4→5
  const tjson = {
    name: 'T', location: 'L', timezone: 'UTC', dates: ['2026-01-01'],
    venues: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }],
    categories: [{ id: 'md', name: 'MD', bestOf: { groups: 3, knockout: 3 }, slotMinutes: { groups: 30, knockout: 30 } }],
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }, { id: 'p4', name: 'Four' }],
    matches: { md: [
      { id: 1, pool: 'A', scheduled: '2026-01-01T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1', 'p2'] }, { kind: 'players', ids: ['p3', 'p4'] }] },
      { id: 2, pool: 'A', scheduled: '2026-01-01T09:00:00', venue: 'c2', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p3'] }] }, // p1 overlaps match 1
      { id: 3, scheduled: '2026-01-01T11:00:00', venue: 'c1', sides: [{ kind: 'pool', pool: 'A', rank: 1 }, { kind: 'pool', pool: 'A', rank: 2 }] },
      { id: 4, scheduled: '2026-01-01T12:00:00', venue: 'c1', sides: [{ kind: 'match', match: 3, result: 'winner' }, { kind: 'match', match: 3, result: 'loser' }] },
      { id: 5, scheduled: '2026-01-01T13:00:00', venue: 'c1', sides: [{ kind: 'match', match: 4, result: 'winner' }, { kind: 'pool', pool: 'A', rank: 3 }] },
      { id: 6, sides: [{ kind: 'players', ids: ['p2'] }, { kind: 'players', ids: ['p3'] }] }, // unscheduled: nothing is busy
      { id: 7, pool: 'A', scheduled: '2026-01-01T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p2'] }, { kind: 'players', ids: ['p4'] }] }, // overlaps match 2, shares no player with it
    ] },
  };
  // editing m5 side a (currently 4:winner): that slot is freed, the pool rank on its own side b stays taken
  const a5 = admin.sideOpts(tjson, 'md', 5, 0);
  assert(!a5.consumedEdges.includes('4:winner'), 'the edited side frees its own slot');
  assert(a5.consumedEdges.includes('3:winner') && a5.consumedEdges.includes('3:loser'), 'm4 still consumes 3\'s edges');
  assert(a5.consumedRanks.includes('pool:A:3'), 'the other side of m5 still takes pool A rank 3');
  assert.deepEqual(a5.descendants, [], 'nothing depends on m5 yet');
  // editing m4 side a: 3:winner freed; m5 consumes 4:winner, and m5 is downstream of m4 — a cycle if m4 fed it
  const a4 = admin.sideOpts(tjson, 'md', 4, 0);
  assert(a4.consumedEdges.includes('4:winner'), 'm5 takes 4:winner, so it stays greyed');
  assert.deepEqual(a4.descendants, [5], 'm5 depends on m4 — feeding m4 into m5 would close a cycle');
  // busy: a player is busy when they're in any overlapping scheduled match —
  // even on another venue with no shared player with the edited side
  const busy2 = admin.sideOpts(tjson, 'md', 2, 0).busy;
  assert(busy2.includes('p1'), 'p1 is in the overlapping match 1 — busy');
  assert(busy2.includes('p2'), 'p2 is in match 7, which overlaps match 2 but shares no player with it — still busy');
  assert.deepEqual(admin.sideOpts(tjson, 'md', 6, 0).busy, [], 'an unscheduled match has no window — no player is busy yet');
  // an unknown match reports nothing, never throws — same as legalSlots
  assert.deepEqual(admin.sideOpts(tjson, 'md', 999, 0), {});
});

// ---- the sim surface: score-wave (off-main only) and the deploy gate ----
// (both are branch-role decisions; the scratch repo with an origin makes the
// branch, the anchor, and the CNAME all real)

test('admin scoreWave: on main it refuses — random scores never reach the record', () => {
  const { tmp, state } = scratchWithRemote();
  try {
    const r = admin.scoreWave(state);
    assert.equal(r.ok, false, 'main refuses');
    assert(/sim branch/.test(r.error), 'the refusal names the requirement');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('admin scoreWave: off main scores the playable wave through the real funnel — every edit commits', () => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  try {
    git(tmp, ['checkout', '-qb', 'sim/sample-x']);
    const r = admin.scoreWave(state);
    assert.equal(r.ok, true, 'a sim branch scores');
    assert(r.scored > 0, 'the sample opening wave scores at least one match');
    assert(validateRepo(loadRepo(siteRoot)).errs.length === 0, 'the sim repo still validates');
    assert(admin.unpushed(tmp).commits.length >= r.scored, 'every scored match commits — the branch is the record');
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

const PROD = 'bracket.surge.sh';
// the deploy role's anchor is origin/main's CNAME — stage + commit + push it, or the anchor never exists
const anchorCNAME = (root, siteRoot) => {
  fs.writeFileSync(path.join(siteRoot, 'CNAME'), PROD + '\n');
  git(root, ['add', 'site/CNAME']);
  git(root, ['commit', '-qm', 'cname']);
  git(root, ['push', '-q', 'origin', 'main']);
};

test('publish deployRole: main ships production, refuses any other CNAME', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    assert.deepEqual(publish.deployRole(tmp), { ok: true, domain: PROD }, 'main ships its production CNAME');
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), 'bracket-sim-x.surge.sh\n'); // uncommitted — the role reads the file, not the tree
    const r = publish.deployRole(tmp);
    assert.equal(r.ok, false, 'a scratch CNAME on main is refused');
    assert(/not the production domain/.test(r.why), 'the refusal names the mismatch');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish deployRole: off main ships only its own scratch CNAME, never production', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    git(tmp, ['checkout', '-qb', 'sim/sample-x']);
    assert.equal(publish.deployRole(tmp).ok, false, 'a branch still carrying production is refused');
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), 'bracket-sim-x.surge.sh\n');
    assert.deepEqual(publish.deployRole(tmp), { ok: true, domain: 'bracket-sim-x.surge.sh' }, 'its own scratch domain ships');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish deployRole: no origin/main anchor — a branch cannot prove itself scratch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbpub-'));
  try {
    const siteRoot = path.join(tmp, 'site');
    fs.mkdirSync(siteRoot, { recursive: true });
    fs.cpSync(FIX('sample'), siteRoot, { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), PROD + '\n');
    git(tmp, ['init', '-q']);
    git(tmp, ['config', 'user.email', 't@t']);
    git(tmp, ['config', 'user.name', 'test']);
    git(tmp, ['add', '-A']);
    git(tmp, ['commit', '-qm', 'init']);
    git(tmp, ['branch', '-M', 'main']); // never pushed — no origin/main
    assert.deepEqual(publish.deployRole(tmp), { ok: true, domain: PROD }, 'fresh main deploys what its CNAME says (bootstrap)');
    git(tmp, ['checkout', '-qb', 'sim/x']);
    const r = publish.deployRole(tmp);
    assert.equal(r.ok, false, 'without the anchor a branch cannot prove its domain is scratch');
    assert(/origin\/main/.test(r.why), 'the refusal names the missing anchor');
    git(tmp, ['checkout', '-q', 'main']);
    git(tmp, ['checkout', '-q', '--detach']);
    assert.equal(publish.deployRole(tmp).ok, false, 'a detached HEAD never ships');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
