'use strict';

// Derive engine (site/app.js): standings, slot resolution, scheduling, labels.
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, resolveSide, sameRecord, matchRound, playerMatches, reachableKo, possibleSpan, matchSlotMs, slotLabel, roundName, placementLabel, koColumn, kioskStatus, matchLabel, parseRoute, loadAll } = require('../site/app.js');
const { FIX, catOf } = require('./helpers.js');

test('parseRoute: fragment routing — bare slug defaults to categories, every segment id-gated', () => {
  assert.deepEqual(parseRoute(''), { view: 'index' }, 'no fragment: tournament list');
  assert.deepEqual(parseRoute('#'), { view: 'index' });
  assert.deepEqual(parseRoute('#2026-mammut60'), { slug: '2026-mammut60', view: 'categories' }, 'bare slug: standings, all categories');
  assert.deepEqual(parseRoute('#2026-mammut60/categories'), { slug: '2026-mammut60', view: 'categories' });
  assert.deepEqual(parseRoute('#2026-mammut60/categories/md'), { slug: '2026-mammut60', view: 'categories', filter: 'md' });
  assert.deepEqual(parseRoute('#2026-mammut60/venues'), { slug: '2026-mammut60', view: 'venues' });
  assert.deepEqual(parseRoute('#2026-mammut60/venues/court-1'), { slug: '2026-mammut60', view: 'venues', filter: 'court-1' });
  assert.deepEqual(parseRoute('#2026-mammut60/players/p1'), { slug: '2026-mammut60', view: 'players', filter: 'p1' });
  assert.equal(parseRoute('#2026-mammut60/bogus'), null, 'unknown view');
  assert.equal(parseRoute('#2026-mammut60/venues/'), null, 'empty segment');
  assert.equal(parseRoute('#2026-mammut60/categories/md/x'), null, 'too many segments');
  assert.equal(parseRoute('#../..'), null, 'traversal rejected');
  assert.equal(parseRoute('#/'), null, 'no slug');
});

test('loadAll: a slug route fetches only the tournament file; the index view only the index', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = url => { // fetchJson passes { cache: 'no-cache' }; the stub ignores it
    calls.push(url);
    const body = {
      'tournaments.json': [{ slug: 'sample', name: 'Sample' }],
      'tournaments/sample.json': require(FIX('sample', 'tournaments', 'sample.json')),
    }[url] ?? null;
    return body === null ? Promise.resolve({ ok: false }) : Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  try {
    const slug = await loadAll({ slug: 'sample', view: 'categories' }, false);
    assert.deepEqual(calls, ['tournaments/sample.json'], 'slug route: one fetch, no index roundtrip');
    assert.equal(slug.t.name, 'Sample', 'name comes from the tournament file');
    assert.equal(slug.t.slug, 'sample', 'slug comes from the route');
    assert(slug.tjson && slug.cats.length > 0, 'tournament data and categories load');
    const list = await loadAll({ view: 'index' }, true);
    assert.deepEqual(calls, ['tournaments/sample.json', 'tournaments.json'], 'index view: fetches only the index');
    assert.equal(list.index[0].slug, 'sample');
    assert.equal(list.tjson, null, 'index view carries no tournament data');
    const missing = await loadAll({ slug: 'nope', view: 'categories' }, false);
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

test('standings tiebreak: wins, then game differential, then point differential', () => {
  const ctx = catOf('tiebreak', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 (gd +2) ranks above p2 (gd +1) despite the lower point differential');
  assert(st[0].wins === 2 && st[0].gd === 2 && st[0].pd === 3, 'p1 record');
  assert(st[1].wins === 2 && st[1].gd === 1 && st[1].pd === 5, 'p2 record');
});

test('xd pool order', () => {
  const st = poolStandings(catOf('sample', 'xd'), 'A');
  assert(st && st[0].sig === 'p1|p3' && st[0].wins === 3, 'xd pool order');
});

test('forfeit and partial-match detection', () => {
  const md = catOf('sample', 'md40');
  assert(winnerIdx(md.byId.get('m7'), md) === 0, 'forfeit 1 -> side 0 wins');
  assert(winnerIdx(md.byId.get('m8'), md) === null, 'partial match is not done');
  assert(isDone(md.byId.get('m7'), md) && isDone(md.byId.get('m1'), md), 'done detection');
});

test('slot resolution: forfeit winner vs in-play TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get('m9');
  const w7 = resolveSide(m9.sides[0], md);
  assert(w7 && w7.has('p1') && w7.has('p2'), 'winner of forfeit m7 resolves to p1/p2');
  assert(resolveSide(m9.sides[1], md) === null, 'winner of in-play m8 -> TBD');
});

test('slot resolution: loser path (bronze/placement)', () => {
  const md = catOf('sample', 'md40');
  const m10 = md.byId.get('m10');
  const l7 = resolveSide(m10.sides[0], md);
  assert(l7 && l7.has('p7') && l7.has('p8'), 'loser of forfeit m7 resolves to p7/p8');
  assert(resolveSide(m10.sides[1], md) === null, 'loser of in-play m8 -> TBD');
});

test('matchSlotMs: match override > per-stage category config > default', () => {
  assert(matchSlotMs({}, { slotMinutes: { groups: 60 } }) === 45 * 60000, 'groups config does not leak into knockout');
  assert(matchSlotMs({ pool: 'A' }, { slotMinutes: { groups: 60 } }) === 60 * 60000, 'pool match takes the groups slot');
  assert(matchSlotMs({}, { slotMinutes: { knockout: 60 } }) === 60 * 60000, 'knockout match takes the knockout slot');
  assert(matchSlotMs({ slotMinutes: 90 }, { slotMinutes: { knockout: 60 } }) === 90 * 60000, 'match override wins');
  assert(matchSlotMs({}, {}) === 45 * 60000, 'default is 45 minutes');
});

test('kioskStatus: overdue / now / upcoming badge per open card', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
    { id: 'm2', scheduled: '2025-07-14T08:30:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm3', scheduled: '2025-07-14T09:45:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm4', scheduled: '2025-07-14T10:30:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm5', scheduled: '2025-07-14T11:15:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm6', scheduled: '2025-07-14T10:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T10:00:00Z'); // m2's slot ended 09:15 — long overdue
  const rows = ctx.matches.map(m => ({ m, t: Date.parse(m.scheduled), ctx }));
  const st = id => kioskStatus(rows.find(r => r.m.id === id), now);
  assert(st('m2') === 'overdue', 'slot fully elapsed without a result: overdue');
  assert(st('m3') === 'live' && st('m6') === 'live', 'started and still inside its slot: Now');
  assert(isDone(ctx.byId.get('m1'), ctx), 'a done match leaves the board — no badge');
  assert(st('m4') === 'next' && st('m5') === 'next', 'future starts: upcoming');
  assert(st('m6') === 'live', 'the boundary instant (now === t) belongs to Now, not Next');
});

test('matchLabel: pool, placement, and round names on one card label', () => {
  const full = catOf('full', 't');
  assert(matchLabel(full.byId.get('m1'), full) === 'Pool A', 'pool match labels its pool');
  assert(matchLabel(full.byId.get('m7'), full) === 'SF', 'semifinal');
  assert(matchLabel(full.byId.get('m10'), full) === 'Final', 'final');
  assert(matchLabel(full.byId.get('m9'), full) === '3rd place', 'bronze via placementLabel');
  const md = catOf('sample', 'md40');
  assert(matchLabel(md.byId.get('m9'), md) === 'Final' && matchLabel(md.byId.get('m10'), md) === '3rd place', 'sample: m9 final, m10 bronze');
});

test('reachableKo: undecided feeder keeps both branches; decided feeder gates the closed one', () => {
  const md = catOf('sample', 'md40');
  const ids = pid => [...reachableKo(md, pid)].sort().join(',');
  assert(ids('p5') === 'm10,m9', 'p5: final and bronze both open while m8 is undecided');
  assert(ids('p1') === '' && ids('p7') === '', 'p1/p7: decided feeders close the losing/winning branch');
});

test('possibleSpan: open knockout span, and pre-knockout fallback to the bracket block', () => {
  const md = catOf('sample', 'md40');
  const s = possibleSpan(md, 'p5');
  assert(s && s.count === 1 && s.min === Date.parse('2025-07-14T12:15:00-04:00') && s.max === s.min, 'p5: final or bronze at 12:15 — one more match, not both');
  assert(possibleSpan(md, 'p1') === null && possibleSpan(md, 'p7') === null, 'confirmed knockout seat (final/bronze) leaves no open span');
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const pre = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => ({ ...m, games: [], forfeit: undefined })) }, tjson);
  const s0 = possibleSpan(pre, 'p1');
  assert(s0 && s0.count === 2 && s0.min === Date.parse('2025-07-14T11:15:00-04:00') && s0.max === Date.parse('2025-07-14T12:15:00-04:00'), 'pre-event: up to 2 matches along one bracket path (m7 -> final/bronze, 11:15 to 12:15)');
});

test('playerMatches: only matches the player is actually in, not potential slots', () => {
  const md = catOf('sample', 'md40');
  const ids = pid => playerMatches(md, pid).map(r => r.m.id).sort();
  assert(ids('p1').join() === 'm1,m3,m5,m7,m9', 'p1: pool + semifinal + final, not bronze m10 (won m7)');
  assert(ids('p7').join() === 'm10,m2,m4,m5,m7', 'p7: pool + m7 + bronze m10, not final m9 (lost m7)');
  assert(ids('p5').join() === 'm2,m3,m6,m8', 'p5: pool + m8; m9/m10 stay off until m8 is decided');
});

test('full bracket: every slot resolves end to end (winner and loser paths)', () => {
  const full = catOf('full', 't');
  const f = full.byId.get('m10'), b = full.byId.get('m9');
  const w0 = resolveSide(f.sides[0], full), w1 = resolveSide(f.sides[1], full);
  assert(w0 && w0.has('p1') && w1 && w1.has('p5'), 'final resolves to p1 vs p5');
  assert(winnerIdx(f, full) === 0, 'final winner is p1');
  const l0 = resolveSide(b.sides[0], full), l1 = resolveSide(b.sides[1], full);
  assert(l0 && l0.has('p6') && l1 && l1.has('p2'), 'bronze resolves to p6 vs p2');
});

test('forfeit inside a pool: counts a win, no gd/pd', () => {
  const full = catOf('full', 't');
  const st = poolStandings(full, 'A');
  const p1 = st.find(r => r.sig === 'p1');
  assert(p1 && p1.wins === 2 && p1.gd === 2 && p1.pd === 11, 'p1: forfeit win + 2-0 win; gd/pd only from the played match');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2' && st[2].sig === 'p3', 'pool A order');
});

test('bracket depth', () => {
  const md = catOf('sample', 'md40');
  assert(matchRound(md.byId.get('m7'), md) === 0 && matchRound(md.byId.get('m9'), md) === 1 && matchRound(md.byId.get('m10'), md) === 1, 'bracket depth');
});

test('koColumn: a bye\'d semi sits in the semifinal column, not with round 1', () => {
  // XD 2026 shape: 5 teams from uneven pools — sf2 is pool-vs-pool (a bye
  // into the semis) while sf1 plays a round-1 survivor. Depth says sf2 is
  // round 1; koColumn must say semifinal.
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
  assert(koColumn(full.byId.get('m10'), full) === 0 && koColumn(full.byId.get('m7'), full) === 1 && koColumn(full.byId.get('m9'), full) === 0,
    'balanced bracket unchanged: final 0, semis 1, bronze with the final');
});

test('dead tie: standings tie + pool slot TBD', () => {
  const tie = catOf('tie', 't');
  const st = poolStandings(tie, 'A');
  assert(st && st.length === 2 && sameRecord(st[0], st[1]), 'tie detected in standings');
  assert(resolveSide(tie.byId.get('m3').sides[0], tie) === null, 'dead-tied pool slot -> TBD');
});

test('3-way dead tie: standings tie + pool slot TBD', () => {
  const tie3 = catOf('tie3', 't');
  const st = poolStandings(tie3, 'A');
  assert(st && st.length === 3 && sameRecord(st[0], st[1]) && sameRecord(st[1], st[2]), '3-way tie detected');
  assert(resolveSide(tie3.byId.get('m4').sides[0], tie3) === null, '3-way dead-tied pool slot -> TBD');
});

test('slotLabel: unresolved slots describe the slot, not bare TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get('m9');
  assert(slotLabel(m9.sides[0], md) === 'Winner of m7', 'winner slot labels the feeder match');
  assert(slotLabel(m9.sides[1], md) === 'Winner of m8', 'unresolved match slot still labels the feeder');
  assert(slotLabel(md.byId.get('m10').sides[0], md) === 'Loser of m7', 'loser slot labels the feeder');
  const st = md.byId.get('m7').sides[0];
  assert(slotLabel(st, md) === '1st in Pool A', 'pool slot labels rank');
  assert(slotLabel(md.byId.get('m8').sides[1], md) === '3rd in Pool A', 'rank 3 ordinal');
});

test('poolStandings partial: unfinished pool still yields a live table', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const md = catOf('sample', 'md40');
  const unfinished = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => m.id === 'm6' ? { ...m, games: [] } : m) }, tjson);
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
  assert(L('m7') === null && L('m5') === null && L('m1') === null, 'final/semis/quarters are not placement matches');
  assert(L('m8') === '3rd place', 'losers of semis -> 3rd place');
  assert(L('m9') === '5th–8th semi', 'losers of quarters -> classification semi');
  assert(L('m11') === '5th place', 'winners of classification semis -> 5th place');
  assert(L('m12') === '7th place', 'losers of classification semis -> 7th place');
});
