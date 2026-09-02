'use strict';

// repl.js: the match-day editor (buffer, filter, state machine), scoring
// eligibility, edits, command parsing, commit messages, disk writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat, matchLabel, schedTime, fmtTime } = require('../site/derive.js');
const repl = require('../src/repl.js');
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
const viewOf = (repo, playable, query) => repl.makeView(repo.tournaments.get('sample').tjson, playable, query);
const rkey = r => repl.rowKey(r.cat, r.m);

// ---------- the editor ----------

test('editor buildRows: one flat buffer, time order, tie-break cat then id, TBD last', () => {
  const repo = loadRepo(FIX('sample'));
  const rows = repl.buildRows(repo.tournaments.get('sample').tjson, WAVE);
  assert.equal(rows.length, 16, 'md40 10 + xd 6 — the whole day is one list');
  assert.equal(rkey(rows[0]), 'md40 1', 'the 09:00 opener leads');
  assert.equal(rkey(rows[1]), 'md40 2', 'same minute, same category: id order');
  const idx = rows.findIndex(r => r.m.id === 8);
  assert(rows[idx].playable, 'the ▶ flag comes from the injected playable set');
  assert(!rows.find(r => r.m.id === 1).playable, 'unlisted matches are not flagged');
  const copy = repo.tournaments.get('sample').tjson;
  copy.matches.md40.find(m => m.id === 9).scheduled = undefined;
  const rows2 = repl.buildRows(copy, WAVE);
  assert.equal(rows2[rows2.length - 1].m.id, 9, 'an unscheduled match goes last, still editable');
});

test('editor makeView: / filters the rendered lines — names, refs, venues — case-insensitively', () => {
  const repo = loadRepo(FIX('sample'));
  const byName = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, 'ada');
  assert(byName.filtered.length > 0, 'a player name narrows the day');
  const vc = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, 'COURT-2');
  assert(vc.filtered.length > 0 && vc.filtered.every(e => e.r.m.venue === 'court-2'), 'venues filter, case-blind');
  const vRef = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, 'md40 9');
  assert.equal(vRef.filtered.length, 1, 'the ref pins the one match (md40 10 does not match md40 9)');
  assert.equal(repl.makeView(repo.tournaments.get('sample').tjson, WAVE, 'zzz').filtered.length, 0, 'a miss is an empty view, never an error');
  assert.equal(repl.makeView(repo.tournaments.get('sample').tjson, WAVE, null).filtered.length, 16, 'no query = the whole day');
});

test('editor step: j/k walk, g/G jump, clamped at the ends', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: null, msg: null };
  let r = repl.step(s, key('j'), view);
  assert.equal(r.state.cursorId, 'md40 2', 'the first j steps into the list — the cursor starts at the top row');
  for (let i = 0; i < 4; i++) r = repl.step(r.state, key('j'), view);
  assert.equal(r.state.cursorId, 'md40 6', 'j walks down in id order');
  r = repl.step(r.state, key('k'), view);
  assert.equal(r.state.cursorId, 'md40 5', 'k walks back up');
  r = repl.step(r.state, key('G'), view);
  assert.equal(r.state.cursorId, 'xd 6', 'G bottoms out');
  r = repl.step(r.state, key('j'), view);
  assert.equal(r.state.cursorId, 'xd 6', 'j clamps at the last row');
  r = repl.step(r.state, key('g'), view);
  assert.equal(r.state.cursorId, 'md40 1', 'g tops out');
});

test('editor step: n/N jump between the ▶-flagged rows', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 1', msg: null };
  let r = repl.step(s, key('n'), view);
  assert.equal(r.state.cursorId, 'md40 8', 'n lands on the playable match');
  r = repl.step(r.state, key('N'), view);
  assert.equal(r.state.cursorId, 'md40 8', 'nothing playable before it — N stays');
});

test('editor step: / narrows live, Enter keeps it, Esc clears it', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: null, msg: null };
  let r = repl.step(s, key('/'), view);
  assert.equal(r.state.mode, 'filter', '/ opens the filter input');
  for (const c of ['c', 'o', 'u']) r = repl.step(r.state, key(c), view);
  assert.equal(r.state.query, 'cou', 'typed chars accumulate');
  r = repl.step(r.state, key(null, 'return'), view);
  assert.equal(r.state.mode, 'browse');
  assert.equal(r.state.query, 'cou', 'Enter keeps the filter applied');
  r = repl.step(r.state, key(null, 'escape'), view);
  assert.equal(r.state.query, null, 'Esc in browse clears the applied filter too');
});

test('editor step: an old /score prefix gets a hint, not silence', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key('/'), view);
  for (const c of 'score md40 8 21:19'.split('')) r = repl.step(r.state, key(c), view);
  assert(r.state.msg && /old slash grammar/.test(r.state.msg.text), 'the operator is pointed at s, not at zero matches');
});

test('editor step: s arms the cursor line; payload + Enter emits the exact edit', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = repl.step(s, key('s'), view);
  assert.equal(r.state.mode, 'arm', 's arms score');
  for (const c of '21:19'.split('')) r = repl.step(r.state, key(c), view);
  assert.equal(r.state.payload, '21:19', 'payload accumulates');
  r = repl.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'score', cat: 'md40', matchId: '8', value: [{ a: 21, b: 19 }] }, 'enter emits the edit');
  assert.equal(r.state.mode, 'browse', 'back to browse, unarmed');
});

test('editor step: a bad payload stays armed with the error — never writes', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = repl.step(s, key('s'), view);
  r = repl.step(r.state, key('x'), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert(r.action === null, 'no action on a bad score');
  assert.equal(r.state.mode, 'arm', 'still armed');
  assert.equal(r.state.payload, 'x', 'payload kept for retype');
  assert(r.state.msg && /bad score/.test(r.state.msg.text), 'the error names the token');
});

test('editor step: Esc cancels an arm without touching anything', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = repl.step(s, key('t'), view);
  r = repl.step(r.state, key('1'), view);
  r = repl.step(r.state, key(null, 'escape'), view);
  assert.equal(r.state.mode, 'browse');
  assert.equal(r.state.verb, null, 'esc unarms the time verb too');
});

test('editor step: o void needs no payload — Enter alone emits; a payload is refused', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let s = { mode: 'browse', cursorId: 'md40 8', msg: null };
  let r = repl.step(s, key('o'), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'void', cat: 'md40', matchId: '8', value: undefined }, 'Enter confirms the void');
  r = repl.step(s, key('o'), view);
  r = repl.step(r.state, key('a'), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert(r.action === null, 'no action');
  assert(r.state.msg && /no payload/.test(r.state.msg.text), 'void takes nothing');
});

test('editor step: :score md40 8 11:9 — the old syntax — routes to the same funnel', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  for (const c of 'score md40 8 11:9'.split('')) r = repl.step(r.state, key(c), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'score', cat: 'md40', matchId: '8', value: [{ a: 11, b: 9 }] }, 'the colon command is the old parseCmd grammar');
  r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  for (const c of 'wo md40 8 b'.split('')) r = repl.step(r.state, key(c), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert.deepEqual(r.action, { kind: 'edit', verb: 'walkover', cat: 'md40', matchId: '8', value: 'b' }, ':wo maps to the same walkover verb as the w key');
});

test('editor step: bare q and :q quit; typos get a hint, never a write', () => {
  const view = viewOf(loadRepo(FIX('sample')), WAVE, null);
  let r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key('q'), view);
  assert.equal(r.state.quit, true, 'bare q quits');
  r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  r = repl.step(r.state, key('q'), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert.equal(r.state.quit, true, ':q quits');
  r = repl.step({ mode: 'browse', cursorId: null, msg: null }, key(':'), view);
  for (const c of 'frobnicate'.split('')) r = repl.step(r.state, key(c), view);
  r = repl.step(r.state, key(null, 'return'), view);
  assert(r.state.msg && /unknown command/.test(r.state.msg.text), 'typos answer with :help');
});

test('editor parsePayload: one grammar for the arm line and the : command', () => {
  assert.deepEqual(repl.parsePayload('score', ['21:19', '11:9'], 'UTC').value.map(g => `${g.a}:${g.b}`), ['21:19', '11:9']);
  assert(repl.parsePayload('score', ['21x9'], 'UTC').err, 'a malformed game is refused');
  assert(repl.parsePayload('score', [], 'UTC').err, 'no games at all is refused');
  assert.equal(repl.parsePayload('walkover', ['b'], 'UTC').value, 'b');
  assert(repl.parsePayload('walkover', ['c'], 'UTC').err, 'only a|b');
  assert.equal(repl.parsePayload('void', [], 'UTC').value, undefined);
  assert(repl.parsePayload('void', ['a'], 'UTC').err, 'void takes nothing');
  assert.equal(repl.parsePayload('venue', ['court-2'], 'UTC').value, 'court-2');
  assert(repl.parsePayload('venue', [], 'UTC').err, 'a venue is required');
  assert.match(repl.parsePayload('time', ['10:30'], 'UTC').value, /T10:30:00$/);
  assert.equal(repl.parsePayload('time', ['-'], 'UTC').value, undefined, 'a lone - unschedules');
  assert(repl.parsePayload('time', ['10:99'], 'UTC').err, 'impossible minutes refused');
});

test('editor execAction: :use refuses a broken or unknown tournament, lists at bare use', () => {
  const repo = loadRepo(FIX('bad-null-tjson'));
  assert.equal(repl.defaultSlug(repo), null, 'auto-select skips a tournament whose file is null');
  const state = { repo, slug: null };
  let r = repl.execAction(state, { kind: 'use', slug: 'bad-null-tjson' });
  assert(r.msg && /no readable data/.test(r.msg.text), 'a broken tournament is refused');
  assert.equal(state.slug, null, 'a refused use never changes the selection');
  r = repl.execAction(state, { kind: 'use', slug: 'nope' });
  assert(r.msg && /unknown tournament/.test(r.msg.text), 'an unknown slug is refused');
  r = repl.execAction({ repo: loadRepo(FIX('sample')), slug: 'sample' }, { kind: 'use', slug: '' });
  assert(r.msg && /tournaments:/.test(r.msg.text), 'bare use lists them');
  r = repl.execAction({ repo: loadRepo(FIX('sample')), slug: 'md40' }, { kind: 'use', slug: 'sample' });
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
    const r = repl.execEdit(state, 'score', 'md40', '8', [{ a: 11, b: 5 }, { a: 11, b: 3 }]);
    assert.equal(r.color, 'green');
    assert(/\[sim\]/.test(r.text), 'the sim receipt marks the scratch write');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'the scratch copy still validates');
    const m8 = reread.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8);
    assert(m8.result.status === 'played' && m8.result.winner === 'a', 'games applied with a result');
    const bad = repl.execEdit(state, 'venue', 'md40', '8', 'bogus-court');
    assert.equal(bad.color, 'red');
    assert(/rolled back/.test(bad.text), 'a validator refusal reports the rollback');
    assert(loadRepo(dataRoot).tournaments.get('sample').tjson.matches.md40.find(m => m.id === 8).venue === 'court-2', 'the venue rolls back to the original court');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('editor boardText: header, ▶ flag, cursor marker, hint bar — one screen', () => {
  const repo = loadRepo(FIX('sample'));
  const view = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, null);
  const state = { mode: 'browse', cursorId: 'md40 8', msg: null, verb: null, payload: '', query: null, cmdline: '' };
  const info = { title: 'Sample', mode: 'LIVE', clock: '14:32', played: 11, total: 16, note: '', sim: false };
  const txt = repl.boardText(state, view, info);
  assert(txt.includes('Sample · LIVE 14:32 · 11/16 played'), 'the header carries mode and tally');
  assert(/^>▶/.test(txt.split('\n').find(l => l.includes('md40 8') && l.includes(' vs '))), 'the cursor line carries both markers');
  const other = txt.split('\n').find(l => l.includes('md40 1') && l.includes(' vs '));
  assert(!other.startsWith('>'), 'only the cursor line is marked >');
  assert(/\? help · q quit/.test(txt), 'the browse hint bar is on screen');
});

test('editor boardText: an active filter is echoed on the status line', () => {
  const repo = loadRepo(FIX('sample'));
  const view = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, 'ada');
  const state = { mode: 'browse', cursorId: 'md40 8', msg: null, verb: null, payload: '', query: 'ada', cmdline: '' };
  const info = { title: 'Sample', mode: 'LIVE', clock: '14:32', played: 11, total: 16, note: '', sim: false };
  const txt = repl.boardText(state, view, info);
  assert(/· \/ada — \d+ match/.test(txt.split('\n')[0]), 'the status line carries the active filter and its match count');
  assert(view.filtered.length > 0, 'the ada filter has matches to count');
});

test('editor boardText: a narrow pane that wraps matches still keeps the header on screen', () => {
  const repo = loadRepo(FIX('sample'));
  const view = repl.makeView(repo.tournaments.get('sample').tjson, WAVE, null);
  const state = { mode: 'browse', cursorId: 'md40 8', msg: null, verb: null, payload: '', query: null, cmdline: '' };
  const info = { title: 'Sample', mode: 'LIVE', clock: '14:32', played: 11, total: 16, note: '', sim: false };
  const strip = l => l.replace(/\x1b\[[0-9;]*m/g, '');
  // the wide match lines wrap on a narrow pane — every rendered line must count
  // its wrapped physical rows so the board never exceeds the pane height
  for (const cols of [40, 60, 100]) {
    const rows = 10;
    const txt = repl.boardText(state, view, info, rows, cols);
    const lines = txt.split('\n');
    const phys = lines.reduce((a, l) => a + Math.max(1, Math.ceil(strip(l).length / cols)), 0);
    assert(phys <= rows, `cols=${cols}: board physically fits the pane`);
    assert(/^Sample · LIVE/.test(strip(lines[0])), `cols=${cols}: header is the top line, not scrolled off`);
    assert(lines.some(l => /\? help · q quit/.test(strip(l))), `cols=${cols}: the hint bar is on screen`);
  }
});

test('repl applyScore: games + a played result at the target, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  assert(repl.applyScore(matches, '7', [{ a: 11, b: 5 }], ctx) === null, 'applyScore reports no error');
  const m7 = matches.find(m => m.id === 7);
  assert(m7.games.length === 1 && m7.result.status === 'played' && m7.result.winner === 'a', 'target reached: result recorded, winner a');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl applyScore: a prefix (below target) stays in play — no result yet', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  assert(repl.applyScore(matches, '6', [{ a: 11, b: 5 }], ctx) === null, 'prefix reports no error');
  const m6 = matches.find(m => m.id === 6);
  assert(m6.games.length === 1 && m6.result === undefined, 'games only — the match is still in play (pool bestOf is 3)');
});

test('repl applyResult: walkover records a winner, void settles, games cleared', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches } = md40Ctx(repo);
  assert(repl.applyResult(matches, '2', 'walkover', 'b') === null, 'walkover reports no error');
  const m2 = matches.find(m => m.id === 2);
  assert(m2.result.status === 'walkover' && m2.result.winner === 'b' && m2.games === undefined, 'walkover names the winning side; games cleared');
  assert(repl.applyResult(matches, '3', 'walkover', 'a') === null, 'walkover reports no error');
  assert(matches.find(m => m.id === 3).result.status === 'walkover' && matches.find(m => m.id === 3).result.winner === 'a', 'walkover winner recorded');
  assert(repl.applyResult(matches, '4', 'void') === null, 'void reports no error');
  const m4 = matches.find(m => m.id === 4);
  assert(m4.result.status === 'void' && m4.result.winner === undefined && m4.games === undefined, 'void: settled, no winner');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl applyVenue: moves a match; unknown venue is rejected by the validator', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  assert(repl.applyVenue(matches, '2', 'court-2') === null, 'applyVenue reports no error');
  assert(matches.find(m => m.id === 2).venue === 'court-2', 'venue moved');
  assert(repl.applyVenue(matches, 'nope', 'court-2') === 'unknown match nope', 'unknown match reported');
  const repo2 = loadRepo(FIX('sample'));
  repl.applyVenue(repo2.tournaments.get('sample').tjson.matches.md40, '2', 'bogus-court');
  assert(hasErr(validateRepo(repo2), /unknown venue "bogus-court"/), 'undeclared venue rejected');
});

test('repl buildScheduled: builds local ISO-8601 wall time from hh:mm and timezone', () => {
  const r = repl.buildScheduled('09:00', 'America/New_York');
  assert(/^\d{4}-\d{2}-\d{2}T09:00:00$/.test(r), `expected local wall time, got ${r}`);
  const r2 = repl.buildScheduled('9:00', 'America/New_York');
  assert(r2.includes('T09:00:00'), 'single-digit hour pads to 09');
  assert(repl.buildScheduled('25:00', 'UTC') === null, 'bad hour returns null');
  assert(repl.buildScheduled('09:00', 'UTC', '2026-05-03') === '2026-05-03T09:00:00', 'an explicit date wins over today');
  assert(repl.buildScheduled('09:00', 'UTC', '2026-02-30') === '2026-02-30T09:00:00', 'a format-valid but impossible date passes — the validator gate rejects it on write');
});

test('repl applyTime: sets scheduled field, repo validates', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').tjson.matches.md40;
  assert(repl.applyTime(matches, '2', '2025-07-14T16:00:00') === null, 'applyTime reports no error');
  assert(matches.find(m => m.id === 2).scheduled === '2025-07-14T16:00:00', 'scheduled set');
  assert(repl.applyTime(matches, 'nope', '2025-07-14T16:00:00') === 'unknown match nope', 'unknown match reported');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
  assert(repl.applyTime(matches, '2', undefined) === null, 'clearing reports no error');
  assert(matches.find(m => m.id === 2).scheduled === undefined, 'scheduled dropped — the match is unscheduled');
  const { errs: errs2 } = validateRepo(repo);
  assert(errs2.length === 0, 'an unscheduled match still validates: ' + errs2.join('; '));
});

test('repl rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  repl.applyScore(matches, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }], ctx); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  repl.applyResult(repo2.tournaments.get('sample').tjson.matches.md40, '9', 'walkover', 'b'); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
});

test('repl parseKeys: raw bytes to keys — a lone ESC is instant, arrows are one key, chunks split', () => {
  const cases = [
    [[27], [{ name: 'escape' }]],
    [[27, 91, 65], [{ name: 'up' }]],
    [[27, 91, 66], [{ name: 'down' }]],
    [[3], [{ name: 'c', ctrl: true }]],
    [[13], [{ name: 'return' }]],
    [[127], [{ name: 'backspace' }]],
    ['ada', [{ ch: 'a' }, { ch: 'd' }, { ch: 'a' }]],
    ['hello\x1b[A', [{ ch: 'h' }, { ch: 'e' }, { ch: 'l' }, { ch: 'l' }, { ch: 'o' }, { name: 'up' }]],
  ];
  for (const [input, expected] of cases) assert.deepEqual(repl.parseKeys(Buffer.from(input)), expected);
});

test('repl parseGame', () => {
  assert(JSON.stringify(repl.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(JSON.stringify(repl.parseGame('11:9')) === JSON.stringify({ a: 11, b: 9 }), 'a:b parses');
  assert(repl.parseGame('11x9') === null, 'bad shape is null');
});

test('repl parseCmd: mutators are slash-gated, reading is bare', () => {
  const mutators = {
    '/score md 7 11:9 11:7': ['score', ['md', '7', '11:9', '11:7']],
    '/wo md 1 b': ['wo', ['md', '1', 'b']],
    '/void md 1': ['void', ['md', '1']],
    '/venue md 1 court-2': ['venue', ['md', '1', 'court-2']],
    '/time md 1 10:30': ['time', ['md', '1', '10:30']],
  };
  for (const [line, [kind, args]] of Object.entries(mutators)) {
    assert.deepEqual(repl.parseCmd(line), { kind, args, needSlash: false }, `slashed ${kind} parses`);
  }
  assert.deepEqual(repl.parseCmd('/publish'), { kind: 'publish', args: [], needSlash: false });
  assert.equal(repl.parseCmd('score md 1 11:9').needSlash, true, 'bare mutator is flagged, never executed');
  assert.equal(repl.parseCmd('publish').needSlash, true, 'bare publish is flagged — publish ships');
  assert.equal(repl.parseCmd('wo md 1 a').needSlash, true, 'bare wo is flagged');
  assert.deepEqual(repl.parseCmd('use sample'), { kind: 'use', args: ['sample'], needSlash: false });
  assert.deepEqual(repl.parseCmd('ls md karin'), { kind: 'ls', args: ['md', 'karin'], needSlash: false });
  assert.deepEqual(repl.parseCmd('q'), { kind: 'q', args: [], needSlash: false });
  assert.deepEqual(repl.parseCmd('quit'), { kind: 'quit', args: [], needSlash: false });
  assert.deepEqual(repl.parseCmd('/ls md'), { kind: 'ls', args: ['md'], needSlash: false }, 'slashing a bare command is harmless');
  assert.deepEqual(repl.parseCmd('md40'), { kind: 'unknown', args: [], needSlash: false }, 'bare words are not commands');
  assert.deepEqual(repl.parseCmd('/score md 1'), { kind: 'score', args: ['md', '1'], needSlash: false }, 'a leading slash permits a mutator');
  assert.deepEqual(repl.parseCmd('cd md40').kind, 'unknown', 'cd is gone — use selects the tournament');
  assert.deepEqual(repl.parseCmd('pull').kind, 'unknown', 'pull is gone — leave it to the shell');
});

test('repl formatMatchLine: a filled width bag keeps time and venue aligned across lines', () => {
  // the sim's screen — and listText's pass 1 — fill this bag from the lines
  // about to render; without it, every column collapses to its own content
  const repo = loadRepo(FIX('sample'));
  const { tjson, matches, ctx } = md40Ctx(repo);
  const tz = tjson.timezone;
  const m1 = matches.find(m => m.id === 1); // pool match — long player names
  const m9 = matches.find(m => m.id === 9); // final — short slot labels
  const g = { idw: 0, stagew: 0, leftw: 0, rightw: 0, venuew: 0 };
  for (const m of [m1, m9]) {
    g.idw = Math.max(g.idw, `md40 ${m.id}`.length);
    g.stagew = Math.max(g.stagew, matchLabel(m, ctx).length);
    g.leftw = Math.max(g.leftw, repl.listingSide(m.sides[0], ctx).length);
    g.rightw = Math.max(g.rightw, repl.listingSide(m.sides[1], ctx).length);
    g.venuew = Math.max(g.venuew, (m.venue || 'TBD').length);
  }
  const at = m => repl.formatMatchLine('md40', m, ctx, tz, matchLabel(m, ctx), g);
  const l1 = at(m1), l9 = at(m9);
  const pos = (l, s) => l.indexOf(s);
  assert.equal(pos(l1, fmtTime(schedTime(m1, tz), tz)), pos(l9, fmtTime(schedTime(m9, tz), tz)), 'time column lines up');
  assert.equal(pos(l1, m1.venue), pos(l9, m9.venue), 'venue column lines up');
});

test('repl commitMessage: conventional types with tournament scope', () => {
  assert.equal(repl.commitMessage('score', '2026-mammut60', 'md40', '1', '11:9 · 11:7'), 'score(2026-mammut60): md40/1 11:9 · 11:7');
  assert.equal(repl.commitMessage('walkover', '2026-mammut60', 'xd', '7', 'side a wins by walkover'), 'walkover(2026-mammut60): xd/7 side a wins by walkover');
  assert.equal(repl.commitMessage('void', '2026-mammut60', 'xd', '7', 'void'), 'void(2026-mammut60): xd/7 void');
  assert.equal(repl.commitMessage('venue', '2026-mammut60', 'xd', '3', '→ court-2'), 'venue(2026-mammut60): xd/3 → court-2');
  assert.equal(repl.commitMessage('time', '2026-mammut60', 'md40', '1', '→ 2025-07-14T16:00:00-04:00'), 'time(2026-mammut60): md40/1 → 2025-07-14T16:00:00-04:00');
});

test('repl editDetail: venue/time edits report the move, never the match result', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches } = md40Ctx(repo);
  repl.applyResult(matches, '1', 'walkover', 'a'); // a decided match — the old bug mislabeled moves on these
  const m1 = matches.find(m => m.id === 1);
  m1.venue = 'court-2';
  assert.equal(repl.editDetail('venue', m1), '→ court-2', 'venue edit reports the venue on a decided match');
  m1.scheduled = '2025-07-14T16:00:00';
  assert.equal(repl.editDetail('time', m1), '→ 2025-07-14T16:00:00', 'time edit reports the time');
  assert.equal(repl.editDetail('walkover', m1), 'side a wins by walkover', 'walkover detail from the result');
  assert.equal(repl.editDetail('void', { result: { status: 'void' } }), 'void', 'void detail');
});

test('repl echoLine: sides first, then the detail and the sha receipt', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  repl.applyScore(matches, '8', [{ a: 11, b: 7 }, { a: 11, b: 3 }], ctx); // fixture bestOf 3, target 2 → done
  const m8 = matches.find(m => m.id === 8);
  const line = repl.echoLine('score', m8, ctx, 'abc1234');
  assert(line.includes(' vs ') && line.includes('11:7'), 'the echo carries both sides and the score');
  assert(line.includes('— done'), 'a completed score is flagged done');
  assert(line.includes('[abc1234]'), 'the short sha is the dimmed receipt');
  const t = repl.echoLine('time', m8, ctx, 'abc1234');
  assert(t.includes(' vs ') && t.includes('→'), 'a move edit still shows the sides and its target');
});

test('repl writeEdit: the gate sees schedule edits — a date the index lacks is rejected and rolled back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const res = repl.writeEdit(dataRoot, repo, 'sample', 'md40', (c) => repl.applyTime(c, '2', '2025-07-15T09:00:00'));
    assert(res.errs && res.errs.some(e => /dates/.test(e)), 'index dates must mismatch the edited schedule — the edit cannot silently pass');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m2 = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 2);
    assert.equal(m2.scheduled, '2025-07-14T09:00:00', 'in-memory match restored for a same-process retry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repl writeEdit: rollback on validation failure, write on success (real disk)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = repl.writeEdit(dataRoot, repo, 'sample', 'md40', (c, ctx) => repl.applyScore(c, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }], ctx));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 7);
    assert(m7mem.result.status === 'walkover' && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = repl.writeEdit(dataRoot, repo, 'sample', 'md40', (c, ctx) => repl.applyScore(c, '7', [{ a: 11, b: 5 }], ctx));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').tjson.matches.md40.find(m => m.id === 7);
    assert(m7.games.length === 1 && m7.result.status === 'played' && m7.result.winner === 'a', 'games applied with a played result');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
