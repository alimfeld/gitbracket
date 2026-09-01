'use strict';

// Derive engine (site/derive.js) + renderers (site/app.js): tournament page,
// slot resolution, scheduling, labels.
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, poolRanks, resolveSide, playerMatches, possibleStages, matchSlotMs, slotLabel, roundName, placementLabel, koColumn, koOrdinal, kioskStatus, currentRowIndex, matchLabel, schedTime, toCats, isDeadTie, winners, catStatus, playerStatus, teamLabel } = require('../site/derive.js');
const { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer } = require('../site/app.js');
const { generate } = require('../src/schedule.js');
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

test('kioskStatus: done / overdue / due / upcoming per card', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 }, slotMinutes: { groups: 30, knockout: 45 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }], result: { status: 'played', winner: 'a' } },
    { id: 'm2', scheduled: '2025-07-14T08:30:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm3', scheduled: '2025-07-14T09:45:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm4', scheduled: '2025-07-14T10:30:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm5', scheduled: '2025-07-14T11:15:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm6', scheduled: '2025-07-14T10:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T10:00:00Z'); // m2's slot ended 09:15 — long overdue
  const rows = ctx.matches.map(m => ({ m, t: schedTime(m, ctx.tz), ctx }));
  const st = id => kioskStatus(rows.find(r => r.m.id === id), now);
  assert(st('m1') === 'done', 'a result settles first: done, whatever the clock says');
  assert(st('m2') === 'overdue', 'slot fully elapsed without a result: overdue');
  assert(st('m3') === 'due' && st('m6') === 'due', 'started and still inside its slot: due');
  assert(st('m4') === 'upcoming' && st('m5') === 'upcoming', 'future starts: upcoming');
  assert(st('m6') === 'due', 'the boundary instant (now === t) belongs to due, not upcoming');
});

test('currentRowIndex: the current slot anchors the kiosk scroll', () => {
  const times = ['2026-07-11T09:00:00', '2026-07-11T10:00:00', '2026-07-11T11:00:00'].map(s => Date.parse(s));
  const at = s => Date.parse(s);
  assert(currentRowIndex(times, at('2026-07-11T08:30:00')) === 0, 'before the first start: the first row');
  assert(currentRowIndex(times, at('2026-07-11T09:00:00')) === 0, 'the boundary instant belongs to that slot');
  assert(currentRowIndex(times, at('2026-07-11T09:30:00')) === 0, 'a gap sticks to the latest passed slot (a finished-early match stays centered)');
  assert(currentRowIndex(times, at('2026-07-11T10:15:00')) === 1, 'inside a slot: that slot');
  assert(currentRowIndex(times, at('2026-07-11T11:00:00')) === 2, 'the last slot: itself');
  assert(currentRowIndex(times, at('2026-07-11T13:00:00')) === 2, 'after the last slot: it stays');
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

test('playerStatus: per-category standing — the live wave, the podium, elimination', () => {
  const md = catOf('sample', 'md40');
  assert(playerStatus(md, 'p5') === 'In Semifinals', 'a player whose semifinal is undecided reads the full wave name');
  assert(playerStatus(md, 'p1') === 'In the final', 'a player who already won their semi is in the final, awaiting the other side');
  const full = catOf('full', 't');
  assert(playerStatus(full, 'p1') === 'Champion' && playerStatus(full, 'p5') === 'Runner-up'
    && playerStatus(full, 'p6') === '3rd' && playerStatus(full, 'p2') === '4th', 'podium words off the played bracket');
  assert(playerStatus(full, 'p3') === 'Out in groups', 'pools without a knockout seat: out, terminal, plain');
  assert(playerStatus(full, 'p4') === null, 'a player with no matches in the category renders no status');
  assert(playerStatus(catOf('sample', 'xd'), 'p3') === 'Out in groups', 'pool-only category: decided, no podium');
  // the podium renders as the category subline, names from the player registry
  const repo = loadRepo(FIX('full'));
  const info = repo.tournaments.get('full');
  const html = renderTournament({ slug: 'full', view: 'tournament' },
    { index: [], t: { slug: 'full', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) });
  const w = winners(catOf('full', 't'));
  const pt = text(html);
  assert(pt.includes('Champion') && pt.includes('Runner-up') && pt.includes('3rd'), 'a finished bracket renders the podium as its subline');
  for (const ids of [w.first, w.second, w.third]) assert(pt.includes(teamLabel(ids, catOf('full', 't'))), 'the podium names come from the player registry');
});

test('possibleStages: a group-stage player sees the whole structural bracket, byes footnoted', () => {
  const byes = catOf('byes', 't');
  const st1 = possibleStages(byes, 'p1');
  const qf = st1.find(x => x.label === 'Quarterfinals');
  const sf = st1.find(x => x.label === 'Semifinals');
  const fb = st1.find(x => x.label === 'Final / 3rd place');
  assert(st1.map(x => x.label).join(',') === 'Quarterfinals,Semifinals,Final / 3rd place', 'bracket order: deepest round first, its loser-path companion merged with it');
  assert(qf.time === Date.parse('2026-07-12T10:30:00Z') && qf.court === null, 'QF: the pool-fed quarterfinals, uniform time, two courts -> court TBD');
  assert(qf.chip === 'as 3rd–6th in Pool A', 'QF chip: the ranks that feed it, pool named');
  assert(sf.chip === 'as 1st–2nd in Pool A or as winner of the Quarterfinals', 'semis: the byed ranks enter direct, the rest must win their QF — both gates named');
  assert(fb.time === Date.parse('2026-07-12T11:30:00Z') && fb.court === null && fb.chip === 'via the Semifinals', 'merged final/bronze: shared time kept, split courts read TBD, one seat gate');
});

test('possibleStages: a decided pool collapses to the open stages; eliminated players get nothing', () => {
  const tjson = JSON.parse(JSON.stringify(require(FIX('byes', 'tournaments', 'byes.json'))));
  const r = (id, w) => { tjson.matches.t.find(m => m.id === id).result = { status: 'walkover', winner: w }; };
  // strict ladder p1 > p2 > p3 > p4 > p5 > p6 (side orders per the fixture pairing)
  for (const id of [1, 4, 7, 10, 13]) r(id, 'a'); // p1 beats all
  for (const id of [2, 6]) r(id, 'a');            // p2 beats p5, p3
  for (const id of [9, 11]) r(id, 'b');           // p2 beats p6, p4
  for (const id of [3, 14]) r(id, 'a');           // p3 beats p4, p6
  r(8, 'b');                                      // p3 beats p5
  r(5, 'b');                                      // p4 beats p6
  r(15, 'a');                                     // p4 beats p5
  r(12, 'a');                                     // p5 beats p6
  r(16, 'a'); r(17, 'a');                         // QFs: p4 (rank 4) and p3 (rank 3) win
  const ctx = makeCat({ meta: tjson.categories[0], matches: tjson.matches.t }, tjson);
  const labels = pid => possibleStages(ctx, pid).map(s => s.label).join(',');
  assert(labels('p1') === 'Final / 3rd place' && labels('p2') === 'Final / 3rd place', 'a confirmed semifinal seat keeps the final and bronze open, merged');
  assert(labels('p3') === 'Final / 3rd place' && labels('p4') === 'Final / 3rd place', 'QF winners join the same open stages');
  assert(labels('p5') === '' && labels('p6') === '', 'a decided loss with no placement leaves nothing possible');
  const chips = pid => possibleStages(ctx, pid).map(s => s.chip).join('|');
  assert(chips('p1') === 'via the Semifinals', 'the merged gate names the seat once, branch implied');
});

test('possibleStages: sample — a decided pool hands seats to the bracket; pre-event the pool view covers every rank', () => {
  const md = catOf('sample', 'md40');
  const j = pid => possibleStages(md, pid).map(s => s.label).join(',');
  const p5 = possibleStages(md, 'p5');
  assert(j('p5') === 'Final / 3rd place' && p5[0].chip === 'via the Semifinals', 'p5: an undecided semifinal seat keeps both branches, merged under one gate');
  assert(j('p1') === '' && j('p7') === '', 'decided feeders close the losing/winning branch — the final and bronze render as cards instead');
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const pre = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => ({ ...m, games: [], result: undefined })) }, tjson);
  const s0 = possibleStages(pre, 'p1');
  const sem = s0.find(x => x.label === 'Semifinals');
  assert(s0.length === 2 && sem.time === Date.parse('2025-07-14T11:15:00-04:00') && sem.chip === 'any rank in Pool A', 'pre-event: the pool view covers every rank — one semis stage, at 11:15');
  assert(s0.find(x => x.label === 'Final / 3rd place').chip === 'via the Semifinals', 'pre-event: the deeper stage reads by its seat');
});

test('possibleStages: an open classification semi merges its two branches into one band', () => {
  // A player who lost their round-1 match sits in an undecided 9th–16th semi:
  // the winner-fed 9th–12th semi and loser-fed 13th–16th semi share its two
  // parents, so twin-merge pairs them. The merged label must name the band
  // ("9th–16th semi"), never append ' place' to a semi name.
  const teams = Array.from({ length: 16 }, (_, i) => [`p${i}`]);
  const tourney = generate({
    slug: 'deep', name: 'Deep', location: 'Geneva', timezone: 'UTC', date: '2026-05-02', poolSize: 4,
    blocks: { t: '09:00' }, venues: { 'court-1': 'Court 1' },
    players: Object.fromEntries(teams.map(([id]) => [id, id])),
    categories: [{ id: 't', name: 'Single', bestOf: 1, slotMinutes: 30, placements: 16 }],
    teams: { t: teams },
  });
  const ms = tourney.matches.t;
  const poolMs = ms.filter(m => m.pool !== undefined);
  const koMs = ms.filter(m => m.pool === undefined);
  const idx = id => +id.slice(1);
  for (const m of poolMs) { // decided pools: strict rank order by player index
    const a = idx(m.sides[0].ids[0]), b = idx(m.sides[1].ids[0]);
    m.result = { status: 'played', winner: a < b ? 'a' : 'b' }; m.games = [{ a: 11, b: 9 }];
  }
  for (let i = 0; i < 8; i++) { // decided round 1: the loser advances into the classification
    const m = koMs[i];
    m.result = { status: 'played', winner: i % 2 ? 'b' : 'a' }; m.games = [{ a: 11, b: 9 }];
  }
  const ctx = makeCat({ meta: tourney.categories[0], matches: ms }, tourney);
  const lost = resolveSide(koMs[0].sides[1], ctx);
  const stages = possibleStages(ctx, [...lost][0]);
  const merged = stages.find(s => s.label === '9th–16th semi');
  assert(merged && merged.chip === 'via the 9th–16th semi', 'the open classification semi reads as one band with its seat gate');
  assert(!stages.some(s => /semi place$/.test(s.label)), 'no mangled semi label gained a place suffix');
  assert(stages.some(s => s.label === '9th / 11th place') && stages.some(s => s.label === '13th / 15th place'), 'the decider pairs below still merge by name');
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
  assert(text(st).includes('void'), 'void renders on its card');
  // m2 is pool A, walkover winner b (p3): the W/O mark rides the winner's row —
  // text adjacency: the mark sits right after the winning name, not the loser's
  assert(text(st).includes('P3 W/O'), 'W/O renders on the winning side');
  const venue = renderVenue({ slug: 'result', view: 'venues' }, data, Date.parse('2026-05-02T09:30:00Z'));
  assert(text(venue).includes('P1') && text(venue).includes('P3'), 'the board carries every court-1 slot');
  assert(vals(venue, 'data-status').includes('done') && text(venue).includes('void') && text(venue).includes('W/O'), 'settled matches — played, walkover, void — all stay on the full-day board');
  assert(vals(venue, 'data-status').includes('upcoming'), 'the open 11:00 final is still upcoming at 09:30');
  assert(vals(venue, 'data-current').length >= 1, 'the board marks its anchor row for the follow');
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

test('bracket walkers tolerate a sideless match: report, never throw', () => {
  const ko = makeCat({ meta: {}, matches: [
    { id: 'sf1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'sf2', sides: [{ kind: 'players', ids: ['c'] }, { kind: 'players', ids: ['d'] }] },
    { id: 'f', sides: [{ kind: 'match', match: 'sf1', result: 'winner' }, { kind: 'match', match: 'sf2', result: 'winner' }] },
    { id: 'b', sides: [{ kind: 'match', match: 'sf1', result: 'loser' }, { kind: 'match', match: 'sf2', result: 'loser' }] },
    { id: 'x' },
  ] }, { timezone: 'UTC', players: [] });
  assert(koColumn(ko.byId.get('f'), ko) === 0 && koColumn(ko.byId.get('b'), ko) === 0, 'columns still compute around the broken match');
  assert(koOrdinal(ko.byId.get('f'), ko) === 1 && koOrdinal(ko.byId.get('sf1'), ko) === 1, 'ordinals still compute');
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

test('placementLabel: odd classification (7 teams, placements 8) spans the true range, one claim per rank', () => {
  // A 7-team bracket's first round is partial (1 bye): its 3 losers classify as
  // ranks 5-7. The middle loser waits for the winner of (l0,l2), so the semi
  // must not be read as a terminal 5th-place decider — no ghost 8th, and no
  // two matches claiming the same rank.
  const teams = Array.from({ length: 7 }, (_, i) => [`p${i}`]);
  const tourney = generate({
    slug: 'odd', name: 'Odd', location: 'Geneva', timezone: 'UTC', date: '2026-05-02', poolSize: 7,
    blocks: { t: '09:00' }, venues: { 'court-1': 'Court 1' },
    players: Object.fromEntries(teams.map(([id]) => [id, id])),
    categories: [{ id: 't', name: 'Single', bestOf: 1, slotMinutes: 30, knockout: true, placements: 8 }],
    teams: { t: teams },
  });
  const ctx = makeCat({ meta: tourney.categories[0], matches: tourney.matches.t }, tourney);
  const labels = ctx.matches.filter(m => m.pool === undefined).map(m => matchLabel(m, ctx));
  const count = l => labels.filter(x => x === l).length;
  assert.equal(count('3rd place'), 1, 'bronze');
  assert.equal(count('5th–7th semi'), 1, 'losers of the partial first round');
  assert.equal(count('5th place'), 1, 'classification decider');
  assert.equal(count('5th–8th semi'), 0, 'no ghost 8th — the field has 7 teams');
});

test('placementLabel: depth-3 odd classification (13 teams, placements 16) exact to the middle loser', () => {
  // R1 loser pool of 5 spans ranks 9-13. The middle loser waits for the winner
  // of (l0,l4) — it can only reach 9th-11th, so its join must not be ranged to
  // the pool's bottom ("9th–13th"), and the sawtooth bottom (12th/13th) stays
  // a fixed place with no ghost ranks above the field.
  const teams = Array.from({ length: 13 }, (_, i) => [`p${i}`]);
  const tourney = generate({
    slug: 'odd13', name: 'Odd13', location: 'Geneva', timezone: 'UTC', date: '2026-05-02', poolSize: 13,
    blocks: { t: '09:00' }, venues: { 'court-1': 'Court 1' },
    players: Object.fromEntries(teams.map(([id]) => [id, id])),
    categories: [{ id: 't', name: 'Single', bestOf: 1, slotMinutes: 30, knockout: true, placements: 16 }],
    teams: { t: teams },
  });
  const ctx = makeCat({ meta: tourney.categories[0], matches: tourney.matches.t }, tourney);
  const labels = ctx.matches.filter(m => m.pool === undefined).map(m => matchLabel(m, ctx));
  const count = l => labels.filter(x => x === l).length;
  assert.equal(count('9th–11th semi'), 1, 'middle loser joins at its true ceiling');
  assert.equal(count('9th–13th semi'), 2, 'the paired extremes genuinely span the pool');
  assert.equal(count('12th place'), 1, 'true bottom of the odd pool');
  assert.equal(count('13th place'), 0, 'no ghost 13th place match — it is the 12th/13th sawtooth');
  const maxRank = Math.max(...labels.filter(l => l.includes('–') || l.endsWith('place'))
    .flatMap(l => (l.match(/\d+/g) || []).map(Number)));
  assert.ok(maxRank <= 13, 'no ranks above the 13-team field');
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
  assert(text(standings).includes('Pool A') && text(standings).includes('Final') && text(standings).includes('Winner of SF2'), 'standings renders pools, bracket, and slot labels');
  assert(!text(standings).includes('BO3'), 'no best-of label — the score slots carry it');
  assert(standings.includes('aria-hidden="true"'), 'unplayed best-of slots are placeholders, hidden from screen readers');
  assert(text(standings).includes('Ada Lovelace'), 'standings renders player names');
  assert(text(standings).includes('Pool A') && text(standings).includes('Court 1') && vals(standings, 'datetime').length > 0, 'standings card meta: label, venue, and a semantic time — no match id, no category id');
  const seg = links(standings).filter(l => l.text === 'Tournament' || l.text === 'Schedule');
  assert(seg.length === 2 && seg[0].href === '#sample' && seg[0].current && seg[1].href === '#sample/schedule' && !seg[1].current, 'tournament page: segment switch, Tournament current');
  // semantic: heading levels are the a11y outline — one category heading per page
  assert((standings.match(/<h2\b/g) || []).length === 1 && text(standings).includes('Pool A'), 'one category per page — the bare slug shows the first');
  const xd = renderTournament({ slug: 'sample', view: 'tournament', cat: 'xd' }, data);
  assert((xd.match(/<h2\b/g) || []).length === 1 && text(xd).includes('Mixed Doubles'), '?cat= selects the category');
  assert(text(renderTournament({ slug: 'sample', view: 'tournament', cat: 'nope' }, data)).includes("Men's Doubles 40+"), 'an unknown cat falls back to the first');
  const mdLink = links(standings).find(l => l.text === "Men's Doubles 40+");
  const xdLink = links(standings).find(l => l.text === 'Mixed Doubles');
  assert(mdLink.href === '#sample' && mdLink.current && xdLink.href === '#sample?cat=xd' && !xdLink.current, 'the category switcher: first segment canonical at the bare slug, the rest carry ?cat=');
  assert(links(xd).find(l => l.text === 'Mixed Doubles').current && !links(xd).find(l => l.text === "Men's Doubles 40+").current, 'the switcher lights the selected category');
  assert(!links(standings).some(l => l.text === 'md40'), 'switcher labels show the category name, never the id');
  const venue = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T12:00:00-04:00')); // pinned to the fixture day — the kiosk shows today only
  assert(text(venue).includes('Court 1') && text(venue).includes('Ada Lovelace'), 'venue page renders venue boards with match rows');
  assert(vals(venue, 'data-status').length > 0, 'kiosk card: the status rides the card; meta keeps cat · label only');
  const early = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T08:00:00-04:00'));
  const late = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T16:00:00-04:00'));
  assert(!text(early).includes('overdue'), 'before the first start: no overdue remark');
  assert(text(late).includes('overdue'), 'slot fully elapsed without a result: the headline time carries the remark beside it');
  const running = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T12:20:00-04:00'));
  assert(/\bdue\b/.test(text(running)), 'a match inside its slot says due in words, not hue alone');
  assert((text(late).match(/overdue/g) || []).length === vals(late, 'data-status').filter(s => s === 'overdue').length, 'every overdue card has the remark, and only overdue cards do');
  const midday = renderVenue({ slug: 'sample', view: 'venues' }, data, Date.parse('2025-07-14T12:20:00-04:00'));
  assert(vals(midday, 'data-status').includes('done'), 'a midday board keeps the morning results, muted');
  assert(text(venue).includes("Men's Doubles 40+") && text(venue).includes('Final'), 'kiosk meta shows the long category name and label, no match id');
  assert(text(standings).includes('Knockout stage') && text(standings).includes('Semifinals'), 'category subline: plain progress line, the wave link lives on the Next line (single-day heading already stated the date)');
  assert(standings.includes('<h1>Sample</h1>') && text(standings).includes('Mon, Jul 14') && text(standings).includes('New York'), 'semantic title; one-day heading subline states the date and the location');
  assert(!text(standings).includes('Jul 14,'), 'single-day: cards carry just the time, the date lives once in the heading');
  assert(text(xd).includes('Mixed Doubles') && text(xd).includes('Finished') && vals(xd, 'data-status').includes('finished'), 'a fully decided pool-only category: status-only subline on a single-day page, in the done-voice (no final, no podium)');
  assert(text(standings).includes('Group stage'), 'group stage: pools first under the heading');
  assert(text(standings).includes('Group matches'), 'group stage: pools, then the Matches heading, then the cards');
  assert(text(standings).indexOf('Pool A') < text(standings).indexOf('Group matches'), 'pools sit inside the group stage, before the match cards');
  // last occurrences: the category subline can name the stages too — the section headings are the last ones
  assert(text(standings).lastIndexOf('Group stage') < text(standings).lastIndexOf('Knockout stage'), 'schedule before the bracket — chronological flow');
  assert(text(standings).includes('Knockout stage') && text(standings).includes('Semifinals'), 'knockout: rounds and cards — always open, no count subline');
  for (const j of vals(standings, 'data-jump')) assert(card(standings, 'id', j) !== undefined, `every jump link has its target section (${j})`);
  // mid-groups state: an unresolved group match opens the schedule and re-counts the chip
  const midJson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  midJson.matches.md40[0].result = undefined;
  const mid = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' },
    { index: [], t: { slug: 'sample', name: midJson.name }, tjson: midJson,
      cats: toCats(midJson) });
  assert(text(mid).includes('5 of 6 played') && vals(mid, 'data-jump').includes('group-matches'), 'running groups: the plain progress count, and the group-matches link lives on the Next line');
  assert(text(mid).includes('1 Ada Lovelace / Grace Hopper'), 'ranks return once a pool has a decided match');
  assert(text(mid).includes('Group matches'), 'running groups: pools, then the Matches heading, then the cards — the status lives in the category subline');
  assert(!mid.includes('data-stage') && !mid.includes('toggle'), 'no disclosure machinery ships — nothing hides, nothing toggles');
  // the subline's stage link and the accent agree: unscored cards of the linked
  // wave carry the next highlight — done cards and other waves don't
  assert.equal(vals(standings, 'data-status').filter(s => s === 'next').length, 1, 'ko in play: only the one unscored semifinal card carries the accent (the played SF1 and the unplayed final do not)');
  assert(card(standings, 'data-status', 'next').includes('SF2'), 'the highlighted card is the unresolved semifinal, not a done or other-round card');
  assert.equal(vals(mid, 'data-status').filter(s => s === 'next').length, 1, 'groups in play: only the one unscored group match carries the accent');
  const { data: rdata } = dataOf('result');
  const res = renderTournament({ slug: 'result', view: 'tournament' }, rdata);
  assert(!text(res).includes('advance'), 'partial draw: no advance note on pool headings');
  // the pool roster is the "who is in my pool" answer — it must render before the first result
  const preJson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  for (const ms of Object.values(preJson.matches)) for (const m of ms) { delete m.result; delete m.games; }
  const pre = renderTournament({ slug: 'sample', view: 'tournament' },
    { index: [], t: { slug: 'sample', name: preJson.name }, tjson: preJson,
      cats: toCats(preJson) });
  assert(text(pre).includes('Ada Lovelace / Grace Hopper'), 'pools roster (teams) is visible before the first result');
  assert(text(pre).includes('Starts'), 'pre-start anticipation line');
  assert(!text(pre).includes('1 Ada Lovelace'), 'no phantom rank 1s before any result');
  assert(!vals(pre, 'data-status').includes('next'), 'pre-start category: no stage link yet, no highlight');
  assert(!vals(xd, 'data-status').includes('next'), 'finished category: no stage link, no highlight');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  assert(ppage.includes('<h1>') && text(ppage).includes('Ada Lovelace') && links(ppage).some(l => l.text === 'Change' && l.href === '#sample/schedule'), 'semantic title; the pick-correcting link rides the name');
  assert.equal(cards(ppage, 'id', 'next').length, 1, 'exactly one next match card, carrying the jump target (the header line links to it)');
  const nextText = card(ppage, 'id', 'next');
  assert(nextText.includes("Men's Doubles 40+") && nextText.includes('Final'), 'the next card is the first unscored match — the md40 Final');
  const allDone = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p2' }, dataOf('result').data);
  assert(!vals(allDone, 'data-status').includes('next'), 'fully scored player: no next-match highlight');
  assert(text(ppage).includes('Mon, Jul 14'), 'the day section title carries the date — cards stay bare in it');
  assert(!text(ppage).includes('2025-07-14'), 'no raw ISO payload in the text — the instant rides the datetime attribute only');
  const p3 = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p3' }, data);
  assert.equal(vals(p3, 'data-status').filter(s => s === 'possible').length, 1, 'p3: a confirmed semifinal seat renders the open final and bronze as one merged possible card');
  assert(text(p3).includes('Final / 3rd place') && text(p3).includes('via the Semifinals'), 'the merged gate rides in the meta line, not as a separate row');
  assert(!text(p3).includes('more matches possible'), 'the count note is gone — cards replaced it');
  assert(vals(ppage, 'datetime').length > 0 && text(ppage).includes('Court 1'), 'player card headline: semantic time left, court right');
  assert(text(ppage).includes("Men's Doubles 40+") && text(ppage).includes('Pool A'), 'player card meta: long cat name and label, no match id, no court/time');
  assert(ppage.includes('aria-hidden="true"'), 'player match cards render unplayed score slots too');
  assert(text(ppage).includes('Ada Lovelace'), 'player page finds the player');
  const pseg = links(ppage).filter(l => l.text === 'Tournament' || l.text === 'Schedule');
  assert(pseg[0].href === '#sample?player=p1' && !pseg[0].current && pseg[1].href === '#sample/schedule?player=p1' && pseg[1].current, 'player page: segment switch, Schedule current, pick preserved in links');
  const ptext = text(ppage);
  assert(ptext.includes("Men's Doubles 40+") && ptext.includes('In the final') && ptext.includes('Mixed Doubles') && ptext.includes('Out in groups'), 'player page: standing line names each category: progress');
  assert(ptext.includes('Next') && ptext.includes('12:15') && ptext.includes('Court 1'), 'the whole next line is the link — time and court named');
  assert(vals(ppage, 'datetime').includes('2025-07-14T16:15:00.000Z'), 'the next line carries the instant in a semantic time element');
  const nextLink = links(ppage).find(l => l.text.startsWith('Next'));
  assert(nextLink && nextLink.jump === 'next' && nextLink.href === '#sample/schedule?player=p1', 'the whole next line is the link to the next card');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule' }, data);
  const pseg2 = links(picker).filter(l => l.text === 'Tournament' || l.text === 'Schedule');
  assert(pseg2[0].href === '#sample' && pseg2[1].href === '#sample/schedule' && pseg2[1].current, 'picker: segment switch, Schedule current');
  assert(picker.includes('<h1>') && text(picker).includes('Pick a player'), 'semantic title; the heading invites the pick');
  assert(text(picker).includes("Men's Doubles 40+") && text(picker).includes('Mixed Doubles'), 'picker groups players per category under a heading');
  assert(links(picker).some(l => l.href === '#sample/schedule?player=p1' && l.text === 'Ada Lovelace'), 'picker rows: plain name link carrying the player param');
  // per-section alphabetical; a player in two categories appears in both sections
  const secs = picker.split('<section>').slice(1);
  const pickers = sec => links(sec).filter(l => /\/schedule\?player=/.test(l.href)).map(l => l.text);
  for (const sec of secs) {
    const names = pickers(sec);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'each category section lists players alphabetically');
  }
  // sample fields the whole roster in both categories — the two sections are the same list
  assert.deepEqual(pickers(secs[0]), pickers(secs[1]), 'a player in md40 and xd appears in both sections');
  assert(links(renderIndex({ view: 'index' }, data)).some(l => l.href === '#sample'), 'index links the tournament');
  const idx = renderIndex({ view: 'index' }, { index: [
    { slug: 'soon', name: 'Later' },
    { slug: 'wide', name: 'Wide', dates: ['2026-07-11', '2026-07-12'] },
    { slug: 'sample', name: 'Sample', location: 'New York', dates: ['2025-07-14'] },
  ] });
  assert(idx.includes('<h1>') && text(idx).includes('Tip: open a tournament and add it to your home screen for easy access to live results and your match schedule.'), 'semantic title; one muted add-to-home-screen tip in the header');
  assert((text(idx).match(/to your home screen/g) || []).length === 1, 'the tip lives once in the header, never per card');
  assert(text(idx).indexOf('Wide') < text(idx).indexOf('Sample') && text(idx).indexOf('Sample') < text(idx).indexOf('Later'), 'sorted by start date descending, undated last');
  assert(text(idx).includes('Mon, Jul 14') && text(idx).includes('New York') && text(idx).includes('Sat–Sun, Jul 11–12'), 'a card carries its date span and location');
  assert(links(idx).some(l => l.href === '#sample' && l.text.startsWith('Sample')), 'the whole card opens the tournament');
  assert(links(idx).some(l => l.href === '#sample/venues' && l.text === 'Venue board'), 'the venue board is a sibling of the card link, never nested in it');
  assert(links(idx).filter(l => l.href === '#sample/venues').length === 1, 'venue board appears once per tournament');
  assert(links(idx).some(l => l.href === '#soon' && l.text.startsWith('Later')), 'an undated tournament keeps its card');
  assert(!idx.includes('undefined') && !idx.includes('null'), 'no date renders clean, no null payload');
  // a registered player with no match anywhere is not pickable — the pick must always render a schedule
  const sparse = JSON.parse(JSON.stringify(data.tjson));
  sparse.players.push({ id: 'bench', name: 'Ben Ched' });
  const spr = renderPlayer({ slug: 'sample', view: 'schedule' }, { ...data, tjson: sparse });
  assert(text(spr).includes('Ada Lovelace') && !text(spr).includes('Ben Ched'), 'picker lists only participating players');
  // escaping: a hostile name must reach the DOM entity-encoded — the raw HTML is the contract
  const evil = JSON.parse(JSON.stringify(data.tjson));
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  // hostile pool strings are free-form and land in the heading — esc keeps them inert
  const evilPool = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  evilPool.matches.md40[0].pool = 'A" onclick="alert(1)';
  const pdata = { index: [], t: { slug: 'sample', name: evilPool.name }, tjson: evilPool,
    cats: toCats(evilPool) };
  const ph = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, pdata);
  assert(!ph.includes('Pool A" onclick='), 'the injected handler never lands in the DOM');
  assert(ph.includes('A&quot; onclick=&quot;alert(1)'), 'the pool string renders entity-encoded');
  // tied teams share the first rank of their group (standard competition ranking: 1 1)
  const { data: tdata } = dataOf('tie');
  const tieHtml = renderTournament({ slug: 'tie', view: 'tournament' }, tdata);
  assert(!text(tieHtml).includes('†') && text(tieHtml).includes('1 A') && text(tieHtml).includes('1 B'), 'tied teams share rank 1, no dagger');
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

test('possible stages render as cards: gates in the meta, and the next header goes conditional', () => {
  const repo = loadRepo(FIX('byes'));
  const info = repo.tournaments.get('byes');
  const data = { index: repo.index, t: { slug: 'byes', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const page = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p4' }, data);
  assert.equal(vals(page, 'data-status').filter(s => s === 'possible').length, 3, 'p4 (pool open): three possible stages — QF, SF, and the merged final/bronze');
  assert(text(page).includes('Quarterfinals') && text(page).includes('as 3rd–6th in Pool A'), 'the stage label carries no count');
  assert(text(page).includes('Semifinals') && text(page).includes('as 1st–2nd in Pool A or as winner of the Quarterfinals'), 'the rank gates ride in the meta line, not as a separate row');
  assert(!text(page).includes('skip the Quarterfinals'), 'the bye is implicit in the chip — no footnote');
  assert(text(page).includes('TBD'), 'a non-uniform bit (the QF court) renders marked TBD');
  assert(text(page).includes('Singles') && text(page).includes('Final / 3rd place') && text(page).includes('via the Semifinals'), 'the merged final/bronze keeps its label and the seat gate in the meta');
  assert(!text(page).includes('more matches possible'), 'the count note is gone');
  // next points at the earliest possible stage when no confirmed match is left
  const tjson = JSON.parse(JSON.stringify(info.tjson));
  for (const id of [1, 4, 7, 10, 13]) tjson.matches.t.find(m => m.id === id).result = { status: 'walkover', winner: 'a' };
  const page2 = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p1' }, { ...data, tjson, cats: toCats(tjson) });
  const p2t = text(page2);
  assert(p2t.includes('Next') && p2t.includes('Quarterfinals') && p2t.includes('10:30') && p2t.includes('(as 3rd–6th in Pool A)'), 'next names the earliest possible stage with its condition');
  assert(vals(page2, 'datetime').includes('2026-07-12T10:30:00.000Z'), 'the next line carries the instant in a semantic time element');
  assert(card(page2, 'id', 'next').includes('Quarterfinals'), 'the earliest possible card is the jump target, never carrying the confirmed accent');
  assert.equal(vals(page2, 'data-status').filter(s => s === 'next').length, 1, 'only the header line carries the green accent — possible cards never do');
});


test('multi-day: cards carry their full date; single-day cards just the time; the kiosk shows one day at a time, previewing day one early', () => {
  const repo = loadRepo(FIX('multiday'));
  const info = repo.tournaments.get('multiday');
  const data = { index: repo.index, t: { slug: 'multiday', name: info.tjson.name }, tjson: info.tjson, cats: toCats(info.tjson) };
  const page = renderTournament({ slug: 'multiday', view: 'tournament' }, data);
  assert(text(page).includes('Sat–Sun, Jul 11–12') && text(page).includes('Boston'), 'the heading subline collapses consecutive days and gives the location');
  assert(text(page).includes('Sat–Sun, Jul 11–12') && text(page).includes('Group stage') && text(page).includes('5 of 6 played') && vals(page, 'data-jump').includes('group-matches'), 'the category subline splits the multi-day range from the status, and links only the Next line');
  assert(!text(page).includes('Pools'), 'no separate pools section');
  assert(vals(page, 'datetime').includes('2026-07-11T13:00:00.000Z') && text(page).includes('Sat, Jul 11, 09:00') && vals(page, 'datetime').includes('2026-07-11T15:00:00.000Z') && text(page).includes('Sat, Jul 11, 11:00'), 'Saturday cards carry the date with the time');
  assert(vals(page, 'datetime').includes('2026-07-12T13:00:00.000Z') && text(page).includes('Sun, Jul 12, 09:00') && vals(page, 'datetime').includes('2026-07-12T15:00:00.000Z') && text(page).includes('Sun, Jul 12, 11:00'), 'Sunday knockout cards carry the date too');
  assert(text(page).includes('Group matches'), 'the running group stage: pools, then the Matches heading, then the cards');
  assert(text(page).includes('Semifinals') && text(page).includes('Final'), 'the knockout is always open — rounds listed in order');
  // the player page groups under date headings — the day owns the context, and
  // the possible line names its own day on multi-day pages
  const ppage = renderPlayer({ slug: 'multiday', view: 'schedule', player: 'p1' }, data);
  assert(text(ppage).includes('Sat, Jul 11'), 'the player page headers its days');
  assert(text(ppage).includes('Sun, Jul 12'), 'the possible stages sit under their own day heading');
  assert(text(ppage).includes('Sun, Jul 12, 09:00'), 'a possible stage card carries its own date on multi-day pages');
  // moving a match to another day just re-dates its card — no divider machinery
  const split = JSON.parse(JSON.stringify(info.tjson));
  split.matches.md40[5].scheduled = '2026-07-12T15:00:00'; // m6 (pool) -> Sunday
  const spage = renderTournament({ slug: 'multiday', view: 'tournament' },
    { index: repo.index, t: data.t, tjson: split, cats: toCats(split) });
  assert(vals(spage, 'datetime').includes('2026-07-12T19:00:00.000Z') && text(spage).includes('Sun, Jul 12, 15:00'), 'a rescheduled pool match carries its new day on the card');
  const sInfo = loadRepo(FIX('sample')).tournaments.get('sample');
  const single = renderTournament({ slug: 'sample', view: 'tournament' },
    { index: repo.index, t: { slug: 'sample', name: sInfo.tjson.name }, tjson: sInfo.tjson, cats: toCats(sInfo.tjson) });
  assert(single.includes('<h1>') && text(single).includes("Men's Doubles 40+") && text(single).includes('Mon, Jul 14') && text(single).includes('New York') && !text(single).includes('Jul 14,'), 'single-day tournament: one date in the heading subline, cards carry only the time');

  // kiosk: strict same-day in the tournament timezone, from the device clock instant
  const at = iso => Date.parse(iso);
  const sat = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-11T12:00:00-04:00'));
  assert(text(sat).includes('Katherine Johnson') && !text(sat).includes('SF') && !text(sat).includes('Final'), 'saturday board: open pool match, no tomorrow');
  assert(text(sat).includes('Today'), 'today board: the note names the day shown');
  const sun = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-12T08:00:00-04:00'));
  assert(text(sun).includes('SF') && text(sun).includes('Final') && !text(sun).includes('Katherine Johnson'), 'sunday board: knockout only, yesterday gone');
  const mon = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-13T12:00:00-04:00'));
  assert(text(mon).includes('SF') && text(mon).includes('Final') && !text(mon).includes('Katherine Johnson'), 'after the last day: the board falls back to the last day (Sunday knockout), not a stale today');
  assert(text(mon).includes('Sun, Jul 12') && !text(mon).includes('Today'), 'the post-event board names the day shown, never today');
  const fri = renderVenue({ slug: 'multiday', view: 'venues' }, data, at('2026-07-10T12:00:00-04:00'));
  assert(text(fri).includes('Katherine Johnson') && !text(fri).includes('SF') && !text(fri).includes('Final'), 'a day before day one: the board previews the first day, pools only');
  assert(text(fri).includes('Sat, Jul 11'), 'the preview note names the day shown, not today');
});

test('date spans: consecutive days collapse, sparse days list, a year boundary appends the year', () => {
  const tjson = { name: 'T', timezone: 'UTC', venues: [], players: [], categories: [{ id: 't', name: 'T1' }], matches: { t: [
    { id: 1, scheduled: '2026-12-30T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 2, scheduled: '2027-01-02T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] } };
  const data = { index: [], t: { slug: 't', name: tjson.name }, tjson, cats: toCats(tjson) };
  const page = renderTournament({ slug: 't', view: 'tournament' }, data);
  assert(text(page).includes('Wed, Dec 30, Sat, Jan 2, 2027'), 'sparse days list each label; a year boundary appends the end year; no location renders clean');
  // closing the gap makes the run consecutive — cross-month collapsed form
  tjson.matches.t.splice(1, 0,
    { id: 3, scheduled: '2026-12-31T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 4, scheduled: '2027-01-01T09:00:00', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] });
  data.cats = toCats(tjson); // contexts snapshot the matches — rebuild after mutating
  const run = renderTournament({ slug: 't', view: 'tournament' }, data);
  assert(text(run).includes('Wed–Sat, Dec 30 – Jan 2, 2027'), 'consecutive cross-month days keep both months and the end year');
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

test('knockout: placement matches merge into their depth band — the bronze under the Final heading', () => {
  const repo = loadRepo(FIX('sample'));
  const info = repo.tournaments.get('sample');
  const data = { index: repo.index, t: repo.index[0], tjson: info.tjson, cats: toCats(info.tjson) };
  const html = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  const t = text(html);
  assert(t.includes('Final / 3rd place'), 'the Final band names its placement companion');
  // after the merged band heading, a standalone '3rd place' card label follows — the bronze sits under the Final
  assert(t.indexOf('3rd place', t.indexOf('Final / 3rd place') + 'Final / 3rd place'.length) !== -1, 'the bronze sits under the Final heading');
  assert(!html.includes('ko-placement'), 'no separate Placement section survives');
  assert(t.includes('Semifinals'), 'a band with no placement companion keeps the plain round name');
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
  assert(vals(doneHtml, 'data-jump').includes('ko-0') && text(doneHtml).includes('Final / 3rd place'), 'placement-pending links to the merged band, not a round or a Placement section');
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
  assert(cards(html, 'data-status', 'next').some(c => c.includes('3rd place')), 'the accent reaches the bronze inside the merged band');
  // a bronze fed by an undecided semi stays unaccented (sample as-is: only the open semi is flagged)
  const oh = render(base());
  assert.equal(vals(oh, 'data-status').filter(s => s === 'next').length, 1, 'a placement match whose feeder is undecided is not flagged');
});

test('playerStatus: a player with only a placement match left reads "In placement", not "In the final"', () => {
  const tjson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  for (const id of [7, 8, 9]) {
    const m = tjson.matches.md40.find(x => x.id === id);
    m.result = { status: 'played', winner: 'a' }; delete m.games;
  }
  const ctx = makeCat({ meta: tjson.categories.find(c => c.id === 'md40'), matches: tjson.matches.md40 }, tjson);
  assert.equal(playerStatus(ctx, 'p7'), 'In placement', 'p7 only has the open bronze left — not a championship round');
  // a player still in a live semi is named by that round, ignoring the open bronze
  const open = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const c2 = makeCat({ meta: open.categories.find(c => c.id === 'md40'), matches: open.matches.md40 }, open);
  assert.equal(playerStatus(c2, 'p5'), 'In Semifinals', 'live semi names the wave, open bronze does not drag it to Final');
});

test('tournament subline: status (progress) and anticipation (next wave) are separate lines', () => {
  // two pool matches unplayed, both at the same earliest time on different courts
  const tjson = {
    name: 'T', location: 'Hall', timezone: 'UTC',
    venues: [{ id: 'c1', name: 'Court 1' }, { id: 'c2', name: 'Court 2' }, { id: 'c3', name: 'Court 3' }],
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }],
    categories: [{ id: 't', name: 'T', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 30, knockout: 30 } }],
    matches: {
      t: [
        { id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 9 }], result: { status: 'played', winner: 'a' } },
        { id: 2, pool: 'A', scheduled: '2026-05-02T09:30:00', venue: 'c2', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['c'] }] },
        { id: 3, pool: 'A', scheduled: '2026-05-02T09:30:00', venue: 'c3', sides: [{ kind: 'players', ids: ['b'] }, { kind: 'players', ids: ['d'] }] }
      ]
    }
  };
  const data = { index: [], t: { slug: 't', name: 'T' }, tjson, cats: toCats(tjson) };
  const html = renderTournament({ slug: 't', view: 'tournament' }, data);
  const tt = text(html);
  assert(tt.includes('Group stage') && tt.includes('1 of 3 played'), 'status: progress only, plain');
  assert(tt.includes('Next') && tt.includes('09:30') && tt.includes('Courts 2–3'), 'anticipation: the whole simultaneous wave, courts collapsed');
  assert(vals(html, 'datetime').includes('2026-05-02T09:30:00.000Z'), 'the anticipation line carries the instant in a semantic time element');
  const nextLink = links(html).find(l => l.text.startsWith('Next'));
  assert(nextLink && nextLink.jump === 'group-matches' && nextLink.href === '#t', 'the whole anticipation line is a link to the section');
  // pre-start: no progress status line at all, just anticipation
  const preJson = JSON.parse(JSON.stringify(tjson));
  for (const m of preJson.matches.t) delete m.result, delete m.games;
  const preData = { index: [], t: { slug: 't', name: 'T' }, tjson: preJson, cats: toCats(preJson) };
  const pre = renderTournament({ slug: 't', view: 'tournament' }, preData);
  const ptt = text(pre);
  assert(ptt.includes('Starts') && ptt.includes('09:00'), 'pre-start: the start is anticipation, not a progress status');
  assert(vals(pre, 'datetime').includes('2026-05-02T09:00:00.000Z'), 'the start line carries the instant');
  assert(!ptt.includes('played'), 'pre-start: no progress status line before a match resolves');
  // finished: status stays, anticipation vanishes
  const fullJson = JSON.parse(JSON.stringify(tjson));
  for (const m of fullJson.matches.t) m.result = { status: 'played', winner: 'a' }, delete m.games;
  const full = renderTournament({ slug: 't', view: 'tournament' }, { index: [], t: { slug: 't', name: 'T' }, tjson: fullJson, cats: toCats(fullJson) });
  assert(!text(full).includes('Next'), 'finished: no anticipation line remains');
});

