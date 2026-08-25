'use strict';

// repl.js: scoring eligibility, edits, command parsing, listing filters, commit messages, disk writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');
const repl = require('../src/repl.js');
const { FIX, hasErr } = require('./helpers.js');

function md40Ctx(repo) {
  const tjson = repo.tournaments.get('sample').tjson;
  const matches = repo.tournaments.get('sample').matches.get('md40');
  return { tjson, matches, ctx: makeCat({ meta: tjson.categories.find(c => c.id === 'md40'), matches }, tjson) };
}

test('completer: match-id position completes on strings — numeric ids can’t throw', () => {
  const repo = loadRepo(FIX('sample'));
  const complete = repl.completer({ repo, slug: 'sample' });
  const [cands, partial] = complete('/score md40 7');
  assert.equal(partial, '7');
  assert.ok(cands.every(c => typeof c === 'string'), 'match-id candidates are strings');
  assert.doesNotThrow(() => complete('/score md40 1'), 'a partial that matches ids still completes cleanly');
});

test('repl: a null-tjson tournament is refused (auto-select and /use)', () => {
  const repo = loadRepo(FIX('bad-null-tjson'));
  assert.equal(repl.defaultSlug(repo), null, 'auto-select skips a tournament whose file is null');
  const state = { repo, slug: null };
  assert.match(repl.dispatch({ kind: 'use', args: ['bad-null-tjson'] }, state), /no readable data/);
  assert.equal(state.slug, null, '/use refuses the broken tournament');
  assert.doesNotThrow(() => repl.dispatch({ kind: 'ls', args: [] }, state), 'bare ls at the root stays safe');
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
  const matches = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyVenue(matches, '2', 'court-2') === null, 'applyVenue reports no error');
  assert(matches.find(m => m.id === 2).venue === 'court-2', 'venue moved');
  assert(repl.applyVenue(matches, 'nope', 'court-2') === 'unknown match nope', 'unknown match reported');
  const repo2 = loadRepo(FIX('sample'));
  repl.applyVenue(repo2.tournaments.get('sample').matches.get('md40'), '2', 'bogus-court');
  assert(hasErr(validateRepo(repo2), /unknown venue "bogus-court"/), 'undeclared venue rejected');
});

test('repl buildScheduled: builds local ISO-8601 wall time from hh:mm and timezone', () => {
  const r = repl.buildScheduled('09:00', 'America/New_York');
  assert(/^\d{4}-\d{2}-\d{2}T09:00:00$/.test(r), `expected local wall time, got ${r}`);
  const r2 = repl.buildScheduled('9:00', 'America/New_York');
  assert(r2.includes('T09:00:00'), 'single-digit hour pads to 09');
  assert(repl.buildScheduled('25:00', 'UTC') === null, 'bad hour returns null');
});

test('repl applyTime: sets scheduled field, repo validates', () => {
  const repo = loadRepo(FIX('sample'));
  const matches = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyTime(matches, '2', '2025-07-14T16:00:00') === null, 'applyTime reports no error');
  assert(matches.find(m => m.id === 2).scheduled === '2025-07-14T16:00:00', 'scheduled set');
  assert(repl.applyTime(matches, 'nope', '2025-07-14T16:00:00') === 'unknown match nope', 'unknown match reported');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const { matches, ctx } = md40Ctx(repo);
  repl.applyScore(matches, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }], ctx); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  repl.applyResult(repo2.tournaments.get('sample').matches.get('md40'), '9', 'walkover', 'b'); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
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

test('repl listText: player filter narrows standings rows and matches to that player', () => {
  const repo = loadRepo(FIX('sample'));
  const all = repl.listText(repo, 'sample', ['md40'], null);
  assert(all.includes('Pool A Teams'), 'pool id lives in the table header — no title line');
  assert(all.includes('Ada Lovelace'), 'unfiltered view lists Ada\'s team');
  const ada = repl.listText(repo, 'sample', ['md40'], 'ada');
  assert(ada.includes('Ada Lovelace') && ada.includes('Grace Hopper'), 'filtered standings keep Ada\'s team');
  // standings rows start with the rank digits; match lines start with the category id —
  // opponents staying in match lines is expected, they only drop out of the standings table
  const standingRows = ada.split('\n').filter(l => /^\d+\s/.test(l));
  assert.equal(standingRows.length, 1, 'only the player\'s standings row remains');
  assert(standingRows[0].includes('Ada Lovelace'), 'the surviving row is Ada\'s team');
  const matchLines = ada.split('\n').filter(l => l.includes(' vs ') || l.includes('·'));
  assert(matchLines.length > 0, 'filtered listing still has matches');
  assert(matchLines[0].startsWith('md40 '), 'match refs carry the category id — copy-paste into /score');
  for (const l of matchLines) {
    assert(l.includes('Ada Lovelace') || l.includes('Grace Hopper'), `every listed match holds the player: ${l.trim()}`);
  }
  assert(repl.listText(repo, 'sample', ['md40'], 'nobody-here').includes('nothing for'), 'no match → nothing for "…"');
  // `ls <category>` keeps the full standings + match sheet; bare `ls` sections per category
  const xd = repl.listText(repo, 'sample', ['xd'], null);
  assert(xd.includes('Pool A Teams'), 'xd standings render');
  const everything = repl.listText(repo, 'sample', ['md40', 'xd'], null);
  assert(everything.includes('Men\'s Doubles 40+ — md40') && everything.includes('Mixed Doubles — xd'), 'bare ls names the category first, id second');
  // a filter that matches nothing drops every section — no dangling category titles
  const none = repl.listText(repo, 'sample', ['md40', 'xd'], 'nobody-here');
  assert(!none.includes('Men\'s Doubles 40+ — md40') && !none.includes('Mixed Doubles — xd'), 'empty sections are suppressed');
  assert(none.includes('nothing for'), '…replaced by the nothing-for line');
  assert(everything.includes('\n\nMixed Doubles — xd'), 'sections are separated by a blank line — never glued');
});

test('repl listText: matches are listed in chronological id order', () => {
  const repo = loadRepo(FIX('sample'));
  const txt = repl.listText(repo, 'sample', ['md40'], null);
  const ids = txt.split('\n')
    .filter(l => /^md40\s+\d+\b/.test(l))
    .map(l => Number(l.match(/^md40\s+(\d+)/)[1]));
  assert(ids.length > 1, 'multiple match lines to compare');
  const sorted = [...ids].sort((a, b) => a - b);
  assert.deepEqual(ids, sorted, `match ids in id order, got ${ids.join(',')}`);
});

test('repl listText: dead-tied standings rows share the group rank', () => {
  const repo = loadRepo(FIX('tie'));
  const txt = repl.listText(repo, 'tie', ['t'], null);
  const rows = txt.split('\n').filter(l => /^\d+\s/.test(l));
  assert.equal(rows.length, 2, 'two tied sides render');
  const ranks = rows.map(l => l.match(/^(\d+)/)[1]);
  assert(ranks[0] === '1' && ranks[1] === '1', `dead tie shares rank 1 in the REPL table, got ${ranks}`);
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
    const m2 = repo.tournaments.get('sample').matches.get('md40').find(m => m.id === 2);
    assert.equal(m2.scheduled, '2025-07-14T09:00:00', 'in-memory match restored for a same-process retry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repl writeEdit: the identity tripwire fires when tjson.matches diverges from info.matches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const info = repo.tournaments.get('sample');
    info.tjson.matches = { ...info.tjson.matches, md40: [...info.tjson.matches.md40] }; // a copy, not info.matches' own array
    assert.throws(() => repl.writeEdit(dataRoot, repo, 'sample', 'md40', () => null), /invariant/);
    info.tjson.matches.md40 = info.matches.get('md40'); // restore identity — the real path keeps it
    assert.doesNotThrow(() => repl.writeEdit(dataRoot, repo, 'sample', 'md40', () => 'unknown match x'), 'a healthy repo passes the tripwire');
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
    const m7mem = repo.tournaments.get('sample').matches.get('md40').find(m => m.id === 7);
    assert(m7mem.result.status === 'walkover' && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = repl.writeEdit(dataRoot, repo, 'sample', 'md40', (c, ctx) => repl.applyScore(c, '7', [{ a: 11, b: 5 }], ctx));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').matches.get('md40').find(m => m.id === 7);
    assert(m7.games.length === 1 && m7.result.status === 'played' && m7.result.winner === 'a', 'games applied with a played result');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
