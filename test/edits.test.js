'use strict';

// edits.js: the edit engine — scoring eligibility, the shared grammar, edit
// applies, disk writes with validate-and-rollback, commit messages, and the
// funnel the admin daemon drives (execEdit).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');
const editor = require('../src/edits.js');
const { FIX, hasErr } = require('./helpers.js');

function md40Ctx(repo) {
  const tjson = repo.tournaments.get('sample').tjson;
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  return { tjson, matches, ctx: makeCat({ meta: tjson.categories.find(c => c.id === 'md40'), matches }, tjson) };
}

test('editor parsePayload: one grammar for the admin result field and score-wave', () => {
  assert.deepEqual(editor.parsePayload('result', ['21:19', '11:9'], 'UTC').value, { shape: 'score', games: [{ a: 21, b: 19 }, { a: 11, b: 9 }] });
  assert(editor.parsePayload('result', ['21x9'], 'UTC').err, 'a malformed game is refused');
  assert.deepEqual(editor.parsePayload('result', ['wo', 'b'], 'UTC').value, { shape: 'walkover', winner: 'b' }, 'the wo token names the winner');
  assert(editor.parsePayload('result', ['wo'], 'UTC').err, 'a side is required after wo');
  assert(editor.parsePayload('result', ['wo', 'c'], 'UTC').err, 'only a|b');
  assert(editor.parsePayload('result', ['wo', 'a', 'extra'], 'UTC').err, 'wo takes nothing else — trailing tokens refused');
  assert.deepEqual(editor.parsePayload('result', ['void'], 'UTC').value, { shape: 'void' }, 'the void token emits the void shape');
  assert(editor.parsePayload('result', ['void', 'a'], 'UTC').err, 'void takes nothing else');
  assert.deepEqual(editor.parsePayload('result', [], 'UTC').value, { shape: 'clear' }, 'an empty result entry clears');
  assert.equal(editor.parsePayload('venue', ['court-2'], 'UTC').value, 'court-2');
  assert.equal(editor.parsePayload('venue', [], 'UTC').value, undefined, 'an empty venue entry clears the court');
  assert.match(editor.parsePayload('time', ['10:30'], 'UTC').value, /T10:30:00$/);
  assert.equal(editor.parsePayload('time', [], 'UTC').value, undefined, 'an empty time entry unschedules');
  assert(editor.parsePayload('time', ['10:99'], 'UTC').err, 'impossible minutes refused');
  assert.match(editor.parsePayload('time', ['10:30'], 'Not/AZone').err, /bad timezone/, 'a well-formed time failing the default day names the timezone, not the time');
});

test('editor parsePayload: the result entry speaks dashes and colons alike — the display form leads', () => {
  assert.deepEqual(editor.parsePayload('result', ['21-19', '11:9'], 'UTC').value, { shape: 'score', games: [{ a: 21, b: 19 }, { a: 11, b: 9 }] }, 'dash and colon entries parse to the same games');
  assert(/expected a-b/.test(editor.parsePayload('result', ['21x9'], 'UTC').err), 'the error speaks the display form');
});

test('editor applyScore: games + a played result at the target, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  assert(editor.applyScore(matches, '7', [{ a: 11, b: 5 }], ctx) === null, 'applyScore reports no error');
  const m7 = matches.find(m => m.id === 7);
  assert(m7.games.length === 1 && m7.result.status === 'played' && m7.result.winner === 'a', 'target reached: result recorded, winner a');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('editor applyScore: a prefix (below target) stays in play — no result yet', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  assert(editor.applyScore(matches, '6', [{ a: 11, b: 5 }], ctx) === null, 'prefix reports no error');
  const m6 = matches.find(m => m.id === 6);
  assert(m6.games.length === 1 && m6.result === undefined, 'games only — the match is still in play (pool bestOf is 3)');
});

test('editor applyResult: walkover records a winner, void settles, games cleared', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches } = md40Ctx(repo);
  assert(editor.applyResult(matches, '2', 'walkover', 'b') === null, 'walkover reports no error');
  const m2 = matches.find(m => m.id === 2);
  assert(m2.result.status === 'walkover' && m2.result.winner === 'b' && m2.games === undefined, 'walkover names the winning side; games cleared');
  assert(editor.applyResult(matches, '3', 'walkover', 'a') === null, 'walkover reports no error');
  assert(matches.find(m => m.id === 3).result.status === 'walkover' && matches.find(m => m.id === 3).result.winner === 'a', 'walkover winner recorded');
  assert(editor.applyResult(matches, '4', 'void') === null, 'void reports no error');
  const m4 = matches.find(m => m.id === 4);
  assert(m4.result.status === 'void' && m4.result.winner === undefined && m4.games === undefined, 'void: settled, no winner');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('editor applyVenue: moves a match; unknown venue is rejected by the validator', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  assert(editor.applyVenue(matches, '2', 'court-2') === null, 'applyVenue reports no error');
  assert(matches.find(m => m.id === 2).venue === 'court-2', 'venue moved');
  assert(editor.applyVenue(matches, 'nope', 'court-2') === 'unknown match nope', 'unknown match reported');
  const repo2 = loadRepo(FIX('sample'));
  editor.applyVenue(repo2.tournaments.get('sample').tjson.matches.md40, '2', 'bogus-court');
  assert(hasErr(validateRepo(repo2), /unknown venue "bogus-court"/), 'undeclared venue rejected');
});

test('editor buildScheduled: builds local ISO-8601 wall time from hh:mm and timezone', () => {
  const r = editor.buildScheduled('09:00', 'America/New_York');
  assert(/^\d{4}-\d{2}-\d{2}T09:00:00$/.test(r), `expected local wall time, got ${r}`);
  const r2 = editor.buildScheduled('9:00', 'America/New_York');
  assert(r2.includes('T09:00:00'), 'single-digit hour pads to 09');
  assert(editor.buildScheduled('25:00', 'UTC') === null, 'bad hour returns null');
  assert(editor.buildScheduled('09:00', 'UTC', '2026-05-03') === '2026-05-03T09:00:00', 'an explicit date wins over today');
  assert(editor.buildScheduled('09:00', 'UTC', '2026-02-30') === '2026-02-30T09:00:00', 'a format-valid but impossible date passes — the validator gate rejects it on write');
  assert(editor.buildScheduled('09:00', 'Not/AZone') === null, 'an unreadable timezone can\'t compute the default day — never emit a nullT… scheduled string');
});

test('editor applyTime: sets scheduled field, repo validates', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  // 09:10 keeps the pool's last match at 11:15 — the feeder-timing gate stays closed
  assert(editor.applyTime(matches, '2', '2025-07-14T09:10:00') === null, 'applyTime reports no error');
  assert(matches.find(m => m.id === 2).scheduled === '2025-07-14T09:10:00', 'scheduled set');
  assert(editor.applyTime(matches, 'nope', '2025-07-14T09:10:00') === 'unknown match nope', 'unknown match reported');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
  assert(editor.applyTime(matches, '2', undefined) === null, 'clearing reports no error');
  assert(matches.find(m => m.id === 2).scheduled === undefined, 'scheduled dropped — the match is unscheduled');
  const { errs: errs2 } = validateRepo(repo);
  assert(errs2.length === 0, 'an unscheduled match still validates: ' + errs2.join('; '));
});

test('editor rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  editor.applyScore(matches, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }], ctx); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  editor.applyResult(repo2.tournaments.get('sample').tjson.matches.md40, '9', 'walkover', 'b'); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
});

test('editor writeEdit: a cross-day time edit is refused with the cause named; days-unchanged edits still apply', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('multiday'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const slug = 'multiday';
    const tjson = () => repo.tournaments.get(slug).tjson;
    const ms = () => tjson().matches.md40;
    const m = ms().find(x => x.id === 7); // day 2 (2026-07-12)
    const orig = m.scheduled;
    const edit = scheduled => editor.writeEdit(dataRoot, repo, slug, 'md40', list => {
      const t = list.find(x => x.id === m.id);
      if (scheduled === undefined) delete t.scheduled; else t.scheduled = scheduled;
      return null;
    });
    const cross = edit('2026-07-13T' + orig.slice(11));
    assert(cross.err && /changes the tournament's scheduled days \(2026-07-11, 2026-07-12 → 2026-07-11, 2026-07-12, 2026-07-13\)/.test(cross.err), `the refusal names the day change, got: ${cross.err}`);
    assert.equal(ms().find(x => x.id === 7).scheduled, orig, 'in-memory edit rolled back — a same-process retry starts from the original');
    assert.equal(loadRepo(dataRoot).tournaments.get(slug).tjson.matches.md40.find(x => x.id === 7).scheduled, orig, 'file untouched');
    const same = edit(undefined); // clear match 7's time — 8 and 9 still hold the day, so the day set is unchanged
    assert(!same.err && !same.errs, `a days-unchanged edit still applies, got: ${same.err || (same.errs || []).join('; ')}`);
    assert(loadRepo(dataRoot).tournaments.get(slug).tjson.matches.md40.find(x => x.id === 7).scheduled === undefined, 'the same-day clear landed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor parseGame', () => {
  assert(JSON.stringify(editor.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(JSON.stringify(editor.parseGame('11:9')) === JSON.stringify({ a: 11, b: 9 }), 'a:b parses');
  assert(editor.parseGame('11x9') === null, 'bad shape is null');
});

test('editor commitMessage: conventional types with tournament scope', () => {
  assert.equal(editor.commitMessage('score', '2026-mammut60', 'md40', '1', '11:9 · 11:7'), 'score(2026-mammut60): md40/1 11:9 · 11:7');
  assert.equal(editor.commitMessage('walkover', '2026-mammut60', 'xd', '7', 'side a wins by walkover'), 'walkover(2026-mammut60): xd/7 side a wins by walkover');
  assert.equal(editor.commitMessage('void', '2026-mammut60', 'xd', '7', 'void'), 'void(2026-mammut60): xd/7 void');
  assert.equal(editor.commitMessage('venue', '2026-mammut60', 'xd', '3', '→ court-2'), 'venue(2026-mammut60): xd/3 → court-2');
  assert.equal(editor.commitMessage('time', '2026-mammut60', 'md40', '1', '→ 2025-07-14T16:00:00-04:00'), 'time(2026-mammut60): md40/1 → 2025-07-14T16:00:00-04:00');
});

test('editor editDetail: venue/time edits report the move, never the match result', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches } = md40Ctx(repo);
  editor.applyResult(matches, '1', 'walkover', 'a'); // a decided match — the old bug mislabeled moves on these
  const m1 = matches.find(m => m.id === 1);
  m1.venue = 'court-2';
  assert.equal(editor.editDetail('venue', m1), '→ court-2', 'venue edit reports the venue on a decided match');
  m1.scheduled = '2025-07-14T16:00:00';
  assert.equal(editor.editDetail('time', m1), '→ 2025-07-14T16:00:00', 'time edit reports the time');
  assert.equal(editor.editDetail('result', m1, { shape: 'walkover', winner: 'a' }), 'side a wins by walkover', 'walkover detail from the result entry');
  assert.equal(editor.editDetail('result', {}, { shape: 'void' }), 'void', 'void detail');
  assert.equal(editor.editDetail('result', { games: [{ a: 21, b: 19 }, { a: 11, b: 5 }] }, { shape: 'score' }), '21-19 · 11-5', 'a score detail speaks dashes, mirroring the board column');
  assert.equal(editor.editDetail('result', {}, { shape: 'clear' }), '→ TBD', 'a clear returns the match to the board');
});

test('editor writeEdit: a cross-day edit is refused with the cause named — the index dates only change via the generator', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const res = editor.writeEdit(dataRoot, repo, 'sample', 'md40', (c) => editor.applyTime(c, '2', '2025-07-15T09:00:00'));
    assert(res.err && /changes the tournament's scheduled days \(2025-07-14 → 2025-07-14, 2025-07-15\)/.test(res.err), `the refusal names the day change, got: ${res.err}`);
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m2 = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 2);
    assert.equal(m2.scheduled, '2025-07-14T09:00:00', 'in-memory match restored for a same-process retry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor writeEdit/execEdit: an edit already on record writes and commits nothing — the unchange reports', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    // md40 8 already sits on court-2 — re-setting it changes nothing
    const noop = editor.writeEdit(dataRoot, repo, 'sample', 'md40', (c) => editor.applyVenue(c, '8', 'court-2'));
    assert(noop.unchanged && !noop.file, 'a byte-identical edit reports unchanged, writes nothing');
    assert(fs.readFileSync(file, 'utf8') === before, 'the file is untouched');
    // commit on a non-git tmp dir would fail loudly — the unchanged path must return before any git call
    const state = { root: tmp, siteRoot: dataRoot, repo, slug: 'sample' };
    const r = editor.execEdit(state, 'venue', 'md40', '8', 'court-2');
    assert.equal(r.unchanged, true, 'the no-op reports unchanged without a git call');
    assert(fs.readFileSync(file, 'utf8') === before, 'still nothing written');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor writeEdit: rollback on validation failure, write on success (real disk)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = editor.writeEdit(dataRoot, repo, 'sample', 'md40', (c, ctx) => editor.applyScore(c, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }], ctx));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 7);
    assert(m7mem.result.status === 'walkover' && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = editor.writeEdit(dataRoot, repo, 'sample', 'md40', (c, ctx) => editor.applyScore(c, '7', [{ a: 11, b: 5 }], ctx));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 7);
    assert(m7.games.length === 1 && m7.result.status === 'played' && m7.result.winner === 'a', 'games applied with a played result');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor parsePayload: the side op parses all three shapes — the a/b verb fixes the side', () => {
  const g = s => editor.parsePayload('side-a', s.trim().split(/\s+/), 'UTC', 0);
  const h = s => editor.parsePayload('side-b', s.trim().split(/\s+/), 'UTC', 0);
  assert.deepEqual(g('players p1 p2'), { value: { si: 0, side: { kind: 'players', ids: ['p1', 'p2'] } } }, 'players side');
  assert.deepEqual(h('pool A 2'), { value: { si: 1, side: { kind: 'pool', pool: 'A', rank: 2 } } }, 'the b verb picks side 1');
  assert.deepEqual(g('match 7 winner'), { value: { si: 0, side: { kind: 'match', match: 7, result: 'winner' } } }, 'match edge side');
  assert.match(g('players').err, /player ids/, 'players needs ids');
  assert.match(g('pool A').err, /pool and rank/, 'pool needs a rank');
  assert.match(g('pool A x').err, /positive integer/, 'rank must be a number');
  assert.match(g('match 7').err, /match id and result/, 'match edge needs a result');
  assert.match(g('match x winner').err, /match id/, 'match id must be a number');
  assert.match(g('match 7 maybe').err, /winner or loser/, 'result must be winner or loser');
  assert.match(g('frobnicate p1').err, /players, pool, or match/, 'unknown shape');
  assert.match(g('').err, /players, pool, or match/, 'empty payload names the shapes');
});

test('editor applySide: rewrites a side in place; the generic domain is the validator', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  const m7 = matches.find(m => m.id === 7); // QF — pool ranks A1/A4, still feeds 9 and 10
  editor.applySide(matches, '7', { si: 0, side: { kind: 'players', ids: ['p3', 'p4'] } });
  assert.deepEqual(m7.sides[0], { kind: 'players', ids: ['p3', 'p4'] }, 'side a rewritten to explicit players');
  assert.equal(validateRepo(repo).errs.length, 0, 'a direct-entry QF still validates: ' + validateRepo(repo).errs.join('; '));
  // the gate rejects what the grammar can't see — fresh repo per case
  const reject = (fn, re) => {
    const r = loadRepo(FIX('sample'));
    fn(r.tournaments.get('sample').tjson.matches.md40);
    assert(hasErr(validateRepo(r), re), `expected rejection: ${re}`);
  };
  reject(ms => editor.applySide(ms, '7', { si: 0, side: { kind: 'players', ids: ['nobody'] } }), /unknown player/);
  reject(ms => editor.applySide(ms, '7', { si: 0, side: { kind: 'match', match: 8, result: 'winner' } }), /consumed twice/);
  reject(ms => editor.applySide(ms, '7', { si: 0, side: { kind: 'pool', pool: 'A', rank: 99 } }), /out of range/);
  reject(ms => editor.applySide(ms, '7', { si: 0, side: { kind: 'pool', pool: 'X', rank: 1 } }), /unknown pool/);
  // re-seating the final orphans the semifinals' winner edges — two unfed roots
  reject(ms => editor.applySide(ms, '9', { si: 0, side: { kind: 'players', ids: ['p1', 'p2'] } }), /exactly one championship final/);
});

test('editor applyVenue: - unschedules the court', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  assert(editor.applyVenue(matches, '2', undefined) === null, 'clearing reports no error');
  assert(matches.find(m => m.id === 2).venue === undefined, 'venue dropped — the match is courtless');
  assert(validateRepo(repo).errs.length === 0, 'a courtless match still validates: ' + validateRepo(repo).errs.join('; '));
});

test('editor feeder timing: a time edit can\'t schedule a bracket before its feeders or past its consumers', () => {
  const applyAt = (id, hhmm) => {
    const repo = loadRepo(FIX('sample'));
    editor.applyTime(repo.tournaments.get('sample').tjson.matches.md40, String(id), `2025-07-14T${hhmm}:00`);
    return validateRepo(repo);
  };
  // m9 (12:15, fed by m7/m8 ending 12:00) moved to 11:00 — before its feeders
  assert(hasErr(applyAt(9, '11:00'), /starts before its feeders end/), 'a bracket before its feeders is rejected');
  assert(applyAt(9, '12:00').errs.length === 0, 'exactly at the feeder end is fine: ' + applyAt(9, '12:00').errs.join('; '));
  // m8 moved to 11:45 — its slot ends 12:30, after m9 starts at 12:15
  assert(hasErr(applyAt(8, '11:45'), /ends after a match it feeds starts/), 'a feeder past its consumer is rejected');
  // m8 moved to 11:00 — before its pool (A2/A3) finishes at 11:15
  assert(hasErr(applyAt(8, '11:00'), /starts before its feeders end/), 'a slot before its pool ends is rejected');
  assert(applyAt(8, '11:15').errs.length === 0, 'exactly at the pool end is fine: ' + applyAt(8, '11:15').errs.join('; '));
});

test('editor editDetail: the side op reports the applied slot label; a cleared venue reports TBD', () => {
  const repo = loadRepo(FIX('sample'));
  const { ctx } = md40Ctx(repo);
  const m9 = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 9);
  const d = editor.editDetail('side-a', m9, { si: 0, side: { kind: 'match', match: 8, result: 'winner' } }, ctx);
  assert(/^side a → Winner of /.test(d), `expected the applied slot label, got ${d}`);
  const m = repo.tournaments.get('sample').tjson.matches.xd.find(x => x.id === 1);
  assert.equal(editor.editDetail('venue', m), '→ court-1', 'a venue edit on an undecided match reports the court');
  assert.equal(editor.editDetail('side-b', m9, { si: 1, side: { kind: 'players', ids: ['p1', 'p2'] } }, ctx), 'side b → Ada Lovelace / Grace Hopper', 'a players side labels the team');
  const done = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 1);
  const d2 = editor.editDetail('side-a', done, { si: 0, side: { kind: 'players', ids: ['p3', 'p4'] } }, ctx);
  assert(/result kept/.test(d2), 'a side op on a decided match flags the kept result — history never reads as a silent rewrite');
});
