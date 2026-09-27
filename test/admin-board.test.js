'use strict';

// admin.js: the board's read paths — legalSlots, sideOpts, pairBusy. Pure
// computations over a tjson; no git, no daemon.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const admin = require('../src/admin.js');
const { FIX } = require('./helpers.js');

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


test('admin legalSlots: a non-positive gcd step clamps to the default — it can never spin the loop', () => {
  const tjson = loadRepo(FIX('sample')).tournaments.get('sample').tjson;
  // 0 and negatives would never advance the wall-clock scan — the daemon must
  // fall back instead of hanging the board.
  assert(admin.legalSlots(tjson, 'md40', '9', '2025-07-14', 0)['court-1'].length > 0, 'gcd 0 clamps to the default step');
  assert(admin.legalSlots(tjson, 'md40', '9', '2025-07-14', -45)['court-1'].length > 0, 'negative gcd clamps too');
});


test('admin legalSlots: the scan rides the schedule\'s lattice, not midnight — a 25-minute day keeps its 09:00 start and whole-slot moves', () => {
  // The generator anchors at the category block start (09:00), not a multiple
  // of a 25-minute slot, so the lattice is 15 + 25k: a from-zero 25k scan offers
  // only :10/:35 starts — never the match's own, and never a whole slot away.
  const tjson = {
    name: 'T', location: 'L', timezone: 'UTC', dates: ['2026-10-03'],
    venues: [{ id: 'c1', name: 'C1' }],
    categories: [{ id: 'md', name: 'MD', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 25, knockout: 25 } }],
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }, { id: 'p4', name: 'Four' }],
    matches: { md: [
      { id: 1, pool: 'A', scheduled: '2026-10-03T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1', 'p2'] }, { kind: 'players', ids: ['p3', 'p4'] }] },
      { id: 2, pool: 'A', scheduled: '2026-10-03T09:25:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1', 'p3'] }, { kind: 'players', ids: ['p2', 'p4'] }] },
    ] },
  };
  const t = admin.legalSlots(tjson, 'md', '1', '2026-10-03', 25)['c1'];
  assert(t.includes(540), 'the match\'s own 09:00 start is offered — a drag can return where it was');
  assert(t.includes(515) && t.includes(590), 'the one-slot neighbours 08:35/09:50 are reachable');
  assert(t.every(wm => wm % 25 === 15), 'every tick rides the 09:00-anchored lattice, never its 25k ghost');
});


test('admin legalSlots: the board drags on a 5-minute step — every wall mark the gate allows, not just the slot-minute lattice', () => {
  const tjson = loadRepo(FIX('sample')).tournaments.get('sample').tjson;
  const c1 = new Set(admin.legalSlots(tjson, 'md40', '9', '2025-07-14', 5)['court-1']);
  assert([...c1].every(wm => wm % 5 === 0), 'every offer is a 5-minute mark');
  assert(c1.has(720) && c1.has(725), 'the feeder floor 12:00 and the 12:05 nudge past it — the 45-minute lattice never offered 725');
  assert(!c1.has(715), '11:55 before the floor is still refused — a finer step narrows nothing but the step');
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
  assert.deepEqual(admin.sideOpts(tjson, 'md', 5, NaN), a5, 'an out-of-range side clamps to side a — a hostile param frees no nonexistent side');
  // the picker's player pool is the registered roster, not match appearances —
  // a never-matched player stays reachable (the gate accepts any registered id)
  const roster = admin.sideOpts(tjson, 'md', 3, 0).roster;
  assert.deepEqual(roster, ['p1', 'p2', 'p3', 'p4'], 'the full roster is offered, matching no match yet or not');
  // an unknown match reports nothing, never throws — same as legalSlots
  assert.deepEqual(admin.sideOpts(tjson, 'md', 999, 0), {});
});


test('admin legalSlots/sideOpts/doEdit: non-object entity entries report, never throw — a shape-broken hand edit must not kill the daemon', () => {
  // null venue + null player entries: the validator reports them, the site
  // renders them absent; the daemon's read paths must honor the same contract.
  // A throw here is an unhandled rejection out of the async handler.
  const tjson = {
    name: 'T', location: 'L', timezone: 'UTC', dates: ['2026-05-02'],
    venues: [null, { id: 'c1', name: 'C1' }],
    players: [null, { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    categories: [{ id: 't', name: 'T', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 30, knockout: 30 } }],
    matches: { t: [{ id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }] },
  };
  assert.deepEqual(Object.keys(admin.legalSlots(tjson, 't', '1', '2026-05-02', 15)), ['c1'], 'the real court is offered, the null entry skipped');
  assert.doesNotThrow(() => admin.sideOpts(tjson, 't', 1, 0), 'sideOpts survives a null player entry');
  // the committed bad-null-category fixture: the category is simply absent
  const repo = loadRepo(FIX('bad-null-category'));
  const nullCat = repo.tournaments.get('bad-null-category').tjson;
  assert.deepEqual(admin.sideOpts(nullCat, 't', 1, 0), {}, 'a null category reports empty, never throws');
  // doEdit's catCtx runs before the write — the unknown category must report
  const state = { root: '/', siteRoot: FIX('bad-null-category'), repo, slug: 'bad-null-category', redo: [] };
  assert.equal(admin.doEdit(state, 'move', 't', '1', { time: null, venue: null }).ok, false, 'the unknown category is reported');
});


test('admin sideOpts: a resolved pool-rank side double-books its players in the picker', () => {
  const tjson = loadRepo(FIX('bad-resolved-doublebook')).tournaments.get('bad-resolved-doublebook').tjson;
  // category y's match 1 sits at 11:00 with explicit p1/p2; category x's final at the
  // same time resolves its pool-A rank-1 side to that same pair
  const opts = admin.sideOpts(tjson, 'y', 1, 0);
  assert(opts.busy.includes('p1') && opts.busy.includes('p2'), 'the resolved pair is busy, so the picker greys it');
});
