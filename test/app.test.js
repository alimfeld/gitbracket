'use strict';

// Domain semantics (site/derive.js): ladder order, slot resolution, result
// statuses, ties — the gate's shared model. Renderer smoke (site/app.js):
// shipped state only — status/data-jump hooks, escapes, a11y, routing; never
// the words, columns, or layout that carry it (per AGENTS.md).
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, poolRanks, resolveSide, playerMatches, matchSlotMs, slotLabel, placementLabel, koColumn, koOrdinal, matchLabel, schedTime, toCats, isDeadTie, winners, catStatus, roundName } = require('../site/derive.js');
const { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer } = require('../site/app.js');
const { FIX, catOf, text, vals, card, cards, links } = require('./helpers.js');
const { loadRepo } = require('../src/tools.js');

const sameRecord = (a, b) => a.wins === b.wins && a.gd === b.gd && a.pd === b.pd; // test-only — derive.js doesn't ship it

test('schedTime: an invalid timezone reads as unparseable — never throws', () => {
  assert.equal(schedTime({ scheduled: '2026-05-02T09:00:00' }, 'Mars/Olympus'), null, 'a bad tz is a parse failure, not a crash');
  assert(schedTime({ scheduled: '2026-05-02T09:00:00' }, 'UTC') > 0, 'a good tz still anchors the wall time');
});

test('renderers: a tournament with no categories renders empty — never throws', () => {
  const tjson = { name: 'Empty', location: 'Hall', timezone: 'UTC', venues: [], players: [], categories: [], matches: {} };
  const data = { index: [], t: { slug: 'empty', name: 'Empty' }, tjson, cats: toCats(tjson) };
  const html = renderTournament({ slug: 'empty', view: 'tournament' }, data);
  assert(typeof html === 'string' && html.includes('<h1>') && text(html).includes('Empty'), 'semantic title: the tournament shell still renders');
  assert(!html.includes('<h2'), 'semantic: no category heading when none exist'); // heading levels are the a11y outline, not presentation
  assert.doesNotThrow(() => renderVenue({ slug: 'empty', view: 'venues' }, data, Date.now()), 'venue view too');
  assert.doesNotThrow(() => renderPlayer({ slug: 'empty', view: 'schedule' }, data), 'player picker too');
});

test('renderers: an invalid timezone renders TBD, never throws', () => {
  const bad = { name: 'Bad', location: 'Hall', timezone: 'Mars/Olympus', venues: [{ id: 'c1', name: 'Court 1' }], players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], categories: [{ id: 't', name: 'T', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 30, knockout: 30 } }], matches: { t: [{ id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }] } };
  const data = { index: [], t: { slug: 'bad', name: 'Bad' }, tjson: bad, cats: toCats(bad) };
  assert.doesNotThrow(() => renderTournament({ slug: 'bad', view: 'tournament' }, data), 'tournament page');
  assert.doesNotThrow(() => renderVenue({ slug: 'bad', view: 'venues' }, data, Date.now()), 'venue board');
  assert.doesNotThrow(() => renderPlayer({ slug: 'bad', view: 'schedule', player: 'p1' }, data), 'player page');
});

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
    assert.equal(missing.httpError, true, 'a 404 reports httpError — a dead deep link, stop polling, not a retryable null');
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

test('catStatus: starts, groups progress, the KO wave in play, and the podium at full finish', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const mk = ms => makeCat({ meta: tjson.categories[0], matches: ms }, tjson);
  const base = catOf('sample', 'md40').matches;
  const pre = mk(base.map(m => ({ ...m, games: [], result: undefined })));
  assert(catStatus(pre).kind === 'starts' && catStatus(pre).time === Date.parse('2025-07-14T09:00:00-04:00'), 'nothing played: starts at the earliest scheduled time, in a semantic time element');
  const mid = mk(base.map(m => m.id === 1 ? { ...m, result: undefined } : m));
  const g = catStatus(mid);
  assert(g.kind === 'groups' && g.played === 5 && g.count === 6, 'groups live: the progress count, no next-slot noise');
  const live = catOf('sample', 'md40');
  const k = catStatus(live);
  assert(k.kind === 'ko' && k.col === 1 && roundName(k.col) === 'Semifinals', 'the Semifinals are in play — a scheduled final/bronze stays silent while its semifinals still decide them');
  const full = catOf('full', 't');
  const w = catStatus(full);
  assert(w.kind === 'winners' && w.first.join() === 'p1' && w.second.join() === 'p5' && w.third.join() === 'p6', 'full finish: the podium off the played final and bronze');
  const xd = catOf('sample', 'xd');
  assert(catStatus(xd).kind === 'finished', 'pool-only finish: no final to name, plain Finished');
});

// podium details: third exists only when a bronze match decided it; a void
// anywhere leaves no winner to name — the line falls back to Finished
const place8Ctx = tjson => makeCat({ meta: tjson.categories[0], matches: tjson.matches.t }, tjson);

test('winners: first/second off the final, third/fourth off the bronze; voids kill the line', () => {
  const p8 = catOf('place8', 't');
  const w = winners(p8);
  assert(w.first.join() === 'p1' && w.second.join() === 'p2' && w.third.join() === 'p5' && w.fourth.join() === 'p6', 'a full eight-bracket: champion, runner-up, third and fourth from the played matches');
  const tjson = JSON.parse(JSON.stringify(require(FIX('place8', 'tournaments', 'place8.json'))));
  tjson.matches.t.find(m => m.id === 19).result = { status: 'void' };
  const voidFinal = place8Ctx(tjson);
  assert(winners(voidFinal) === null && catStatus(voidFinal).kind === 'finished', 'a void final decides nothing — no podium, plain Finished');
  const bjson = JSON.parse(JSON.stringify(require(FIX('place8', 'tournaments', 'place8.json'))));
  bjson.matches.t.find(m => m.id === 20).result = { status: 'void' };
  const bw = winners(place8Ctx(bjson));
  assert(bw.first.join() === 'p1' && bw.second.join() === 'p2' && bw.third === null, 'a void bronze drops the third-place prize, keeps the podium');
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

test('result statuses render: W/O and void on cards, settled matches stay on the board', () => {
  const repo = loadRepo(FIX('result'));
  const info = repo.tournaments.get('result');
  const data = { index: repo.index, t: repo.index[0], tjson: info.tjson, cats: toCats(info.tjson) };
  const st = renderTournament({ slug: 'result', view: 'tournament' }, data);
  assert(text(st).includes('void') && text(st).includes('W/O'), 'void and walkover statuses render on their cards');
  const venue = renderVenue({ slug: 'result', view: 'venues' }, data, Date.parse('2026-05-02T09:30:00Z'));
  assert(text(venue).includes('P1') && text(venue).includes('P3'), 'the board carries every court-1 slot');
  assert(vals(venue, 'data-status').includes('done') && text(venue).includes('void') && text(venue).includes('W/O'), 'settled matches — played, walkover, void — all stay on the full-day board');
  assert(vals(venue, 'data-status').includes('upcoming'), 'the open 11:00 final is still upcoming at 09:30');
  assert(vals(venue, 'data-current').length >= 1, 'the board marks its anchor row for the follow');
});

test('bracket walkers tolerate a sideless match: report, never throw', () => {
  const ko = makeCat({ meta: {}, matches: [
    { id: 'sf1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'sf2', sides: [{ kind: 'players', ids: ['c'] }, { kind: 'players', ids: ['d'] }] },
    { id: 'f', sides: [{ kind: 'match', match: 'sf1', result: 'winner' }, { kind: 'match', match: 'sf2', result: 'winner' }] },
    { id: 'b', sides: [{ kind: 'match', match: 'sf1', result: 'loser' }, { kind: 'match', match: 'sf2', result: 'loser' }] },
    { id: 'x' },
  ] }, { timezone: 'UTC', players: [] });
  assert(typeof koColumn(ko.byId.get('f'), ko) === 'number' && typeof koColumn(ko.byId.get('b'), ko) === 'number', 'columns still compute around the broken match');
  assert(typeof koOrdinal(ko.byId.get('f'), ko) === 'number' && typeof koOrdinal(ko.byId.get('sf1'), ko) === 'number', 'ordinals still compute');
  assert(placementLabel(ko.byId.get('b'), ko) === '3rd place', 'placement still labels the bronze');
  assert(typeof matchLabel(ko.byId.get('x'), ko) === 'string', 'the malformed match renders a label, never throws');
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
  assert(text(html).includes('Winner of SF2') && !html.includes('<a href="#m-'), 'slot labels are plain text, not anchors');
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

test('placementLabel: 3rd/5th/7th place and classification semis', () => {
  const pl = catOf('place', 'pl');
  const L = id => placementLabel(pl.byId.get(id), pl);
  assert(L(7) === null && L(5) === null && L(1) === null, 'final/semis/quarters are not placement matches');
  assert(L(8) === '3rd place', 'losers of semis -> 3rd place');
  assert(L(9) === '5th–8th semi', 'losers of quarters -> classification semi');
  assert(L(11) === '5th place', 'winners of classification semis -> 5th place');
  assert(L(12) === '7th place', 'losers of classification semis -> 7th place');
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

test('the next card is one card: a second category sharing the match id must not double-flag', () => {
  // Match ids are per-category — Ada's first undone xd match is given the md40
  // final's id (9); the old id-only comparison flagged both cards as next.
  const tjson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const xd = tjson.matches.xd.find(m => m.sides[0].ids.includes('p1'));
  xd.id = 9;
  delete xd.result;
  delete xd.games;
  const data = { index: [], t: { slug: 'sample', name: tjson.name }, tjson, cats: toCats(tjson) };
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  assert.equal(cards(ppage, 'id', 'next').length, 1, 'exactly one next card despite a shared id');
  // the header line carries its own next flag — one more flagged element is the card
  assert.equal(vals(ppage, 'data-status').filter(s => s === 'next').length, 2, 'exactly one next card flag (the header line carries its own data-status)');
});

test('renderers: escapes, a11y state, and behavioral hooks — the shipped surface, not its copy', () => {
  const dataOf = name => {
    const repo = loadRepo(FIX(name));
    const info = repo.tournaments.get(name);
    return { index: repo.index, t: repo.index[0], tjson: info.tjson, cats: toCats(info.tjson) };
  };
  const data = dataOf('sample');
  const clone = () => JSON.parse(JSON.stringify(data.tjson));
  const standings = renderTournament({ slug: 'sample', view: 'tournament' }, data);
  const evil = clone();
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  const evilPool = clone();
  evilPool.matches.md40[0].pool = 'A" onclick="alert(1)';
  const ph = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, { ...data, tjson: evilPool, cats: toCats(evilPool) });
  assert(!ph.includes('Pool A" onclick='), 'the injected handler never lands in the DOM');
  assert(ph.includes('A&quot; onclick=&quot;alert(1)'), 'the pool string renders entity-encoded');
  const evilVenue = clone();
  evilVenue.venues.find(v => v.id === 'court-2').name = '<b>Court 2</b>';
  const evh = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, { ...data, tjson: evilVenue, cats: toCats(evilVenue) });
  assert(!evh.includes('<b>Court 2</b>') && evh.includes('&lt;b&gt;Court 2&lt;/b&gt;'), 'the venue name renders entity-encoded');
  assert(standings.includes('aria-hidden="true"'), 'unplayed best-of slots are placeholders, hidden from screen readers');
  assert((standings.match(/<h2\b/g) || []).length === 1, 'one category heading per page');
  const xd = renderTournament({ slug: 'sample', view: 'tournament', cat: 'xd' }, data);
  assert((xd.match(/<h2\b/g) || []).length === 1, '?cat= selects one category heading');
  assert(text(standings).includes('Winner of SF2') && !standings.includes('<a href="#m-'), 'slot labels are plain text, not anchors');
  assert(!standings.includes('data-feeders') && !standings.includes('data-stage') && !standings.includes('toggle'), 'no trace or disclosure machinery ships');
  for (const j of vals(standings, 'data-jump')) assert(card(standings, 'id', j) !== undefined, `every jump link has its target section (${j})`);
  assert.equal(vals(standings, 'data-status').filter(s => s === 'next').length, 1, 'ko in play: only the one unscored semifinal card carries the accent');
  assert(card(standings, 'data-status', 'next').includes('SF2'), 'the highlighted card is the unresolved semifinal');
  const midJson = clone();
  midJson.matches.md40[0].result = undefined;
  const mid = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, { ...data, tjson: midJson, cats: toCats(midJson) });
  assert(vals(mid, 'data-jump').includes('group-matches'), 'running groups: the Next line links the group matches');
  assert.equal(vals(mid, 'data-status').filter(s => s === 'next').length, 1, 'groups in play: only the one unscored group match carries the accent');
  const preJson = clone();
  for (const ms of Object.values(preJson.matches)) for (const m of ms) { delete m.result; delete m.games; }
  const pre = renderTournament({ slug: 'sample', view: 'tournament' }, { ...data, tjson: preJson, cats: toCats(preJson) });
  assert(text(pre).includes('Ada Lovelace / Grace Hopper') && !text(pre).includes('1 Ada Lovelace'), 'roster renders before any result, no phantom rank 1s');
  const sLink = links(pre).find(l => l.text.startsWith('Starts'));
  assert(sLink && sLink.jump === 'group-matches' && sLink.href === '#sample', 'the Starts line is a link to the opening block, like the Next line');
  assert(vals(pre, 'data-status').includes('next'), 'pre-start: the opening block is lit — playable before the first result');
  const seg = links(standings).filter(l => l.text === 'Tournament' || l.text === 'Schedule');
  assert(seg.length === 2 && seg[0].href === '#sample' && seg[0].current && seg[1].href === '#sample/schedule' && !seg[1].current, 'tournament page: segment switch, Tournament current');
  const mdLink = links(standings).find(l => l.text === "Men's Doubles 40+");
  const xdLink = links(standings).find(l => l.text === 'Mixed Doubles');
  assert(mdLink.href === '#sample' && mdLink.current && xdLink.href === '#sample?cat=xd' && !xdLink.current, 'the category switcher: first segment canonical at the bare slug, the rest carry ?cat=');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  const pseg = links(ppage).filter(l => l.text === 'Tournament' || l.text === 'Schedule');
  assert(pseg[0].href === '#sample?player=p1' && !pseg[0].current && pseg[1].href === '#sample/schedule?player=p1' && pseg[1].current, 'player page: Schedule current, pick preserved in links');
  const nextLink = links(ppage).find(l => l.text.startsWith('Next'));
  assert(nextLink && nextLink.jump === 'next' && nextLink.href === '#sample/schedule?player=p1', 'the whole next line is the link to the next card');
  assert(text(ppage).includes('Ada Lovelace') && text(ppage).includes('Court 1'), 'player card finds the player, names the court');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule' }, data);
  const secs = picker.split('<section>').slice(1);
  for (const sec of secs) {
    const names = links(sec).filter(l => /\/schedule\?player=/.test(l.href)).map(l => l.text);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'each category section lists players alphabetically');
  }
  const sparse = clone();
  sparse.players.push({ id: 'bench', name: 'Ben Ched' });
  const spr = renderPlayer({ slug: 'sample', view: 'schedule' }, { ...data, tjson: sparse });
  assert(text(spr).includes('Ada Lovelace') && !text(spr).includes('Ben Ched'), 'picker lists only participating players');
  const idx = renderIndex({ view: 'index' }, { index: [
    { slug: 'soon', name: 'Later' },
    { slug: 'wide', name: 'Wide', dates: ['2026-07-11', '2026-07-12'] },
    { slug: 'sample', name: 'Sample', location: 'New York', dates: ['2025-07-14'] },
  ] });
  assert(text(idx).indexOf('Wide') < text(idx).indexOf('Sample') && text(idx).indexOf('Sample') < text(idx).indexOf('Later'), 'sorted by start date descending, undated last');
  assert(!idx.includes('undefined') && !idx.includes('null'), 'no date renders clean, no null payload');
  assert(links(idx).filter(l => l.href === '#sample/venues').length === 1, 'venue board appears once per tournament');
  const tdata = dataOf('tie');
  const tieHtml = renderTournament({ slug: 'tie', view: 'tournament' }, tdata);
  assert(!text(tieHtml).includes('†') && text(tieHtml).includes('1 A') && text(tieHtml).includes('1 B'), 'tied teams share rank 1, no dagger');
});

test('possible stages render as cards: a status flag per stage, and the next header goes conditional', () => {
  const repo = loadRepo(FIX('byes'));
  const info = repo.tournaments.get('byes');
  const data = { index: repo.index, t: { slug: 'byes', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const page = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p4' }, data);
  assert.equal(vals(page, 'data-status').filter(s => s === 'possible').length, 3, 'p4 (pool open): three possible stages — QF, SF, and the merged final/bronze');
  // next points at the earliest possible stage when no confirmed match is left
  const tjson = JSON.parse(JSON.stringify(info.tjson));
  for (const id of [1, 4, 7, 10, 13]) tjson.matches.t.find(m => m.id === id).result = { status: 'walkover', winner: 'a' };
  const page2 = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p1' }, { ...data, tjson, cats: toCats(tjson) });
  assert(text(page2).includes('Next'), 'the next header line names the earliest possible stage');
  assert(vals(page2, 'datetime').includes('2026-07-12T10:30:00.000Z'), 'the next line carries the instant in a semantic time element');
  assert(card(page2, 'id', 'next').includes('Quarterfinals'), 'the earliest possible card is the jump target, never carrying the confirmed accent');
  assert.equal(vals(page2, 'data-status').filter(s => s === 'next').length, 1, 'only the header line carries the green accent — possible cards never do');
});

test('multi-day kiosk: one day at a time, previewing day one early, falling back to the last day', () => {
  const repo = loadRepo(FIX('multiday'));
  const info = repo.tournaments.get('multiday');
  const data = { index: repo.index, t: { slug: 'multiday', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const page = renderTournament({ slug: 'multiday', view: 'tournament' }, data);
  assert(vals(page, 'data-jump').includes('group-matches'), 'the Next line links the running group stage');
  // moving a match to another day just re-dates its card — no divider machinery
  const split = JSON.parse(JSON.stringify(info.tjson));
  split.matches.md40[5].scheduled = '2026-07-12T15:00:00'; // m6 (pool) -> Sunday
  const spage = renderTournament({ slug: 'multiday', view: 'tournament' },
    { index: repo.index, t: data.t, tjson: split, cats: toCats(split) });
  assert(vals(spage, 'datetime').includes('2026-07-12T19:00:00.000Z'), 'a rescheduled pool match carries its new day on the card');
  // kiosk: strict same-day in the tournament timezone, from the device clock instant
  const at = iso => Date.parse(iso);
  const sat = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-11T12:00:00-04:00'));
  assert(text(sat).includes('Katherine Johnson') && !text(sat).includes('SF') && !text(sat).includes('Final'), 'saturday board: open pool match, no tomorrow');
  const sun = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-12T08:00:00-04:00'));
  assert(text(sun).includes('SF') && text(sun).includes('Final') && !text(sun).includes('Katherine Johnson'), 'sunday board: knockout only, yesterday gone');
  const mon = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-13T12:00:00-04:00'));
  assert(text(mon).includes('SF') && text(mon).includes('Final') && !text(mon).includes('Katherine Johnson'), 'after the last day: the board falls back to the last day (Sunday knockout), not a stale today');
  const fri = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-10T12:00:00-04:00'));
  assert(text(fri).includes('Katherine Johnson') && !text(fri).includes('SF') && !text(fri).includes('Final'), 'a day before day one: the board previews the first day, pools only');
});

test('routing: cat and player ride along between tournament and schedule — applied on their home view only', () => {
  const repo = loadRepo(FIX('sample'));
  const info = repo.tournaments.get('sample');
  const data = { index: repo.index, t: { slug: 'sample', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const t = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  const lk = (html, label) => links(html).find(x => x.text === label);
  assert(lk(t, 'Schedule').href === '#sample/schedule?cat=md40', 'tournament page carries cat onto the schedule link');
  assert(lk(t, 'Mixed Doubles').href === '#sample?cat=xd', 'the switcher selects another category, no extra params');
  const s = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1', cat: 'md40' }, data);
  assert(lk(s, 'Tournament').href === '#sample?cat=md40&player=p1', 'schedule page carries cat and player back onto the tournament link');
  assert(lk(s, 'Change').href === '#sample/schedule?cat=md40', 'Change keeps the cat, drops only the player');
  const back = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40', player: 'p1' }, data);
  assert(lk(back, 'Schedule').href === '#sample/schedule?cat=md40&player=p1', 'tournament page carries the pick onto Schedule');
  assert(lk(back, 'Mixed Doubles').href === '#sample?cat=xd&player=p1', 'category switch keeps the riding player');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule', cat: 'md40' }, data);
  assert(links(picker).some(x => x.href.startsWith('#sample/schedule?cat=md40&player=')), 'picker picks carry the cat and the pick');
});

test('knockout wave link names the merged band: the main wave, and the placement wave once the championship is spent', () => {
  const base = () => JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const render = tjson => {
    const data = { index: [{ slug: 'sample', name: tjson.name, location: tjson.location }], t: { slug: 'sample', name: tjson.name }, tjson, cats: toCats(tjson) };
    return renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  };
  // as-is: semis (m8) and final (m9) open, bronze (m10) open — wave is the Semifinals, not the bronze
  const a = render(base());
  assert(vals(a, 'data-jump').includes('ko-1') && !vals(a, 'data-jump').includes('ko-0'), 'jump lands on Semifinals, never on Final for a placement match');
  // championship finished, only the bronze left open: the wave is the placement band — Final / 3rd place
  const done = base();
  for (const id of [7, 8, 9]) {
    const m = done.matches.md40.find(x => x.id === id);
    m.result = { status: 'played', winner: 'a' }; delete m.games;
  }
  const doneHtml = render(done);
  assert(vals(doneHtml, 'data-jump').includes('ko-0'), 'placement-pending links to the merged band, not a round or a Placement section');
  // and the open placement card carries the next accent, so the link has its highlight partner
  assert.equal(vals(doneHtml, 'data-status').filter(s => s === 'next').length, 1, 'only the open bronze is flagged');
  assert(card(doneHtml, 'data-status', 'next').includes('3rd place'), 'the accent lands on the open placement card in the band');
});

test('ko wave accent also flags playable placement matches — the bronze lights up with the final', () => {
  const base = () => JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const render = tjson => {
    const data = { index: [{ slug: 'sample', name: tjson.name, location: tjson.location }], t: { slug: 'sample', name: tjson.name }, tjson, cats: toCats(tjson) };
    return renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  };
  // both semis decided, final + bronze open: the Final wave flags both — they are both playable
  const tjson = base();
  for (const id of [7, 8]) { const m = tjson.matches.md40.find(x => x.id === id); m.result = { status: 'played', winner: 'a' }; delete m.games; }
  const html = render(tjson);
  assert(vals(html, 'data-jump').includes('ko-0'), 'the wave is the Final');
  assert.equal(vals(html, 'data-status').filter(s => s === 'next').length, 2, 'the final and the playable bronze both carry the accent');
  const oh = render(base());
  assert.equal(vals(oh, 'data-status').filter(s => s === 'next').length, 1, 'a placement match whose feeder is undecided is not flagged');
});
