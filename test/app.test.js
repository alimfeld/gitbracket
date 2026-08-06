'use strict';

// Derive engine (site/app.js): standings, slot resolution, scheduling, labels.
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, resolveSide, sameRecord, matchRound, playerMatches, matchSlotMs, slotLabel, roundName, placementLabel, koColumn, scheduleStatus, venueBacklog, kioskBuckets, matchLabel } = require('../site/app.js');
const { FIX, catOf } = require('./helpers.js');

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

test('scheduleStatus: gated on start; a slot fully elapsed without a result is overdue', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm2', scheduled: '2025-07-14T10:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
  ] }, { timezone: 'UTC', players: [] });
  const at = ms => scheduleStatus([ctx], ms);
  assert(at(Date.parse('2025-07-14T08:00:00Z')) === null, 'before the first scheduled match: no status');
  assert(at(Date.parse('2025-07-14T09:20:00Z')).overdue.length === 0, 'unfinished but inside its slot: on schedule');
  assert(at(Date.parse('2025-07-14T09:46:00Z')).overdue.length === 1 && at(Date.parse('2025-07-14T09:46:00Z')).overdue[0].m.id === 'm1', 'slot elapsed without a result: behind');
  assert(at(Date.parse('2025-07-14T10:46:00Z')).overdue.length === 1 && at(Date.parse('2025-07-14T10:46:00Z')).overdue[0].m.id === 'm1', 'finished m2 is not overdue; only m1 still is');
});

test('venueBacklog: per-venue delay from the most overdue unfinished match', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', venue: 'c1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm2', scheduled: '2025-07-14T09:10:00Z', venue: 'c1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
    { id: 'm3', scheduled: '2025-07-14T09:30:00Z', venue: 'c2', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T09:50:00Z');
  assert(venueBacklog([ctx], Date.parse('2025-07-14T08:00:00Z')).size === 0, 'before start: no backlog');
  const bg = venueBacklog([ctx], now);
  assert(bg.get('c1') === 5 * 60000, 'c1: 09:00 slot ended 09:45, 5 min overdue (done m2 never counts)');
  assert((bg.get('c2') || 0) === 0, 'c2: 09:30 match still inside its slot, no delay');
});

test('kioskBuckets: status picks the board, the clock never hides an overdue match', () => {
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
  const ids = a => a.map(r => r.m.id);
  const { live, next } = kioskBuckets(rows, now);
  assert(ids(live).includes('m2') && ids(live).includes('m3') && ids(live).includes('m6'), 'started-and-unfinished stays on the board, overdue m2 included');
  assert(!ids(live).includes('m1'), 'a done match leaves the board');
  assert(JSON.stringify(ids(next)) === '["m4","m5"]', 'next = the two future starts');
  assert(!ids(next).includes('m6'), 'the boundary instant (now === t) belongs to Now, not Next');
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
    { id: 'b', sides: [{ kind: 'match', match: 'sf1', result: 'loser' }, { kind: 'match', match: 'sf2', result: 'loser' }] },
  ] }, { timezone: 'UTC', players: [] });
  const col = id => koColumn(ko.byId.get(id), ko);
  assert(col('f') === 0 && col('sf1') === 1 && col('sf2') === 1 && col('r1') === 2 && col('b') === 0,
    'unbalanced bracket: final 0, both semis 1 (incl. bye\'d sf2), round 1 at 2, bronze with the final');
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
  const tjson = require(FIX('sample', 'tournaments', 'sample', 'tournament.json'));
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
