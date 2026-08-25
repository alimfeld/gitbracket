'use strict';

// Derive engine (site/derive.js) + renderers (site/app.js): tournament page,
// slot resolution, scheduling, labels.
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, poolRanks, resolveSide, matchRound, playerMatches, reachableKo, possibleSpan, matchSlotMs, slotLabel, roundName, placementLabel, koColumn, koOrdinal, kioskStatus, matchLabel, schedTime, toCats, isDeadTie } = require('../site/derive.js');
const { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer } = require('../site/app.js');
const { generate } = require('../src/schedule.js');
const { FIX, catOf } = require('./helpers.js');
const { loadRepo } = require('../src/tools.js');

const sameRecord = (a, b) => a.wins === b.wins && a.gd === b.gd && a.pd === b.pd; // test-only — derive.js doesn't ship it

test('parseRoute: fragment routing — bare slug is the tournament page, params id-gated, unknown input ignored', () => {
  assert.deepEqual(parseRoute(''), { view: 'index' }, 'no fragment: tournament list');
  assert.deepEqual(parseRoute('#'), { view: 'index' });
  assert.deepEqual(parseRoute('#2026-mammut60'), { slug: '2026-mammut60', view: 'tournament' }, 'bare slug: the tournament page, first category');
  assert.deepEqual(parseRoute('#2026-mammut60/schedule'), { slug: '2026-mammut60', view: 'schedule' }, 'schedule without a player: the picker');
  assert.deepEqual(parseRoute('#2026-mammut60/schedule?player=p1&cat=md'), { slug: '2026-mammut60', view: 'schedule', player: 'p1', cat: 'md' }, 'params in any parse order — cat rides through the schedule view');
  assert.deepEqual(parseRoute('#2026-mammut60?cat=md40'), { slug: '2026-mammut60', view: 'tournament', cat: 'md40' }, 'cat selects the category on the tournament page');
  assert.deepEqual(parseRoute('#2026-mammut60?cat=bad!'), { slug: '2026-mammut60', view: 'tournament' }, 'a bad cat value is ignored, never fatal');
  assert.equal(parseRoute('#2026-mammut60#md'), null, 'fragment anchors are dead — selection is a param now');
  assert.deepEqual(parseRoute('#2026-mammut60/venues'), { slug: '2026-mammut60', view: 'venues' });
  assert.deepEqual(parseRoute('#2026-mammut60/venues?venue=court-1'), { slug: '2026-mammut60', view: 'venues', venue: 'court-1' });
  assert.deepEqual(parseRoute('#2026-mammut60/venues?venue=Court%201'), { slug: '2026-mammut60', view: 'venues' }, 'param value failing the id regex is ignored, not fatal');
  assert.deepEqual(parseRoute('#2026-mammut60?bogus=x&cat=md'), { slug: '2026-mammut60', view: 'tournament', cat: 'md' }, 'unknown param names are ignored');
  assert.equal(parseRoute('#2026-mammut60/players'), null, 'legacy players route is dead');
  assert.equal(parseRoute('#2026-mammut60/me'), null, 'legacy me route is dead');
  assert.equal(parseRoute('#2026-mammut60/categories/md'), null, 'legacy categories/<id> route is dead — filters are query params now');
  assert.equal(parseRoute('#2026-mammut60/bogus'), null, 'unknown view');
  assert.equal(parseRoute('#2026-mammut60/venues/'), null, 'empty segment');
  assert.equal(parseRoute('#2026-mammut60/schedule/x'), null, 'too many segments');
  assert.equal(parseRoute('#../..'), null, 'traversal rejected');
  assert.equal(parseRoute('#/'), null, 'no slug');
});

test('loadAll: a slug route fetches only the tournament file; the index view only the index', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = url => { // fetchJson passes { cache: 'no-cache' }; the stub ignores it
    calls.push(url);
    const body = {
      'tournaments.json': [{ slug: 'sample', name: 'Sample', dates: ['2025-07-14'] }],
      'tournaments/sample.json': require(FIX('sample', 'tournaments', 'sample.json')),
    }[url] ?? null;
    return body === null ? Promise.resolve({ ok: false }) : Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  try {
    const slug = await loadAll({ slug: 'sample', view: 'tournament' });
    assert.deepEqual(calls, ['tournaments/sample.json'], 'slug route: one fetch, no index roundtrip');
    assert.equal(slug.t.name, 'Sample', 'name comes from the tournament file');
    assert.equal(slug.t.slug, 'sample', 'slug comes from the route');
    assert(slug.tjson && slug.cats.length > 0, 'tournament data and categories load');
    const list = await loadAll({ view: 'index' });
    assert.deepEqual(calls, ['tournaments/sample.json', 'tournaments.json'], 'index view: fetches only the index');
    assert.equal(list.index[0].slug, 'sample');
    assert.deepEqual(list.index[0].dates, ['2025-07-14'], 'the stored ISO days ride through untouched — one fetch, no per-file roundtrips');
    assert.equal(list.tjson, undefined, 'index view carries no tournament data');
    const missing = await loadAll({ slug: 'nope', view: 'tournament' });
    assert.equal(missing.t, null, 'unknown slug: tjson 404s to null');
    assert.equal(missing.tjson, null, 'no crash on a 404');
  } finally {
    global.fetch = origFetch;
  }
});

test('pool A standings: 4 sides, order, leader record', () => {
  const md = catOf('sample', 'md40');
  const st = poolStandings(md, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1|p2' && st[1].sig === 'p3|p4' && st[3].sig === 'p7|p8', 'pool A order by wins/gd/pd');
  assert(st[0].wins === 3 && st[0].gd === 6 && st[0].pd === 31, 'leader record');
});

test('standings tiebreak: wins, then head-to-head, then differentials', () => {
  const ctx = catOf('tiebreak', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 beat p2 head-to-head — the higher point differential does not rescue p2');
  assert(st[0].wins === 2 && st[0].gd === 2 && st[0].pd === 3, 'p1 record');
  assert(st[1].wins === 2 && st[1].gd === 1 && st[1].pd === 5, 'p2 record');
});

test('h2h ladder: head-to-head winner ranks above the overall-differential leader', () => {
  const ctx = catOf('h2h', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 won the p1-p2 match — p2 leads overall gd yet ranks 2nd');
  assert(st[0].wins === 2 && st[0].gd === 1 && st[1].wins === 2 && st[1].gd === 2, 'same wins, p2 better overall gd');
  assert(st[2].sig === 'p3' && st[3].sig === 'p4', 'lower pair also splits by h2h');
  assert(!isDeadTie(st, 1) && !isDeadTie(st, 2), 'both resolved — no TBD');
  const slot = resolveSide(ctx.byId.get(13).sides[0], ctx);
  assert(slot && slot.has('p1'), 'rank-1 slot takes the h2h winner, not the gd leader');
});

test('h2h ladder: tied trio recurses — the pair splits via their mutual match', () => {
  const ctx = catOf('h2h', 't');
  const st = poolStandings(ctx, 'B');
  assert(st && st.length === 4, 'pool B has 4 sides');
  assert(st[0].sig === 'p5', 'p5 separates on overall gd');
  assert(sameRecord(st[1], st[2]) && st[1].sig === 'p6' && st[2].sig === 'p7', 'p6 and p7 share a full record — only the mutual match separates them');
  assert(!isDeadTie(st, 2), '2nd place resolves via recursion, not TBD');
  const slot = resolveSide(ctx.byId.get(14).sides[0], ctx);
  assert(slot && slot.has('p6'), 'rank-2 slot resolves to p6');
});

test('xd pool order', () => {
  const st = poolStandings(catOf('sample', 'xd'), 'A');
  assert(st && st[0].sig === 'p1|p3' && st[0].wins === 3, 'xd pool order');
});

test('walkover and partial-match detection', () => {
  const md = catOf('sample', 'md40');
  assert(winnerIdx(md.byId.get(7)) === 0, 'walkover side b -> side a wins');
  assert(winnerIdx(md.byId.get(8)) === null, 'partial match is not done');
  assert(isDone(md.byId.get(7)) && isDone(md.byId.get(1)), 'done detection');
});

test('slot resolution: walkover winner vs in-play TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get(9);
  const w7 = resolveSide(m9.sides[0], md);
  assert(w7 && w7.has('p1') && w7.has('p2'), 'winner of walkover m7 resolves to p1/p2');
  assert(resolveSide(m9.sides[1], md) === null, 'winner of in-play m8 -> TBD');
});

test('resolveSide: string ids on a players side is TBD, never a char-split team', () => {
  const ctx = makeCat({ meta: {}, matches: [
    { id: 1, sides: [{ kind: 'players', ids: 'p1' }, { kind: 'players', ids: ['p2'] }] },
  ] }, { timezone: 'UTC', players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] });
  assert.equal(resolveSide(ctx.byId.get(1).sides[0], ctx), null, 'a string ids would char-split in Set — must resolve to nothing instead');
  const ok = resolveSide(ctx.byId.get(1).sides[1], ctx);
  assert(ok && ok.has('p2'), 'an array ids beside it still resolves');
});

test('slot resolution: loser path (bronze/placement)', () => {
  const md = catOf('sample', 'md40');
  const m10 = md.byId.get(10);
  const l7 = resolveSide(m10.sides[0], md);
  assert(l7 && l7.has('p7') && l7.has('p8'), 'loser of walkover m7 resolves to p7/p8');
  assert(resolveSide(m10.sides[1], md) === null, 'loser of in-play m8 -> TBD');
});

test('matchSlotMs: match override > per-stage category config, no default', () => {
  assert(matchSlotMs({ pool: 'A' }, { slotMinutes: { groups: 60 } }) === 60 * 60000, 'pool match takes the groups slot');
  assert(matchSlotMs({}, { slotMinutes: { knockout: 60 } }) === 60 * 60000, 'knockout match takes the knockout slot');
  assert(matchSlotMs({ slotMinutes: 90 }, { slotMinutes: { knockout: 60 } }) === 90 * 60000, 'match override wins');
  assert(Number.isNaN(matchSlotMs({}, {})), 'no config, no override → NaN');
  assert(Number.isNaN(matchSlotMs({}, { slotMinutes: { groups: 60 } })), 'groups config does not leak into knockout → NaN');
});

test('kioskStatus: delayed / due / upcoming status per open card', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 }, slotMinutes: { groups: 30, knockout: 45 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }], result: { status: 'played', winner: 'a' } },
    { id: 'm2', scheduled: '2025-07-14T08:30:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm3', scheduled: '2025-07-14T09:45:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm4', scheduled: '2025-07-14T10:30:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm5', scheduled: '2025-07-14T11:15:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm6', scheduled: '2025-07-14T10:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T10:00:00Z'); // m2's slot ended 09:15 — long delayed
  const rows = ctx.matches.map(m => ({ m, t: schedTime(m, ctx.tz), ctx }));
  const st = id => kioskStatus(rows.find(r => r.m.id === id), now);
  assert(st('m2') === 'delayed', 'slot fully elapsed without a result: delayed');
  assert(st('m3') === 'due' && st('m6') === 'due', 'started and still inside its slot: Due');
  assert(isDone(ctx.byId.get('m1')), 'a done match leaves the board');
  assert(st('m4') === 'next' && st('m5') === 'next', 'future starts: upcoming');
  assert(st('m6') === 'due', 'the boundary instant (now === t) belongs to Due, not Next');
});

test('matchLabel: pool, placement, and round names on one card label', () => {
  const full = catOf('full', 't');
  assert(matchLabel(full.byId.get(1), full) === 'Pool A', 'pool match labels its pool');
  assert(matchLabel(full.byId.get(7), full) === 'SF1', 'semifinal with bracket ordinal');
  assert(matchLabel(full.byId.get(8), full) === 'SF2', 'second semifinal');
  assert(matchLabel(full.byId.get(10), full) === 'Final', 'final');
  assert(matchLabel(full.byId.get(9), full) === '3rd place', 'bronze via placementLabel');
  const md = catOf('sample', 'md40');
  assert(matchLabel(md.byId.get(9), md) === 'Final' && matchLabel(md.byId.get(10), md) === '3rd place', 'sample: m9 final, m10 bronze');
});

test('reachableKo: undecided feeder keeps both branches; decided feeder gates the closed one', () => {
  const md = catOf('sample', 'md40');
  const ids = pid => [...reachableKo(md, pid)].sort().join(',');
  assert(ids('p5') === '10,9', 'p5: final and bronze both open while m8 is undecided');
  assert(ids('p1') === '' && ids('p7') === '', 'p1/p7: decided feeders close the losing/winning branch');
});

test('possibleSpan: open knockout span, and pre-knockout fallback to the bracket block', () => {
  const md = catOf('sample', 'md40');
  const s = possibleSpan(md, 'p5');
  assert(s && s.count === 1 && s.min === Date.parse('2025-07-14T12:15:00-04:00') && s.max === s.min, 'p5: final or bronze at 12:15 — one more match, not both');
  assert(possibleSpan(md, 'p1') === null && possibleSpan(md, 'p7') === null, 'confirmed knockout seat (final/bronze) leaves no open span');
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const pre = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => ({ ...m, games: [], result: undefined })) }, tjson);
  const s0 = possibleSpan(pre, 'p1');
  assert(s0 && s0.count === 2 && s0.min === Date.parse('2025-07-14T11:15:00-04:00') && s0.max === Date.parse('2025-07-14T12:15:00-04:00'), 'pre-event: up to 2 matches along one bracket path (m7 -> final/bronze, 11:15 to 12:15)');
});

test('playerMatches: only matches the player is actually in, not potential slots', () => {
  const md = catOf('sample', 'md40');
  const ids = pid => playerMatches(md, pid).map(r => r.m.id).sort();
  assert(ids('p1').join() === '1,3,5,7,9', 'p1: pool + semifinal + final, not bronze m10 (won m7)');
  assert(ids('p7').join() === '10,2,4,5,7', 'p7: pool + m7 + bronze m10, not final m9 (lost m7)');
  assert(ids('p5').join() === '2,3,6,8', 'p5: pool + m8; m9/m10 stay off until m8 is decided');
});

test('full bracket: every slot resolves end to end (winner and loser paths)', () => {
  const full = catOf('full', 't');
  const f = full.byId.get(10), b = full.byId.get(9);
  const w0 = resolveSide(f.sides[0], full), w1 = resolveSide(f.sides[1], full);
  assert(w0 && w0.has('p1') && w1 && w1.has('p5'), 'final resolves to p1 vs p5');
  assert(winnerIdx(f) === 0, 'final winner is p1');
  const l0 = resolveSide(b.sides[0], full), l1 = resolveSide(b.sides[1], full);
  assert(l0 && l0.has('p6') && l1 && l1.has('p2'), 'bronze resolves to p6 vs p2');
});

test('walkover inside a pool: counts a win, no gd/pd', () => {
  const full = catOf('full', 't');
  const st = poolStandings(full, 'A');
  const p1 = st.find(r => r.sig === 'p1');
  assert(p1 && p1.wins === 2 && p1.gd === 2 && p1.pd === 11, 'p1: walkover win + 2-0 win; gd/pd only from the played match');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2' && st[2].sig === 'p3', 'pool A order');
});

test('result statuses: walkover counts a win, void counts nothing, pool completes', () => {
  const res = catOf('result', 't');
  const st = poolStandings(res, 'A');
  assert(st && st.length === 3, 'a void match does not stall the pool');
  const rec = sig => st.find(r => r.sig === sig);
  assert(rec('p1').wins === 1 && rec('p1').gd === 1 && rec('p1').pd === 2, 'played win counts gd/pd');
  assert(rec('p3').wins === 1 && rec('p3').gd === 0 && rec('p3').pd === 0, 'walkover win counts, no gd/pd');
  assert(rec('p2').wins === 0 && rec('p2').losses === 2, 'walkover loss counts, void contributes nothing to either side');
  assert(st[0].sig === 'p1' && st[1].sig === 'p3', 'p1 separates on overall gd');
  assert(winnerIdx(res.byId.get(3)) === null && isDone(res.byId.get(3)), 'void: settled, no winner');
  const f = res.byId.get(4);
  assert(resolveSide(f.sides[0], res) && resolveSide(f.sides[1], res), 'pool ranks resolve despite the void');
});

test('result statuses render: W/O and void on cards, settled matches off the kiosk', () => {
  const repo = loadRepo(FIX('result'));
  const info = repo.tournaments.get('result');
  const data = { index: repo.index, t: repo.index[0], tjson: info.tjson, cats: toCats(info.tjson) };
  const st = renderTournament({ slug: 'result', view: 'tournament' }, data);
  assert(st.includes('<span>void</span>'), 'void renders on its card');
  // m2 is pool A, walkover winner b (p3): the W/O mark rides the winner's row
  assert(st.includes('<span>P3</span><span class="score"><span>W/O</span></span>'), 'W/O renders on the winning side');
  const venue = renderVenue({ slug: 'result', view: 'venues' }, data, Date.parse('2026-05-02T09:30:00Z'));
  assert(venue.includes('P1') && venue.includes('P3'), 'the open final is on the board');
  assert(!venue.includes('<span>void</span>') && !venue.includes('W/O'), 'settled (incl. void) matches leave the kiosk');
});

test('bracket depth', () => {
  const md = catOf('sample', 'md40');
  assert(matchRound(md.byId.get(7), md) === 0 && matchRound(md.byId.get(9), md) === 1 && matchRound(md.byId.get(10), md) === 1, 'bracket depth');
});

test('koColumn: a bye\'d semi sits in the semifinal column, not with round 1', () => {
  // Unbalanced field: sf2 is pool-vs-pool (a bye into the semis) while sf1
  // plays a round-1 survivor. Depth says sf2 is round 1; koColumn must say
  // semifinal.
  const ko = makeCat({ meta: {}, matches: [
    { id: 'r1', sides: [{ kind: 'pool', pool: 'B', rank: 2 }, { kind: 'pool', pool: 'A', rank: 3 }] },
    { id: 'sf1', sides: [{ kind: 'pool', pool: 'A', rank: 1 }, { kind: 'match', match: 'r1', result: 'winner' }] },
    { id: 'sf2', sides: [{ kind: 'pool', pool: 'B', rank: 1 }, { kind: 'pool', pool: 'A', rank: 2 }] },
    { id: 'f', sides: [{ kind: 'match', match: 'sf1', result: 'winner' }, { kind: 'match', match: 'sf2', result: 'winner' }] },
    { id: 'b', sides: [{ kind: 'match', match: 'sf2', result: 'loser' }, { kind: 'match', match: 'sf1', result: 'loser' }] },
  ] }, { timezone: 'UTC', players: [] });
  const col = id => koColumn(ko.byId.get(id), ko);
  assert(col('f') === 0 && col('sf1') === 1 && col('sf2') === 1 && col('r1') === 2 && col('b') === 0,
    'unbalanced bracket: final 0, both semis 1 (incl. bye\'d sf2), round 1 at 2, bronze with the final');
  // bye'd semi first in the bronze sides: loser origin must still read depth 1
  // (round below the final), not the bye'd match's leaf depth — else 5th–8th semi.
  assert(placementLabel(ko.byId.get('b'), ko) === '3rd place', 'bronze of a bye\'d semi is 3rd place, not a classification round');
  const full = catOf('full', 't');
  assert(koColumn(full.byId.get(10), full) === 0 && koColumn(full.byId.get(7), full) === 1 && koColumn(full.byId.get(9), full) === 0,
    'balanced bracket unchanged: final 0, semis 1, bronze with the final');
});

test('dead tie: standings tie + pool slot TBD', () => {
  const tie = catOf('tie', 't');
  const st = poolStandings(tie, 'A');
  assert(st && st.length === 2 && sameRecord(st[0], st[1]), 'tie detected in standings');
  assert(resolveSide(tie.byId.get(3).sides[0], tie) === null, 'dead-tied pool slot -> TBD');
});

test('3-way dead tie: standings tie + pool slot TBD', () => {
  const tie3 = catOf('tie3', 't');
  const st = poolStandings(tie3, 'A');
  assert(st && st.length === 3 && sameRecord(st[0], st[1]) && sameRecord(st[1], st[2]), '3-way tie detected');
  assert(resolveSide(tie3.byId.get(4).sides[0], tie3) === null, '3-way dead-tied pool slot -> TBD');
});

test('poolRanks: dead-tie members share their group rank, resolved rows have their own', () => {
  assert.deepEqual(poolRanks(poolStandings(catOf('tie', 't'), 'A')), [1, 1], '2-way dead tie shares rank 1');
  assert.deepEqual(poolRanks(poolStandings(catOf('tie3', 't'), 'A')), [1, 1, 1], '3-way dead tie: all rank 1');
  const adj = poolStandings(catOf('adjtie', 't'), 'A');
  assert.deepEqual(adj.map(r => [r.wins, r.tie]), [[2, 1], [2, 1], [0, 2], [0, 2]], 'two adjacent dead-tie clusters, each with its own id');
  assert.deepEqual(poolRanks(adj), [1, 1, 3, 3], 'adjacent clusters keep separate ranks — 1 1 3 3, not 1 1 1 1');
  assert.deepEqual(poolRanks(poolStandings(catOf('sample', 'md40'), 'A')), [1, 2, 3, 4], 'resolved ladder: sequential ranks');
  const h2h = poolStandings(catOf('h2h', 't'), 'B'); // p6/p7 resolve via the mutual match, no tie flag
  assert.deepEqual(poolRanks(h2h), [1, 2, 3, 4], 'head-to-head separations are resolved rows, each its own rank');
});

test('slotLabel: unresolved slots describe the slot, not bare TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get(9);
  assert(slotLabel(m9.sides[0], md) === 'Winner of SF1', 'winner slot names the feeder by bracket ordinal');
  assert(slotLabel(m9.sides[1], md) === 'Winner of SF2', 'unresolved match slot still names the feeder');
  assert(slotLabel(md.byId.get(10).sides[0], md) === 'Loser of SF1', 'loser slot names the feeder');
  const st = md.byId.get(7).sides[0];
  assert(slotLabel(st, md) === '1st in Pool A', 'pool slot labels rank');
  assert(slotLabel(md.byId.get(8).sides[1], md) === '3rd in Pool A', 'rank 3 ordinal');
});

test('koOrdinal: bracket ordinals are structural — schedule edits cannot renumber them', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const raw = catOf('sample', 'md40').matches.map(m => ({ ...m }));
  const t7 = raw.find(m => m.id === 7).scheduled, t8 = raw.find(m => m.id === 8).scheduled;
  raw.find(m => m.id === 7).scheduled = t8; // swap the two SFs on the clock
  raw.find(m => m.id === 8).scheduled = t7;
  const md = makeCat({ meta: tjson.categories[0], matches: raw }, tjson);
  assert(matchLabel(md.byId.get(7), md) === 'SF1' && matchLabel(md.byId.get(8), md) === 'SF2', 'labels read who feeds the final, not the clock');
  assert(slotLabel(md.byId.get(9).sides[0], md) === 'Winner of SF1' && slotLabel(md.byId.get(9).sides[1], md) === 'Winner of SF2', 'references hold under schedule edits');
});

test('bracket: slot labels are plain text — no link wrapping, no trace machinery', () => {
  const data = (() => {
    const repo = loadRepo(FIX('sample'));
    const info = repo.tournaments.get('sample');
    return { repo, data: { index: repo.index, t: repo.index[0], tjson: info.tjson, cats: toCats(info.tjson) } };
  })().data;
  const html = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  assert(html.includes('<span>Winner of SF2</span>') && !html.includes('<a href="#m-'), 'slot labels are plain text, not anchors');
  assert(!html.includes('data-feeders') && !html.includes('id="m-'), 'cards are static nodes — the trace graph shipped nothing');
});

test('poolStandings partial: unfinished pool still yields a live table', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const md = catOf('sample', 'md40');
  const unfinished = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => m.id === 6 ? { ...m, games: [], result: undefined } : m) }, tjson);
  assert(poolStandings(unfinished, 'A') === null, 'strict form still TBDs an unfinished pool');
  const live = poolStandings(unfinished, 'A', true);
  assert(live && live.length === 4, 'partial form lists all sides');
  assert(live.reduce((n, r) => n + r.wins, 0) === 5, 'only finished matches count');
});

test('roundName: structural knockout names by depth from the final', () => {
  assert(roundName(0) === 'Final', 'depth 0 is the Final');
  assert(roundName(1) === 'Semifinals' && roundName(2) === 'Quarterfinals', 'small-bracket names');
  assert(roundName(3) === 'Round of 16' && roundName(4) === 'Round of 32' && roundName(5) === 'Round of 64', 'big-bracket names');
});

test('placementLabel: 3rd/5th/7th place and classification semis', () => {
  const pl = catOf('place', 'pl');
  const L = id => placementLabel(pl.byId.get(id), pl);
  assert(L(7) === null && L(5) === null && L(1) === null, 'final/semis/quarters are not placement matches');
  assert(L(8) === '3rd place', 'losers of semis -> 3rd place');
  assert(L(9) === '5th–8th semi', 'losers of quarters -> classification semi');
  assert(L(11) === '5th place', 'winners of classification semis -> 5th place');
  assert(L(12) === '7th place', 'losers of classification semis -> 7th place');
});

test('placementLabel: depth-3 classification (16 teams, placements 16) labels every slot', () => {
  const teams = Array.from({ length: 16 }, (_, i) => [`p${i}`]);
  const tourney = generate({
    slug: 'deep', name: 'Deep', location: 'Geneva', timezone: 'UTC', date: '2026-05-02', poolSize: 4,
    blocks: { t: '09:00' }, venues: { 'court-1': 'Court 1' },
    players: Object.fromEntries(teams.map(([id]) => [id, id])),
    categories: [{ id: 't', name: 'Single', bestOf: 1, slotMinutes: 30, placements: 16 }],
    teams: { t: teams },
  });
  const ctx = makeCat({ meta: tourney.categories[0], matches: tourney.matches.t }, tourney);
  const labels = ctx.matches.filter(m => m.pool === undefined).map(m => matchLabel(m, ctx));
  const count = l => labels.filter(x => x === l).length;
  assert.equal(count('Final'), 1);
  assert.equal(count('SF1'), 1);
  assert.equal(count('SF2'), 1);
  assert.equal(count('QF'), 0);
  assert.deepEqual([1, 2, 3, 4].map(n => count('QF' + n)), [1, 1, 1, 1], 'QFs numbered by bracket position');
  assert.equal(count('Round of 16'), 8);
  assert.equal(count('3rd place'), 1, 'bronze');
  assert.equal(count('5th–8th semi'), 2, 'QF losers');
  assert.equal(count('5th place'), 1, '5th/6th');
  assert.equal(count('7th place'), 1, '7th/8th');
  assert.equal(count('9th–16th semi'), 4, 'R16 losers');
  assert.equal(count('9th–12th semi'), 2, 'winner-fed depth-3 semis');
  assert.equal(count('13th–16th semi'), 2, 'loser-fed depth-3 semis');
  for (const l of ['9th place', '11th place', '13th place', '15th place']) assert.equal(count(l), 1, l);
});

test('place8: 8-team classification bracket labels resolve from a committed fixture', () => {
  const p8 = catOf('place8', 't');
  const L = id => placementLabel(p8.byId.get(id), p8);
  // Round 1 (QF): pool slots, not placement matches
  assert(L(13) === null && L(14) === null && L(15) === null && L(16) === null, 'R1 pool-slot matches are not placement');
  // Semifinals and final are not placement
  assert(L(17) === null && L(18) === null && L(19) === null, 'SF and final are not placement');
  // Bronze match (losers of SFs)
  assert(L(20) === '3rd place', 'losers of semis -> 3rd place');
  // Classification semis (losers of QFs)
  assert(L(21) === '5th–8th semi', 'losers of QF round 1 -> classification semi');
  assert(L(22) === '5th–8th semi', 'losers of QF round 2 -> classification semi');
  // Classification finals
  assert(L(23) === '5th place', 'winners of classification semis -> 5th place');
  assert(L(24) === '7th place', 'losers of classification semis -> 7th place');
});

test('renderers: all four render from a repo and escape repo-sourced strings', () => {
  const dataOf = name => {
    const repo = loadRepo(FIX(name));
    const info = repo.tournaments.get(name);
    return {
      repo,
      data: {
        index: repo.index,
        t: repo.index[0],
        tjson: info.tjson,
        cats: toCats(info.tjson),
      },
    };
  };
  const { data } = dataOf('sample');
  const no = () => ({ slug: 'sample', view: 'tournament' });
  const standings = renderTournament(no(), data);
  assert(!standings.includes('data-feeders') && !standings.includes('data-hl') && !standings.includes('data-cat'), 'nothing of the old trace machinery ships — cards are static');
  assert(standings.includes('Pool A') && standings.includes('Final') && standings.includes('Winner of SF2'), 'standings renders pools, bracket, and slot labels');
  assert(!standings.includes('BO3'), 'no best-of label — the score slots carry it');
  assert(standings.includes('class="ph"'), 'unplayed best-of slots render as placeholders');
  assert(standings.includes('Ada Lovelace'), 'standings renders player names');
  assert(standings.includes('Pool A · Court 1 · <time datetime=') && !standings.includes('md40 · Pool A'), 'standings card meta: label · venue · time element, no match id, no category id');
  assert(standings.includes('<nav class="segments" aria-label="Views"><a href="#sample" aria-current="true">Tournament</a><a href="#sample/schedule">My Schedule</a></nav>'), 'tournament page: segment switch, Tournament current');
  assert((standings.match(/<h2\b/g) || []).length === 1 && standings.includes('Pool A'), 'one category per page — the bare slug shows the first');
  const xd = renderTournament({ slug: 'sample', view: 'tournament', cat: 'xd' }, data);
  assert((xd.match(/<h2\b/g) || []).length === 1 && xd.includes('<h2>Mixed Doubles</h2>'), '?cat= selects the category');
  assert(renderTournament({ slug: 'sample', view: 'tournament', cat: 'nope' }, data).includes('<h2>Men&#39;s Doubles 40+</h2>'), 'an unknown cat falls back to the first');
  assert(standings.includes('<nav class="cats" aria-label="Categories"><a href="#sample" aria-current="true">Men&#39;s Doubles 40+</a><a href="#sample?cat=xd">Mixed Doubles</a></nav>'), 'the category switcher: first segment canonical at the bare slug, the rest carry ?cat=');
  assert(xd.includes('<a href="#sample?cat=xd" aria-current="true">Mixed Doubles</a>') && !xd.includes('aria-current="true">Men&#39;s'), 'the switcher lights the selected category');
  assert(standings.includes('>Men&#39;s Doubles 40+</a>') && !standings.includes('>md40</a>'), 'switcher labels show the category name, never the id');
  assert(standings.indexOf('<nav class="cats"') < standings.indexOf('<h2>Men&#39;s'), 'the switcher precedes the category heading');
  const venue = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T12:00:00-04:00')); // pinned to the fixture day — the kiosk shows today only
  assert(venue.includes('Court 1') && venue.includes('Ada Lovelace'), 'venue page renders venue boards with match rows');
  assert(venue.includes('data-status=') && !venue.includes('badge'), 'kiosk card: status rides the article (headline time colored); meta keeps cat · label only');
  assert(venue.includes('style="--cols: 2"') && venue.includes('</h2><div></div>'), 'kiosk board: one grid row-major, columns per venue, holes as empty cells');
  const early = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T08:00:00-04:00'));
  const late = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T16:00:00-04:00'));
  assert(!early.includes('delayed</span>'), 'before the first start: no delayed remark');
  assert(late.includes('<span>delayed</span>'), 'slot fully elapsed: the headline time carries the remark beside it');
  const running = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T12:20:00-04:00'));
  assert(running.includes('<span>due</span>'), 'a match inside its slot says due in words, not hue alone');
  assert(late.match(/<span>delayed<\/span>/g).length === late.match(/data-status="delayed"/g).length, 'every delayed card has the remark, and only delayed cards do');
  assert(venue.includes("Men&#39;s Doubles 40+ · Final") && !venue.includes("Men&#39;s Doubles 40+ · 9 ·"), 'kiosk meta shows the long category name and label, no match id');
  assert(!venue.includes('<nav>'), 'kiosk has no breadcrumb');
  assert(standings.includes('<h2>Men&#39;s Doubles 40+</h2><p class="note">Knockout stage · Semifinals</p>') && !standings.includes('<h2 id='), 'category h2: plain in-flow heading, status-only subline (the single-day heading already stated the date)');
  assert(standings.includes('<h1>Sample</h1>') && standings.includes('<p class="note">Mon, Jul 14 · New York</p>'), 'one-day tournament: the heading subline states the date and the location');
  assert(!standings.includes('class="day"') && !standings.includes('Jul 14, '), 'single-day: no day dividers anywhere, and cards carry just the time');
  assert(xd.includes('<h2>Mixed Doubles</h2><p class="note">Finished</p>'), 'a fully decided category: status-only subline on a single-day page');
  assert(standings.includes('<h3>Group stage</h3><div class="grid">'), 'group stage: pools first under the heading');
  assert(standings.includes('</div><h4>Group matches</h4><div class="grid">'), 'group stage: pools, then the Matches h4, then the cards');
  assert(!standings.includes('Pools</h3>') && !standings.includes('md40:pools'), 'pools are part of the group stage — no separate heading, no fold of their own');
  assert(standings.includes('Pool A</h4>'), 'pool heading stands alone — no advance note');
  assert(standings.indexOf('<div class="grid">') < standings.indexOf('<h4>Group matches</h4>'), 'pools lead the group matches inside the stage');
  assert(standings.indexOf('Group stage</h3>') < standings.indexOf('Knockout stage</h3>'), 'schedule before the bracket — chronological flow');
  assert(standings.includes('<h3>Knockout stage</h3><h4>Semifinals</h4><div class="grid">'), 'knockout: rounds and cards — always open, no count subline');
  // mid-groups state: an unresolved group match opens the schedule and re-counts the chip
  const midJson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  midJson.matches.md40[0].result = undefined;
  const mid = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' },
    { index: [], t: { slug: 'sample', name: midJson.name }, tjson: midJson,
      cats: toCats(midJson) });
  assert(mid.includes('<p class="note">Group stage · 5 of 6 played, next <time datetime="2025-07-14T13:00:00.000Z">09:00</time></p>'), 'running groups: the subline carries the phase, the next slot is a semantic <time>');
  assert(mid.includes('</div><h4>Group matches</h4><div class="grid">'), 'running groups: pools, then the Matches h4, then the cards — the status lives in the category subline');
  assert(!mid.includes('data-stage') && !mid.includes('toggle'), 'no disclosure machinery ships — nothing hides, nothing toggles');
  const { data: rdata } = dataOf('result');
  const res = renderTournament({ slug: 'result', view: 'tournament' }, rdata);
  assert(!res.includes('advance'), 'partial draw: no advance note on pool headings');
  // the pool roster is the "who is in my pool" answer — it must render before the first result
  const preJson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  for (const ms of Object.values(preJson.matches)) for (const m of ms) { delete m.result; delete m.games; }
  const pre = renderTournament({ slug: 'sample', view: 'tournament' },
    { index: [], t: { slug: 'sample', name: preJson.name }, tjson: preJson,
      cats: toCats(preJson) });
  assert(pre.includes('<div class="grid">') && pre.includes('>Ada Lovelace / Grace Hopper</td>'), 'pools roster (teams) is visible before the first result');
  assert(pre.includes('<p class="note">Starts '), 'pre-start status line');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  assert(ppage.includes('<h1>Ada Lovelace</h1>'), 'player page: plain name');
  assert(!ppage.includes('data-next'), 'no next-match highlight — the unscored card is its own marker');
  assert(!ppage.includes('class="day"') && !ppage.includes('>2025-07-14'), 'single-day player page: no day dividers, friendly dates never render as text payload');
  const p3 = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p3' }, data);
  assert(/note">\d+ more match(?:es)? possible in Men&#39;s Doubles 40\+ (— earliest <time datetime="[^"]+">\d\d:\d\d<\/time>, latest <time datetime="[^"]+">\d\d:\d\d<\/time>|at <time datetime="[^"]+">\d\d:\d\d<\/time>)/.test(p3), 'possible note: count + window in semantic <time> elements');
  assert(ppage.includes('<div class="head"><span><time datetime=') && ppage.includes('</time></span><span>Court 1</span></div>'), 'player card headline: time left (semantic <time>), court right');
  assert(ppage.includes("Men&#39;s Doubles 40+ · Pool A") && !ppage.includes('Men&#39;s Doubles 40+ · Pool A · '), 'player card meta: long cat name · label, no match id, no court/time');
  assert(ppage.includes('class="ph"'), 'player match cards render unplayed score slots too');
  assert(ppage.includes('Ada Lovelace'), 'player page finds the player');
  assert(ppage.includes('<nav class="segments" aria-label="Views"><a href="#sample?player=p1">Tournament</a><a href="#sample/schedule?player=p1" aria-current="true">My Schedule</a></nav>'), 'player page: segment switch, My Schedule current, pick preserved in links');
  assert(ppage.includes('<p class="note"><span>Mon, Jul 14 · 7 W · 0 L</span><a href="#sample/schedule">Not you?</a></p>'), 'player page: single-day date + record and Not you? in the heading subline; the link drops the pick');
  assert(ppage.includes('#sample'), 'player page links the tournament name to the tournament page');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule' }, data);
  assert(picker.includes('<nav class="segments" aria-label="Views"><a href="#sample">Tournament</a><a href="#sample/schedule" aria-current="true">My Schedule</a></nav>'), 'picker: segment switch, My Schedule current');
  assert(picker.includes('<header><h1>Pick your player</h1></header>'), 'picker: heading invites the pick');
  assert(!picker.includes('pills') && !picker.includes('cat-label'), 'picker is minimal: no category pills, no category labels');
  assert(picker.includes('<li><a href="#sample/schedule?player=p1">Ada Lovelace</a></li>'), 'picker rows: plain name link carrying the player param');
  const listed = [...picker.matchAll(/<li><a href="#sample\/schedule\?player=p\d+">([^<]*)<\/a><\/li>/g)].map(m => m[1]);
  assert.deepEqual(listed, [...listed].sort((a, b) => a.localeCompare(b)), 'picker lists players alphabetically');
  assert(renderIndex({ view: 'index' }, data).includes('#sample'), 'index links the tournament');
  const idx = renderIndex({ view: 'index' }, { index: [
    { slug: 'soon', name: 'Later' },
    { slug: 'wide', name: 'Wide', dates: ['2026-07-11', '2026-07-12'] },
    { slug: 'sample', name: 'Sample', location: 'New York', dates: ['2025-07-14'] },
  ] });
  assert(idx.includes('<table>') && idx.includes('<th scope="col">Date</th>') && idx.includes('<th scope="col">Tournament</th>') && idx.includes('<th scope="col">Location</th>'), 'index is a dated table with a location column');
  assert(idx.indexOf('>Wide</a>') < idx.indexOf('>Sample</a>') && idx.indexOf('>Sample</a>') < idx.indexOf('>Later</a>'), 'sorted by start date descending, undated last');
  assert(idx.includes('<td>Mon, Jul 14</td><td><a href="#sample">Sample</a> · <a href="#sample/venues">Venue board</a></td><td>New York</td>'), 'columns: date, tournament (venue-board link rides along), location');
  assert(idx.includes('<td>Sat–Sun, Jul 11–12</td>'), 'multi-day spans collapse in the date cell');
  assert(idx.includes('<td></td><td><a href="#soon">Later</a>'), 'an undated tournament keeps an empty date cell');
  assert(!idx.includes('undefined') && !idx.includes('null'), 'no date renders clean, no null payload');
  // a registered player with no match anywhere is not pickable — the pick must always render a schedule
  const sparse = JSON.parse(JSON.stringify(data.tjson));
  sparse.players.push({ id: 'bench', name: 'Ben Ched' });
  const spr = renderPlayer({ slug: 'sample', view: 'schedule' }, { ...data, tjson: sparse });
  assert(spr.includes('Ada Lovelace') && !spr.includes('Ben Ched'), 'picker lists only participating players');
  // escaping: a hostile name must reach the DOM entity-encoded
  const evil = JSON.parse(JSON.stringify(data.tjson));
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  // hostile pool strings are free-form and land in the h4 heading — esc keeps them inert
  const evilPool = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  evilPool.matches.md40[0].pool = 'A" onclick="alert(1)';
  const pdata = { index: [], t: { slug: 'sample', name: evilPool.name }, tjson: evilPool,
    cats: toCats(evilPool) };
  const ph = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, pdata);
  assert(!ph.includes('<h4>Pool A" onclick='), 'the injected handler never lands in the DOM');
  assert(ph.includes('A&quot; onclick=&quot;alert(1)'), 'the pool string renders entity-encoded');
  // tied teams share the first rank of their group (standard competition ranking: 1 1 1 4)
  const { data: tdata } = dataOf('tie');
  const tieHtml = renderTournament({ slug: 'tie', view: 'tournament' }, tdata);
  assert(!tieHtml.includes('†') && (tieHtml.match(/data-tie><td class="num">1<\/td>/g) || []).length === 2, 'tied teams share rank 1, no dagger');
  assert(tieHtml.includes('dead ties on every tiebreaker'), 'the color-only tie highlight carries a one-line legend');
  // pre-play every team ties at zero — the highlight must wait for results
  assert(!pre.includes('data-tie'), 'nothing played yet: no tie highlight, no legend');
});


test('multi-day: cards carry their full date; single-day cards just the time; the kiosk shows one day at a time, previewing day one early', () => {
  const repo = loadRepo(FIX('multiday'));
  const info = repo.tournaments.get('multiday');
  const data = { index: repo.index, t: { slug: 'multiday', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const page = renderTournament({ slug: 'multiday', view: 'tournament' }, data);
  assert(page.includes('<p class="note">Sat–Sun, Jul 11–12 · Boston</p>'), 'the heading subline collapses consecutive days and gives the location');
  assert(page.includes('<h2>Men&#39;s Doubles 40+</h2><p class="note">Sat–Sun, Jul 11–12 · Group stage · 5 of 6 played, next <time datetime="2026-07-11T15:00:00.000Z">11:00</time></p>'), 'the category subline spans the range and the live status');
  assert(!page.includes('class="day"') && !page.includes('Pools</h3>'), 'no day dividers, no separate pools section');
  assert(page.includes('<time datetime="2026-07-11T13:00:00.000Z">Sat, Jul 11, 09:00</time>') && page.includes('<time datetime="2026-07-11T15:00:00.000Z">Sat, Jul 11, 11:00</time>'), 'Saturday cards carry the date with the time');
  assert(page.includes('<time datetime="2026-07-12T13:00:00.000Z">Sun, Jul 12, 09:00</time>') && page.includes('<time datetime="2026-07-12T15:00:00.000Z">Sun, Jul 12, 11:00</time>'), 'Sunday knockout cards carry the date too');
  assert(page.includes('</div><h4>Group matches</h4><div class="grid">'), 'the running group stage: pools, then the Matches h4, then the cards');
  assert(page.includes('<h3>Knockout stage</h3><h4>Semifinals</h4>') && page.includes('<h4>Final</h4>'), 'the knockout is always open — rounds listed in order');
  // moving a match to another day just re-dates its card — no divider machinery
  const split = JSON.parse(JSON.stringify(info.tjson));
  split.matches.md40[5].scheduled = '2026-07-12T15:00:00'; // m6 (pool) -> Sunday
  const spage = renderTournament({ slug: 'multiday', view: 'tournament' },
    { index: repo.index, t: data.t, tjson: split, cats: toCats(split) });
  assert(spage.includes('<time datetime="2026-07-12T19:00:00.000Z">Sun, Jul 12, 15:00</time>') && !spage.includes('class="day"'), 'a rescheduled pool match carries its new day on the card');
  const sInfo = loadRepo(FIX('sample')).tournaments.get('sample');
  const single = renderTournament({ slug: 'sample', view: 'tournament' },
    { index: repo.index, t: { slug: 'sample', name: sInfo.tjson.name }, tjson: sInfo.tjson, cats: toCats(sInfo.tjson) });
  assert(single.includes('<h1>Sample</h1>') && single.includes('<h2>Men&#39;s Doubles 40+</h2>') && single.includes('<p class="note">Mon, Jul 14 · New York</p>') && !single.includes('class="day"') && !single.includes('Jul 14, '), 'single-day tournament: one date in the heading subline, cards carry only the time');

  // kiosk: strict same-day in the tournament timezone, from the device clock instant
  const at = iso => Date.parse(iso);
  const sat = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-11T12:00:00-04:00'));
  assert(sat.includes('Katherine Johnson') && !sat.includes('>SF<') && !sat.includes('Final'), 'saturday board: open pool match, no tomorrow');
  assert(sat.includes('<p class="note">Today</p>'), 'today board: the note names the day shown');
  const sun = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-12T08:00:00-04:00'));
  assert(sun.includes('· SF') && sun.includes('· Final') && !sun.includes('Katherine Johnson'), 'sunday board: knockout only, yesterday gone');
  const mon = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-13T12:00:00-04:00'));
  assert(mon.includes('Nothing scheduled.'), 'after the last day: drained board, not a stale schedule');
  const fri = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-10T12:00:00-04:00'));
  assert(fri.includes('Katherine Johnson') && !fri.includes('>SF<') && !fri.includes('Final'), 'a day before day one: the board previews the first day, pools only');
  assert(fri.includes('<p class="note">Sat, Jul 11</p>'), 'the preview note names the day shown, not today');
});

test('date spans: consecutive days collapse, sparse days list, a year boundary appends the year', () => {
  const tjson = { name: 'T', timezone: 'UTC', venues: [], players: [], categories: [{ id: 't', name: 'T1' }], matches: { t: [
    { id: 1, scheduled: '2026-12-30T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 2, scheduled: '2027-01-02T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] } };
  const data = { index: [], t: { slug: 't', name: tjson.name }, tjson, cats: toCats(tjson) };
  const page = renderTournament({ slug: 't', view: 'tournament' }, data);
  assert(page.includes('<p class="note">Wed, Dec 30, Sat, Jan 2, 2027</p>'), 'sparse days list each label; a year boundary appends the end year; no location renders clean');
  // closing the gap makes the run consecutive — cross-month collapsed form
  tjson.matches.t.splice(1, 0,
    { id: 3, scheduled: '2026-12-31T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 4, scheduled: '2027-01-01T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] });
  data.cats = toCats(tjson); // contexts snapshot the matches — rebuild after mutating
  const run = renderTournament({ slug: 't', view: 'tournament' }, data);
  assert(run.includes('<p class="note">Wed–Sat, Dec 30 – Jan 2, 2027</p>'), 'consecutive cross-month days keep both months and the end year');
});

test('routing: cat and player ride along between tournament and schedule — applied on their home view only', () => {
  const repo = loadRepo(FIX('sample'));
  const info = repo.tournaments.get('sample');
  const data = { index: repo.index, t: { slug: 'sample', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const t = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  assert(t.includes('<a href="#sample/schedule?cat=md40">My Schedule</a>'), 'tournament page carries cat onto the schedule link');
  assert(t.includes('<a href="#sample?cat=xd">Mixed Doubles</a>'), 'the switcher selects another category, no extra params');
  const s = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1', cat: 'md40' }, data);
  assert(s.includes('<a href="#sample?cat=md40&amp;player=p1"'), 'schedule page carries cat and player back onto the tournament link');
  assert(s.includes('href="#sample/schedule?cat=md40">Not you?</a>'), 'Not you? keeps the cat, drops only the player');
  const back = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40', player: 'p1' }, data);
  assert(back.includes('<a href="#sample/schedule?cat=md40&amp;player=p1">My Schedule</a>'), 'tournament page carries the pick onto My Schedule');
  assert(back.includes('<a href="#sample?cat=xd&amp;player=p1"'), 'category switch keeps the riding player');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule', cat: 'md40' }, data);
  assert(picker.includes('#sample/schedule?cat=md40&amp;player='), 'picker picks carry the cat and the pick');
});
