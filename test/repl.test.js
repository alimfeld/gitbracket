'use strict';

// repl.js: scoring eligibility, edits, command parsing, navigation, commit messages, disk writes.

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

// scorable = both sides resolve to players; the validator's rule, exposed so
// `ls` and the guard on scored matches share one definition.
test('repl isScorable: resolved sides only', () => {
  const repo = loadRepo(FIX('sample'));
  const info = repo.tournaments.get('sample');
  const ctx = makeCat({ meta: info.tjson.categories.find(c => c.id === 'md40'), matches: info.matches.get('md40').matches }, info.tjson);
  assert(repl.isScorable(ctx.byId.get(1), ctx), '1: two players sides — scorable');
  assert(repl.isScorable(ctx.byId.get(7), ctx), '7: forfeit, two resolved pool slots — scorable');
  assert(repl.isScorable(ctx.byId.get(8), ctx), '8: two resolved pool slots, in play — scorable');
  assert(!repl.isScorable(ctx.byId.get(9), ctx), '9: winner of in-play 8 — not scorable');
  assert(!repl.isScorable(ctx.byId.get(10), ctx), '10: loser of in-play 8 — not scorable');
});

test('repl listEligible: pools + resolved slots, never match-slot feeders', () => {
  const repo = loadRepo(FIX('sample'));
  const rows = repl.listEligible(repo, 'sample').filter(r => r.cat === 'md40');
  assert(rows.length === 8, `expected 8 scorable in sample md40 (got ${rows.length})`);
  const ids = rows.map(r => r.m.id);
  assert(!ids.includes('9') && !ids.includes('10'), 'feeder matches stay unlisted until their slots resolve');
});

test('repl applyScore: sets games, clears a forfeit, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyScore(cjson, '7', [{ a: 11, b: 5 }]) === null, 'applyScore reports no error');
  const m7 = cjson.matches.find(m => m.id === 7);
  assert(m7.forfeit === undefined && m7.games.length === 1, 'forfeit replaced by games');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl applyForfeit: sets forfeit, clears games, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyForfeit(cjson, '2', 1) === null, 'applyForfeit reports no error');
  const m2 = cjson.matches.find(m => m.id === 2);
  assert(m2.forfeit === 1 && m2.games === undefined, 'games replaced by forfeit');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl applyVenue: moves a match; unknown venue is rejected by the validator', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyVenue(cjson, '2', 'court-2') === null, 'applyVenue reports no error');
  assert(cjson.matches.find(m => m.id === 2).venue === 'court-2', 'venue moved');
  assert(repl.applyVenue(cjson, 'nope', 'court-2') === 'unknown match nope', 'unknown match reported');
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
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(repl.applyTime(cjson, '2', '2025-07-14T16:00:00') === null, 'applyTime reports no error');
  assert(cjson.matches.find(m => m.id === 2).scheduled === '2025-07-14T16:00:00', 'scheduled set');
  assert(repl.applyTime(cjson, 'nope', '2025-07-14T16:00:00') === 'unknown match nope', 'unknown match reported');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('repl rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  repl.applyScore(cjson, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  repl.applyForfeit(repo2.tournaments.get('sample').matches.get('md40'), '9', 1); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
});

test('repl parseGame', () => {
  assert(JSON.stringify(repl.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(JSON.stringify(repl.parseGame('11:9')) === JSON.stringify({ a: 11, b: 9 }), 'a:b parses');
  assert(repl.parseGame('11x9') === null, 'bad shape is null');
});

test('repl parseCmd: every line is a command — the first word is the verb', () => {
  assert.deepEqual(repl.parseCmd('score 1 11:9 11:7'), { kind: 'score', args: ['1', '11:9', '11:7'] });
  assert.deepEqual(repl.parseCmd('ff 1 1'), { kind: 'ff', args: ['1', '1'] });
  assert.deepEqual(repl.parseCmd('venue 1 court-2'), { kind: 'venue', args: ['1', 'court-2'] });
  assert.deepEqual(repl.parseCmd('time 1 10:30'), { kind: 'time', args: ['1', '10:30'] });
  assert.deepEqual(repl.parseCmd('push'), { kind: 'push', args: [] });
  assert.deepEqual(repl.parseCmd('cd md40'), { kind: 'cd', args: ['md40'] });
  assert.deepEqual(repl.parseCmd('q'), { kind: 'q', args: [] });
  assert.deepEqual(repl.parseCmd('md40'), { kind: 'unknown', args: [] }, 'bare words are not commands');
  assert.deepEqual(repl.parseCmd('/score 1'), { kind: 'unknown', args: ['1'] }, 'slashes are not commands');
});

test('repl navigate: root → tournament → category, up and root shortcuts', () => {
  const repo = loadRepo(FIX('sample'));
  const root = { repo, slug: null, cat: null };
  assert.deepEqual(repl.navigate(root, 'sample'), { slug: 'sample', cat: null });
  assert.deepEqual(repl.navigate(root, 'nope').err, 'unknown tournament nope — tab completes', 'unknown slug errors');
  const tour = { repo, slug: 'sample', cat: null };
  assert.deepEqual(repl.navigate(tour, 'md40'), { slug: 'sample', cat: 'md40' }, 'category entered');
  assert.deepEqual(repl.navigate(tour, 'nope').err, 'unknown category nope — tab completes', 'unknown category errors');
  const cat = { repo, slug: 'sample', cat: 'md40' };
  assert.deepEqual(repl.navigate(cat, '1').err, 'matches are leaves — score 1 … or cd ..', 'matches are leaves');
  assert.deepEqual(repl.navigate(cat, '..'), { slug: 'sample', cat: null }, '.. goes up to the tournament');
  assert.deepEqual(repl.navigate(tour, '..'), { slug: null, cat: null }, '.. from a tournament goes to root');
  assert.deepEqual(repl.navigate(cat, '/'), { slug: null, cat: null }, '/ goes to root');
});

test('repl commitMessage: conventional types with tournament scope', () => {
  assert.equal(repl.commitMessage('score', '2026-mammut60', 'md40', '1', '11:9 · 11:7'), 'score(2026-mammut60): md40/1 11:9 · 11:7');
  assert.equal(repl.commitMessage('forfeit', '2026-mammut60', 'md', '7', 'side 1'), 'forfeit(2026-mammut60): md/7 side 1');
  assert.equal(repl.commitMessage('venue', '2026-mammut60', 'xd', '3', '→ court-2'), 'venue(2026-mammut60): xd/3 → court-2');
  assert.equal(repl.commitMessage('time', '2026-mammut60', 'md40', '1', '→ 2025-07-14T16:00:00-04:00'), 'time(2026-mammut60): md40/1 → 2025-07-14T16:00:00-04:00');
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
    const bad = repl.writeEdit(dataRoot, repo, 'sample', 'md40', c => repl.applyScore(c, '7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 7);
    assert(m7mem.forfeit === 1 && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = repl.writeEdit(dataRoot, repo, 'sample', 'md40', c => repl.applyScore(c, '7', [{ a: 11, b: 5 }]));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 7);
    assert(m7.games.length === 1 && m7.forfeit === undefined, 'games applied and the forfeit cleared');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


// The two bracket re-derivations must survive any placement depth, not just
// the 4/8 the generator defaults to: a 16-team classification bracket is a
// different data shape, and both old heuristics silently degraded it.
const { buildKnockout } = require('../src/schedule.js');
const { koColumn, placementLabel } = require('../site/derive.js');

function koContext(placements) {
  let n = 1;
  const ko = buildKnockout([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]], ['A'], () => n++, {}, placements);
  return { ko, ctx: makeCat({ meta: { id: 't' }, matches: ko }, {}) };
}

test('repl inferPlacements: loser-edge depth, any placement depth', () => {
  for (const want of [2, 4, 8, 16]) {
    const { ko, ctx } = koContext(want);
    assert(repl.inferPlacements(ko, ctx) === want, `inferred ${repl.inferPlacements(ko, ctx)} want ${want}`);
  }
});

test('repl koCompare: placements sort after the same-column main-bracket match', () => {
  const { ko, ctx } = koContext(16); // 9th-16th classification interleaves columns with QF/SF otherwise
  const all = ko.map(m => ({ m })).sort((a, b) => repl.koCompare(a, b, ctx));
  const byCol = new Map();
  for (const { m } of all) {
    const col = koColumn(m, ctx);
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(m);
  }
  for (const [col, ms] of byCol) {
    const main = ms.filter(m => placementLabel(m, ctx) === null);
    const pl = ms.filter(m => placementLabel(m, ctx) !== null);
    assert((pl.length === 0 || main.length === 0 || main[main.length - 1].id < pl[0].id),
      `col ${col}: placement matches must follow main-bracket matches`);
  }
});
