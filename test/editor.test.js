'use strict';

// editor.js: the match-day editor (buffer, filter, state machine), scoring
// eligibility, edits, command parsing, commit messages, disk writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');
const editor = require('../src/editor.js');
const { FIX, hasErr } = require('./helpers.js');

function md40Ctx(repo) {
  const tjson = repo.tournaments.get('sample').tjson;
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  return { tjson, matches, ctx: makeCat({ meta: tjson.categories.find(c => c.id === 'md40'), matches }, tjson) };
}

// the editor keys — { ch, name, ctrl } is what step consumes
const key = (ch, name) => ({ ch: ch || null, name: name || null, ctrl: false });
// the sample's one playable match (deterministic — no wall clock in tests)
const WAVE = new Set(['md40 8']);
const viewOf = (repo, playable, query) => editor.makeView(repo.tournaments.get('sample').tjson, playable, query);
const rkey = r => editor.rowKey(r.cat, r.m);

// ---------- the editor ----------

test('editor buildRows: one flat buffer, time order, tie-break cat then id, TBD last', () => {
  const repo = loadRepo(FIX('sample'));
  const rows = editor.buildRows(repo.tournaments.get('sample').tjson, WAVE);
  assert.equal(rows.length, 16, 'md40 10 + xd 6 — the whole day is one list');
  assert.equal(rkey(rows[0]), 'md40 1', 'the 09:00 opener leads');
  assert.equal(rkey(rows[1]), 'md40 2', 'same minute, same category: id order');
  const idx = rows.findIndex(r => r.m.id === 8);
  assert(rows[idx].playable, 'the ▶ flag comes from the injected playable set');
  assert(!rows.find(r => r.m.id === 1).playable, 'unlisted matches are not flagged');
  const copy = repo.tournaments.get('sample').tjson;
  copy.matches.md40.find(m => m.id === 9).scheduled = undefined;
  const rows2 = editor.buildRows(copy, WAVE);
  assert.equal(rows2[rows2.length - 1].m.id, 9, 'an unscheduled match goes last, still editable');
});

test('editor makeView: / filters the rendered lines — names, refs, venues — case-insensitively', () => {
  const repo = loadRepo(FIX('sample'));
  const byName = editor.makeView(repo.tournaments.get('sample').tjson, WAVE, 'ada');
  assert(byName.filtered.length > 0, 'a player name narrows the day');
  const vc = editor.makeView(repo.tournaments.get('sample').tjson, WAVE, 'COURT-2');
  assert(vc.filtered.length > 0 && vc.filtered.every(e => e.r.m.venue === 'court-2'), 'venues filter, case-blind');
  const vRef = editor.makeView(repo.tournaments.get('sample').tjson, WAVE, 'md40 9');
  assert.equal(vRef.filtered.length, 1, 'the ref pins the one match (md40 10 does not match md40 9)');
  assert.equal(editor.makeView(repo.tournaments.get('sample').tjson, WAVE, 'zzz').filtered.length, 0, 'a miss is an empty view, never an error');
  assert.equal(editor.makeView(repo.tournaments.get('sample').tjson, WAVE, null).filtered.length, 16, 'no query = the whole day');
});

test('editor step: j/k walk, g/G jump, clamped at the ends', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: null, msg: null };
  let r = editor.step(s, key('j'), view);
  assert.equal(r.state.cursorId, 'md40 2', 'the first j steps into the list — the cursor starts at the top row');
  for (let i = 0; i < 4; i++) r = editor.step(r.state, key('j'), view);
  assert.equal(r.state.cursorId, 'md40 6', 'j walks down in id order');
  r = editor.step(r.state, key('k'), view);
  assert.equal(r.state.cursorId, 'md40 5', 'k walks back up');
  r = editor.step(r.state, key('G'), view);
  assert.equal(r.state.cursorId, 'xd 6', 'G bottoms out');
  r = editor.step(r.state, key('j'), view);
  assert.equal(r.state.cursorId, 'xd 6', 'j clamps at the last row');
  r = editor.step(r.state, key('g'), view);
  assert.equal(r.state.cursorId, 'md40 1', 'g tops out');
});

test('editor step: n/N jump between the ▶-flagged rows', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 1', msg: null };
  let r = editor.step(s, key('n'), view);
  assert.equal(r.state.cursorId, 'md40 8', 'n lands on the playable match');
  r = editor.step(r.state, key('N'), view);
  assert.equal(r.state.cursorId, 'md40 8', 'nothing playable before it — N stays');
});

test('editor step: / narrows live, Enter keeps it, Esc clears it', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: null, msg: null };
  let r = editor.step(s, key('/'), view);
  assert.equal(r.state.mode, 'filter', '/ opens the filter input');
  for (const c of ['c', 'o', 'u']) r = editor.step(r.state, key(c), view);
  assert.equal(r.state.query, 'cou', 'typed chars accumulate');
  r = editor.step(r.state, key(null, 'return'), view);
  assert.equal(r.state.mode, 'browse');
  assert.equal(r.state.query, 'cou', 'Enter keeps the filter applied');
  r = editor.step(r.state, key(null, 'escape'), view);
  assert.equal(r.state.query, null, 'Esc in browse clears the applied filter too');
});

test('editor step: x is an ordinary character in the filter input — never a sim score', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: null, msg: null };
  s = editor.step(s, key('/'), view).state;
  const r = editor.step(s, key('x'), view);
  assert.equal(r.state.mode, 'filter', 'still filtering, not scored');
  assert.equal(r.state.query, 'x', 'x types into the query — /xd narrows, it does not score');
});

test('editor step: Enter on a decided match prefills the outcome on record', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 1', msg: null }; // md40 1 is played 11-9 11-7
  let r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.mode, 'arm', 'Enter arms the result entry');
  assert.equal(r.state.verb, 'result');
  assert.equal(r.state.payload, '11-9 11-7', 'the recorded games prefill — append or amend, Enter on it round-trips');
  r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, '11-9 11-7', 're-arming is unchanged — a decided row always prefills, never clears');
});

test('editor step: Enter arms the cursor line; payload + Enter emits the exact edit', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 9', msg: null };
  let r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.mode, 'arm', 'Enter arms the result entry');
  assert.equal(r.state.payload, '', 'an unscored match arms empty');
  for (const c of '21:19'.split('')) r = editor.step(r.state, key(c), view);
  assert.equal(r.state.payload, '21:19', 'payload accumulates');
  r = editor.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'result', cat: 'md40', matchId: '9', value: { shape: 'score', games: [{ a: 21, b: 19 }] } }, 'enter emits the edit with the score shape');
  assert.equal(r.state.mode, 'browse', 'back to browse, unarmed');
});

test('editor step: an empty result Enter clears — Enter-Enter on an unplayed row is a no-op, never an error', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 9', msg: null }; // unscored, unplayed
  let r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, '', 'an unplayed match arms empty');
  r = editor.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'result', cat: 'md40', matchId: '9', value: { shape: 'clear' } }, 'empty commits a clear — applied to nothing here');
  assert.equal(r.state.msg, null, 'no error — the read-only Enter-Enter rhythm is quiet');
});

test('editor step: a bad payload stays armed with the error — never writes', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, '11-7', 're-scoring md40 8 prefills its one game on record');
  r = editor.step(r.state, key('x'), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert(r.action === null, 'no action on a bad score');
  assert.equal(r.state.mode, 'arm', 'still armed');
  assert.equal(r.state.payload, '11-7x', 'payload kept for retype — the prefill rides along');
  assert(r.state.msg && /bad score/.test(r.state.msg.text), 'the error names the token');
});

test('editor step: Esc cancels an arm without touching anything', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = editor.step(s, key('t'), view);
  r = editor.step(r.state, key('1'), view);
  r = editor.step(r.state, key(null, 'escape'), view);
  assert.equal(r.state.mode, 'browse');
  assert.equal(r.state.verb, null, 'esc unarms the time verb too');
});

test('editor step: the result entry spells void — wo a and void are tokens, empty clears', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, '11-7', 're-scoring md40 8 prefills its one game on record');
  r = editor.step(r.state, { ch: null, name: 'u', ctrl: true }, view); // drop the prefill
  for (const c of 'void'.split('')) r = editor.step(r.state, key(c), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'result', cat: 'md40', matchId: '8', value: { shape: 'void' } }, 'the void token emits the void shape');
  s = { mode: 'browse', cursorId: 'md40 7', msg: null }; // walkover-decided, prefill wo a
  r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, 'wo a', 'a walkover row prefills its outcome');
  r = editor.step(r.state, { ch: null, name: 'u', ctrl: true }, view);
  for (const c of 'wo b'.split('')) r = editor.step(r.state, key(c), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action.value, { shape: 'walkover', winner: 'b' }, 'the walkover override emits the walkover shape');
  s = { mode: 'browse', cursorId: 'md40 6', msg: null }; // played — clear via ^U then empty Enter
  r = editor.step(s, key(null, 'return'), view);
  assert.equal(r.state.payload, '9-11 11-9 11-6', 'played matches prefill all their games');
});

test('editor step: :score is gone — the edit verbs are single keys on the line', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let r = editor.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  for (const c of 'score md40 8 21:19'.split('')) r = editor.step(r.state, key(c), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert(r.action === null, 'no action — the colon grammar has no edit verbs');
  assert(r.state.msg && /unknown command/.test(r.state.msg.text), ':score answers unknown, never executes');
  assert(!/usage/.test(r.state.msg.text), 'and no usage line for a grammar that no longer exists');
});

test('editor step: bare q quits; :q and typos get a hint, never a write', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let r = editor.step({ mode: 'browse', cursorId: null, msg: null }, key('q'), view);
  assert.equal(r.state.quit, true, 'bare q quits');
  r = editor.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  r = editor.step(r.state, key('q'), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert(!r.state.quit, ':q is not a command — q already quits');
  assert(r.state.msg && /unknown command/.test(r.state.msg.text), ':q answers unknown, never quits');
  r = editor.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  for (const c of 'frobnicate'.split('')) r = editor.step(r.state, key(c), view);
  r = editor.step(r.state, key(null, 'return'), view);
  assert(r.state.msg && /unknown command/.test(r.state.msg.text), 'typos answer with ? for help');
});

test('editor parsePayload: one grammar for the arm line and the sim', () => {
  assert.deepEqual(editor.parsePayload('result', ['21:19', '11:9'], 'UTC').value, { shape: 'score', games: [{ a: 21, b: 19 }, { a: 11, b: 9 }] });
  assert(editor.parsePayload('result', ['21x9'], 'UTC').err, 'a malformed game is refused');
  assert.deepEqual(editor.parsePayload('result', ['wo', 'b'], 'UTC').value, { shape: 'walkover', winner: 'b' }, 'the wo token names the winner');
  assert(editor.parsePayload('result', ['wo'], 'UTC').err, 'a side is required after wo');
  assert(editor.parsePayload('result', ['wo', 'c'], 'UTC').err, 'only a|b');
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

test('editor execAction: :use refuses a broken or unknown tournament, lists at bare use', () => {
  const repo = loadRepo(FIX('bad-null-tjson'));
  assert.equal(editor.defaultSlug(repo), null, 'auto-select skips a tournament whose file is null');
  const state = { repo, slug: null };
  let r = editor.execAction(state, { kind: 'use', slug: 'bad-null-tjson' });
  assert(r.msg && /no readable data/.test(r.msg.text), 'a broken tournament is refused');
  assert.equal(state.slug, null, 'a refused use never changes the selection');
  r = editor.execAction(state, { kind: 'use', slug: 'nope' });
  assert(r.msg && /unknown tournament/.test(r.msg.text), 'an unknown slug is refused');
  r = editor.execAction({ repo: loadRepo(FIX('sample')), slug: 'sample' }, { kind: 'use', slug: '' });
  assert(r.msg && /tournaments:/.test(r.msg.text), 'bare use lists them');
  r = editor.execAction({ repo: loadRepo(FIX('sample')), slug: 'md40' }, { kind: 'use', slug: 'sample' });
  assert.equal(r.slug, 'sample', 'a good use returns the new slug');
});

test('editor execEdit: commit=false writes the scratch copy, validates, echoes the sim receipt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const state = { root: tmp, siteRoot: dataRoot, repo, slug: 'sample', commit: false };
    const r = editor.execEdit(state, 'result', 'md40', '8', { shape: 'score', games: [{ a: 11, b: 5 }, { a: 11, b: 3 }] });
    assert.equal(r.color, 'green');
    assert(/\[sim\]/.test(r.text), 'the sim receipt marks the scratch write');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'the scratch copy still validates');
    const m8 = reread.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8.result.status === 'played' && m8.result.winner === 'a', 'games applied with a result');
    const bad = editor.execEdit(state, 'venue', 'md40', '8', 'bogus-court');
    assert.equal(bad.color, 'red');
    assert(/rolled back/.test(bad.text), 'a validator refusal reports the rollback');
    assert(loadRepo(dataRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8).venue === 'court-2', 'the venue rolls back to the original court');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('editor parseGame', () => {
  assert(JSON.stringify(editor.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(JSON.stringify(editor.parseGame('11:9')) === JSON.stringify({ a: 11, b: 9 }), 'a:b parses');
  assert(editor.parseGame('11x9') === null, 'bad shape is null');
});

test('editor parseCmd: the : grammar holds only what single keys cannot', () => {
  assert.deepEqual(editor.parseCmd('/publish'), { kind: 'publish', args: [] });
  assert.deepEqual(editor.parseCmd('use sample'), { kind: 'use', args: ['sample'] });
  assert.deepEqual(editor.parseCmd('status'), { kind: 'status', args: [] });
  for (const gone of ['score', 'wo', 'void', 'venue', 'time', 'ls', 'next', 'help', 'q', 'quit']) {
    assert.equal(editor.parseCmd(`/${gone}`).kind, 'unknown', `${gone} has a single-key twin`);
  }
  assert.equal(editor.parseCmd('cd md40').kind, 'unknown', 'cd is gone — use selects the tournament');
  assert.equal(editor.parseCmd('pull').kind, 'unknown', 'pull is gone — leave it to the shell');
});

test('editor execAction: sim mode refuses :publish — the scratch never ships', () => {
  const repo = loadRepo(FIX('sample'));
  const r = editor.execAction({ repo, slug: 'sample', commit: false }, { kind: 'publish' });
  assert(r.msg && /sim: no publish/.test(r.msg.text), 'the sim answers with the scratch contract, never a deploy');
  assert.equal(r.slug, undefined, 'the refusal leaves the selection untouched');
});

test('editor prefillFor: the current value on record, canonical — a date shows only when a bare hh:mm would move it', () => {
  const tz = 'America/New_York';
  const now = Date.parse('2025-07-14T16:00:00Z'); // 12:00 EDT — dayKey is the stored day
  const m = { scheduled: '2025-07-14T11:15:00', venue: 'court-2', games: [{ a: 11, b: 7 }], result: { status: 'walkover', winner: 'a' }, sides: [{ kind: 'pool', pool: 'A', rank: 1 }, { kind: 'match', match: 8, result: 'winner' }] };
  assert.equal(editor.prefillFor('time', m, tz, now), '11:15', 'a stored date equal to the derived day drops the date — Enter round-trips on the same bytes');
  assert.equal(editor.prefillFor('time', { scheduled: '2025-07-15T11:15:00' }, tz, now), '2025-07-15 11:15', 'a different stored date is shown, or Enter would silently move the match');
  assert.equal(editor.prefillFor('time', {}, tz, now), '', 'no schedule arms empty');
  assert.equal(editor.prefillFor('venue', m, tz, now), 'court-2', 'venue prefills as stored');
  assert.equal(editor.prefillFor('venue', {}, tz, now), '', 'a courtless match arms empty');
  assert.equal(editor.prefillFor('result', m, tz, now), '11-7', 'a played outcome prefills its games, dashes — the display form parses back');
  assert.equal(editor.prefillFor('result', { result: { status: 'walkover', winner: 'a' } }, tz, now), 'wo a', 'a walkover prefills its spelled outcome');
  assert.equal(editor.prefillFor('result', { result: { status: 'void' } }, tz, now), 'void', 'a void prefills the void token');
  assert.equal(editor.prefillFor('result', {}, tz, now), '', 'an undecided match arms empty');
  assert.equal(editor.prefillFor('side-a', m, tz, now), 'pool A 1', 'side a prefills its stored slot');
  assert.equal(editor.prefillFor('side-b', m, tz, now), 'match 8 winner', 'side b prefills its stored slot');
});

test('editor step: a and b arm the side verb for that side; Enter emits the fixed side', () => {
  const repo = loadRepo(FIX('sample'));
  const view = viewOf(repo, WAVE, null);
  let r = editor.step({ mode: 'browse', cursorId: 'md40 7', msg: null }, key('a'), view);
  assert.equal(r.state.verb, 'side-a', 'a arms side a');
  assert.equal(r.state.payload, 'pool A 1', 'the stored slot prefills — amend the slot, not the whole line');
  r = editor.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'side-a', cat: 'md40', matchId: '7', value: { si: 0, side: { kind: 'pool', pool: 'A', rank: 1 } } }, 'Enter emits the a-side edit');
  r = editor.step({ mode: 'browse', cursorId: 'md40 7', msg: null }, key('b'), view);
  assert.equal(r.state.payload, 'pool A 4', 'b prefills the other side');
  r = editor.step({ mode: 'browse', cursorId: 'md40 7', msg: null }, key(null, 'return'), view);
  assert.equal(r.state.payload, 'wo a', 'a walkover result prefills the spelled outcome');
});

test('editor step: the arm field edits at the caret — typing inserts, ⌫ deletes before it, ←/→ move, ^U kills', () => {
  const repo = loadRepo(FIX('sample'));
  const view = viewOf(repo, WAVE, null);
  let r = editor.step({ mode: 'browse', cursorId: 'md40 8', msg: null }, key('a'), view);
  assert.equal(r.state.payload, 'pool A 2', 'side a prefills the stored slot');
  assert.equal(r.state.pos, 'pool A 2'.length, 'the caret arms at the end of the prefill');
  r = editor.step(r.state, key(null, 'left'), view);
  r = editor.step(r.state, key('9'), view);
  assert.equal(r.state.payload, 'pool A 92', 'a typed char inserts at the caret, not the end');
  r = editor.step(r.state, key(null, 'backspace'), view);
  assert.equal(r.state.payload, 'pool A 2', '⌫ deletes before the caret — the prefill round-trips again');
  // ^U kills from the caret to the field's start (readline): mid-field the tail stays,
  // from the end the whole prefill goes — one stroke to clear and retype
  r = editor.step(r.state, { ch: null, name: 'u', ctrl: true }, view);
  assert.equal(r.state.payload, '2', '^U leaves the tail after the caret');
  r = editor.step(r.state, key(null, 'right'), view);
  r = editor.step(r.state, { ch: null, name: 'u', ctrl: true }, view);
  assert.equal(r.state.payload, '', '^U at the end clears the field — replace a prefill in one stroke');
});

test('editor step: readline goodies — home/end, ^A/^E, ^K, ^W, and delete edit the arm field at the caret', () => {
  const repo = loadRepo(FIX('sample'));
  const view = viewOf(repo, WAVE, null);
  const arm = payload => ({ mode: 'arm', cursorId: 'md40 8', msg: null, verb: 'result', payload, pos: payload.length });
  // arm a prefilled score, jump the caret home, kill to the end, retype
  let r = editor.step(arm('21-19 11-9'), key(null, 'home'), view);
  assert.equal(r.state.pos, 0, 'home jumps the caret to the start');
  r = editor.step(r.state, { ch: null, name: 'k', ctrl: true }, view);
  assert.equal(r.state.payload, '', '^K kills from the caret to the end — the prefill goes');
  r = editor.step(r.state, key('1'), view);
  r = editor.step(r.state, key('2'), view);
  assert.equal(r.state.payload, '12', 'a fresh score types after the kill');
  // ^E and end both park the caret at the end; ^A is home's twin
  r = editor.step(arm('a b'), key(null, 'end'), view);
  assert.equal(r.state.pos, 3, 'end jumps the caret to the end');
  r = editor.step(r.state, { ch: null, name: 'a', ctrl: true }, view);
  assert.equal(r.state.pos, 0, '^A jumps to the start');
  r = editor.step(r.state, { ch: null, name: 'e', ctrl: true }, view);
  assert.equal(r.state.pos, 3, '^E jumps to the end');
  // ^W kills the word back from the caret — mid-field it leaves the tail
  r = editor.step(arm('pool A 92'), key(null, 'left'), view);
  r = editor.step(r.state, key(null, 'left'), view);
  r = editor.step(r.state, { ch: null, name: 'w', ctrl: true }, view);
  assert.equal(r.state.payload, 'pool 92', '^W kills the word before the caret, tail stays');
  // delete is forward-backspace: at the end it's a no-op
  r = editor.step(arm('a b'), key(null, 'delete'), view);
  assert.equal(r.state.payload, 'a b', 'delete past the end is a no-op');
  r = editor.step(r.state, key(null, 'home'), view);
  r = editor.step(r.state, key(null, 'delete'), view);
  assert.equal(r.state.payload, ' b', 'delete at the caret removes the char after it');
  // the goodies are arm-only — in browse they are no-ops, never a write
  const b = editor.step({ mode: 'browse', cursorId: 'md40 8', msg: null }, { ch: null, name: 'home', ctrl: false }, view);
  assert.equal(b.state.mode, 'browse', 'home in browse changes nothing');
});

test('editor step: a time edit keeps the stored day — a bare hh:mm applies only to an unscheduled match', () => {
  const repo = loadRepo(FIX('sample'));
  const view = viewOf(repo, WAVE, null);
  // the sim-clock day and the stored day differ, so the prefill must carry the stored date
  const now = Date.parse('2026-10-03T12:00:00Z');
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null }; // scheduled 2025-07-14 11:15
  let r = editor.step(s, key('t'), view, now);
  assert.equal(r.state.payload, '2025-07-14 11:15', 'a stored date other than the clock day prefills in full');
  r = editor.step(r.state, key(null, 'return'), view, now);
  assert.equal(r.action.value, '2025-07-14T11:15:00', 'the untouched prefill emits the stored time — byte-identical, never a move');
  // a match with no schedule arms empty, and a bare hh:mm takes the clock's day
  repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 9).scheduled = undefined;
  const tbd = viewOf(repo, WAVE, null); // rebuilt — the view now reflects the dropped schedule
  s = { mode: 'browse', cursorId: 'md40 9', msg: null };
  r = editor.step(s, key('t'), tbd, now);
  assert.equal(r.state.payload, '', 'an unscheduled match arms empty');
  for (const c of '10:30'.split('')) r = editor.step(r.state, key(c), tbd, now);
  r = editor.step(r.state, key(null, 'return'), tbd, now);
  assert.equal(r.action.value, '2026-10-03T10:30:00', 'a bare hh:mm uses the passed clock day (America/New_York), not Date.now');
  r = editor.step(s, key('t'), tbd); // no clock — the live editor
  for (const c of '10:30'.split('')) r = editor.step(r.state, key(c), tbd);
  r = editor.step(r.state, key(null, 'return'), tbd);
  assert.match(r.action.value, /T10:30:00$/, 'the live default keeps building from the real clock');
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
  assert.equal(editor.editDetail('result', { games: [{ a: 21, b: 19 }, { a: 11, b: 5 }] }, { shape: 'score' }), '21-19 · 11-5', 'a score echo speaks dashes, mirroring the board column');
  assert.equal(editor.editDetail('result', {}, { shape: 'clear' }), '→ TBD', 'a clear returns the match to the board');
});

test('editor echoLine: sides first, then the detail and the sha receipt', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  editor.applyScore(matches, '8', [{ a: 11, b: 7 }, { a: 11, b: 3 }], ctx); // fixture bestOf 3, target 2 → done
  const m8 = matches.find(m => m.id === 8);
  const line = editor.echoLine('result', m8, ctx, 'abc1234', { shape: 'score' });
  assert(line.includes(' vs ') && line.includes('11-7'), 'the echo carries both sides and the score — dashes, matching the board column');
  assert(line.includes('— done'), 'a completed score is flagged done');
  assert(line.includes('[abc1234]'), 'the short sha is the dimmed receipt');
  const t = editor.echoLine('time', m8, ctx, 'abc1234');
  assert(t.includes(' vs ') && t.includes('→'), 'a move edit still shows the sides and its target');
});

test('editor writeEdit: the gate sees schedule edits — a date the index lacks is rejected and rolled back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const res = editor.writeEdit(dataRoot, repo, 'sample', 'md40', (c) => editor.applyTime(c, '2', '2025-07-15T09:00:00'));
    assert(res.errs && res.errs.some(e => /dates/.test(e)), 'index dates must mismatch the edited schedule — the edit cannot silently pass');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m2 = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 2);
    assert.equal(m2.scheduled, '2025-07-14T09:00:00', 'in-memory match restored for a same-process retry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor writeEdit/execEdit: an edit already on record writes and commits nothing — the echo says unchanged', () => {
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
    // commit:true on a non-git tmp dir would fail loudly — the unchanged path must return before any git call
    const state = { root: tmp, siteRoot: dataRoot, repo, slug: 'sample', commit: true };
    const r = editor.execEdit(state, 'venue', 'md40', '8', 'court-2');
    assert.equal(r.color, 'yellow', 'the no-op acknowledges, not a green commit receipt');
    assert(/unchanged/.test(r.text), 'the echo reports the no-op');
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

test('editor parsePayload: the side op parses all three shapes — the a/b key fixes the side', () => {
  const g = s => editor.parsePayload('side-a', s.trim().split(/\s+/), 'UTC', 0);
  const h = s => editor.parsePayload('side-b', s.trim().split(/\s+/), 'UTC', 0);
  assert.deepEqual(g('players p1 p2'), { value: { si: 0, side: { kind: 'players', ids: ['p1', 'p2'] } } }, 'players side');
  assert.deepEqual(h('pool A 2'), { value: { si: 1, side: { kind: 'pool', pool: 'A', rank: 2 } } }, 'the b key picks side 1');
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
