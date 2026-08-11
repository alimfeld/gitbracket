'use strict';

// gb.js: scoring eligibility, edits, command parsing, navigation, commit messages, disk writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo, validateRepo } = require('../validate.js');
const { makeCat } = require('../site/derive.js');
const gb = require('../gb.js');
const { FIX, hasErr } = require('./helpers.js');

const catOf = (repo, slug, catId) => {
  const info = repo.tournaments.get(slug);
  return makeCat({ meta: info.tjson.categories.find(c => c.id === catId), matches: info.matches.get(catId).matches }, info.tjson);
};

// scorable = both sides resolve to players; the validator's rule, exposed so
// `ls` and the guard on scored matches share one definition.
test('gb isScorable: resolved sides only', () => {
  const repo = loadRepo(FIX('sample'));
  const ctx = catOf(repo, 'sample', 'md40');
  assert(gb.isScorable(ctx.byId.get('m1'), ctx), 'm1: two players sides — scorable');
  assert(gb.isScorable(ctx.byId.get('m7'), ctx), 'm7: forfeit, two resolved pool slots — scorable');
  assert(gb.isScorable(ctx.byId.get('m8'), ctx), 'm8: two resolved pool slots, in play — scorable');
  assert(!gb.isScorable(ctx.byId.get('m9'), ctx), 'm9: winner of in-play m8 — not scorable');
  assert(!gb.isScorable(ctx.byId.get('m10'), ctx), 'm10: loser of in-play m8 — not scorable');
});

test('gb listEligible: pools + resolved slots, never match-slot feeders', () => {
  const repo = loadRepo(FIX('sample'));
  const rows = gb.listEligible(repo, 'sample').filter(r => r.cat === 'md40');
  assert(rows.length === 8, `expected 8 scorable in sample md40 (got ${rows.length})`);
  const ids = rows.map(r => r.m.id);
  assert(!ids.includes('m9') && !ids.includes('m10'), 'feeder matches stay unlisted until their slots resolve');
});

test('gb applyScore: sets games, clears a forfeit, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(gb.applyScore(cjson, 'm7', [{ a: 11, b: 5 }]) === null, 'applyScore reports no error');
  const m7 = cjson.matches.find(m => m.id === 'm7');
  assert(m7.forfeit === undefined && m7.games.length === 1, 'forfeit replaced by games');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('gb applyForfeit: sets forfeit, clears games, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(gb.applyForfeit(cjson, 'm2', 1) === null, 'applyForfeit reports no error');
  const m2 = cjson.matches.find(m => m.id === 'm2');
  assert(m2.forfeit === 1 && m2.games === undefined, 'games replaced by forfeit');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('gb applyVenue: moves a match; unknown venue is rejected by the validator', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(gb.applyVenue(cjson, 'm2', 'court-2') === null, 'applyVenue reports no error');
  assert(cjson.matches.find(m => m.id === 'm2').venue === 'court-2', 'venue moved');
  assert(gb.applyVenue(cjson, 'nope', 'court-2') === 'unknown match nope', 'unknown match reported');
  const repo2 = loadRepo(FIX('sample'));
  gb.applyVenue(repo2.tournaments.get('sample').matches.get('md40'), 'm2', 'bogus-court');
  assert(hasErr(validateRepo(repo2), /unknown venue "bogus-court"/), 'undeclared venue rejected');
});

test('gb rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  gb.applyScore(cjson, 'm7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  gb.applyForfeit(repo2.tournaments.get('sample').matches.get('md40'), 'm9', 1); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
});

test('gb parseGame', () => {
  assert(JSON.stringify(gb.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(JSON.stringify(gb.parseGame('11:9')) === JSON.stringify({ a: 11, b: 9 }), 'a:b parses');
  assert(gb.parseGame('11x9') === null, 'bad shape is null');
});

test('gb parseCmd: every line is a command — the first word is the verb', () => {
  assert.deepEqual(gb.parseCmd('score m1 11:9 11:7'), { kind: 'score', args: ['m1', '11:9', '11:7'] });
  assert.deepEqual(gb.parseCmd('ff m1 1'), { kind: 'ff', args: ['m1', '1'] });
  assert.deepEqual(gb.parseCmd('venue m1 court-2'), { kind: 'venue', args: ['m1', 'court-2'] });
  assert.deepEqual(gb.parseCmd('push'), { kind: 'push', args: [] });
  assert.deepEqual(gb.parseCmd('cd md40'), { kind: 'cd', args: ['md40'] });
  assert.deepEqual(gb.parseCmd('q'), { kind: 'q', args: [] });
  assert.deepEqual(gb.parseCmd('md40'), { kind: 'unknown', args: [] }, 'bare words are not commands');
  assert.deepEqual(gb.parseCmd('/score m1'), { kind: 'unknown', args: ['m1'] }, 'slashes are not commands');
});

test('gb navigate: root → tournament → category, up and root shortcuts', () => {
  const repo = loadRepo(FIX('sample'));
  const root = { repo, slug: null, cat: null };
  assert.deepEqual(gb.navigate(root, 'sample'), { slug: 'sample', cat: null });
  assert.deepEqual(gb.navigate(root, 'nope').err, 'unknown tournament nope — tab completes', 'unknown slug errors');
  const tour = { repo, slug: 'sample', cat: null };
  assert.deepEqual(gb.navigate(tour, 'md40'), { slug: 'sample', cat: 'md40' }, 'category entered');
  assert.deepEqual(gb.navigate(tour, 'nope').err, 'unknown category nope — tab completes', 'unknown category errors');
  const cat = { repo, slug: 'sample', cat: 'md40' };
  assert.deepEqual(gb.navigate(cat, 'm1').err, 'matches are leaves — score m1 … or cd ..', 'matches are leaves');
  assert.deepEqual(gb.navigate(cat, '..'), { slug: 'sample', cat: null }, '.. goes up to the tournament');
  assert.deepEqual(gb.navigate(tour, '..'), { slug: null, cat: null }, '.. from a tournament goes to root');
  assert.deepEqual(gb.navigate(cat, '/'), { slug: null, cat: null }, '/ goes to root');
});

test('gb commitMessage: conventional types with tournament scope', () => {
  assert.equal(gb.commitMessage('score', '2026-mammut60', 'md40', 'm1', '11:9 · 11:7'), 'score(2026-mammut60): md40/m1 11:9 · 11:7');
  assert.equal(gb.commitMessage('forfeit', '2026-mammut60', 'md', 'm7', 'side 1'), 'forfeit(2026-mammut60): md/m7 side 1');
  assert.equal(gb.commitMessage('venue', '2026-mammut60', 'xd', 'm3', '→ court-2'), 'venue(2026-mammut60): xd/m3 → court-2');
});

test('gb writeEdit: rollback on validation failure, write on success (real disk)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = gb.writeEdit(dataRoot, repo, 'sample', 'md40', c => gb.applyScore(c, 'm7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7mem.forfeit === 1 && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = gb.writeEdit(dataRoot, repo, 'sample', 'md40', c => gb.applyScore(c, 'm7', [{ a: 11, b: 5 }]));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7.games.length === 1 && m7.forfeit === undefined, 'games applied and the forfeit cleared');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gb filterErrs: validate <slug> narrows to that tournament', () => {
  const errs = [
    'site/tournaments/2026-mammut60.json: name does not match the index entry',
    'tournaments.json [0]: duplicate slug 2026-mammut60',
    'site/tournaments/other.json: timezone required',
  ];
  const got = gb.filterErrs(errs, '2026-mammut60');
  assert.equal(got.length, 2, 'keeps the tournament file and its index entry');
  assert(!got.some(e => e.includes('other.json')), 'other tournaments stay out');
});
