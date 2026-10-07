'use strict';

// Site behavior: derive.js facts (ladder order, slot resolution, result
// statuses, ties — the gate's shared model) and views.js/i18n.js words (labels,
// status, formatting), plus app.js renderer smoke — shipped state only
// (status/data-jump hooks, escapes, a11y, routing); the words and layout the
// renderer emits are review surface, not test surface (per AGENTS.md).
// Run from the repo root: `node --test`, or one suite:
// `node --test --test-name-pattern 'slot' test/app.test.js`

const fs = require('fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCat, winnerIdx, isDone, poolStandings, poolRanks, poolSealed, resolveSide, playerMatches, matchSlotMs, plRange, koColumn, koOrdinal, schedTime, dayKey, toCats, isDeadTie, winners, placementColumn, catStatus, currentWave, startableAhead } = require('../site/derive.js');
const { sideLabel, placementLabel, matchLabel, fmtTime, roundName, playerStatus, possibleStages, setLocale } = require('../site/views.js');
const { I18N } = require('../site/i18n.js');
const { parseRoute, resolveLang, loadAll, needsFetch, superseded, timeoutSignal, renderIndex, renderTournament, renderVenue, renderPlayer, paintBadRoute, setPending, pageTitle, freshness, changedTournament, LAG_MS, STALE_MS } = require('../site/app.js');
const { generate } = require('../src/schedule.js');
const { FIX, catOf, pageData, repoPage, withTjson, text, vals, card, cards, links, lk } = require('./helpers.js');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');

// The bare tournament body every renderer case shares; pass only what the case varies.
const bareCat = { id: 't', name: 'T', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 30, knockout: 30 } };
const bare = ({ venues = [], players = [], matches = {}, categories = [bareCat], ...rest } = {}) =>
  ({ name: 'Bad', location: 'Hall', timezone: 'UTC', venues, players, categories, matches, ...rest });

// The kiosk renderer takes the fetch stamp; these tests drive the board's clock, so the
// stamp carries the instant and no successful fetch yet.
const clockAt = ms => ({ at: 0, now: ms });

test('schedTime: an invalid timezone reads as unparseable — never throws', () => {
  assert.equal(schedTime({ scheduled: '2026-05-02T09:00:00' }, 'Mars/Olympus'), null, 'a bad tz is a parse failure, not a crash');
  assert(schedTime({ scheduled: '2026-05-02T09:00:00' }, 'UTC') > 0, 'a good tz still anchors the wall time');
});

test('schedTime resolves DST wall times, rejects the spring gap, and picks the first fall occurrence', () => {
  const repo = loadRepo(FIX('dst-wall-time'));
  const tj = repo.tournaments.get('dst-wall-time').tjson;
  assert.equal(validateRepo(repo).errs.length, 0, 'the committed transition-date scenario validates');
  const tz = tj.timezone;
  const before = schedTime(tj.matches.t[0], tz);
  assert.equal(new Date(before).toISOString(), '2026-03-29T00:30:00.000Z');
  assert.equal(fmtTime(before, tz), '01:30', 'the pre-transition wall time stays exact');
  assert.equal(schedTime({ scheduled: '2026-03-29T02:30:00' }, tz), null, 'a skipped local time has no instant');
  const fold = schedTime({ scheduled: '2026-10-25T02:30:00' }, tz);
  assert.equal(new Date(fold).toISOString(), '2026-10-25T00:30:00.000Z', 'an ambiguous time uses its first occurrence');

  const gap = JSON.parse(JSON.stringify(tj));
  gap.matches.t[0].scheduled = '2026-03-29T02:30:00';
  const broken = validateRepo({ ...repo, tournaments: new Map([['dst-wall-time', { tjson: gap }]]) });
  assert(broken.errs.some(e => /does not parse as an instant/.test(e)), 'the gate rejects a nonexistent wall time');
});

test('renderers: a tournament with no categories renders empty — never throws', () => {
  const tjson = bare({ name: 'Empty', categories: [] });
  const data = pageData(tjson, 'empty');
  assert.doesNotThrow(() => renderTournament({ slug: 'empty', view: 'tournament' }, data), 'tournament page');
  assert.doesNotThrow(() => renderVenue({ slug: 'empty', view: 'venues' }, data, clockAt(Date.now())), 'venue view too');
  assert.doesNotThrow(() => renderPlayer({ slug: 'empty', view: 'schedule' }, data), 'player picker too');
});

test('renderers: a null category entry is skipped, never throws', () => {
  const tjson = bare({ categories: [null, bareCat] });
  const cats = toCats(tjson);
  assert.equal(cats.length, 1, 'the non-object entry renders as absent');
  const data = { index: [], t: { slug: 'bad', name: 'Bad' }, tjson, cats };
  assert.doesNotThrow(() => renderTournament({ slug: 'bad', view: 'tournament' }, data), 'the shell renders around the absent entry');
});

test('renderers: a null venue entry is skipped on the board, never throws', () => {
  const tjson = bare({ venues: [null, { id: 'c1', name: 'Court 1' }], players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], matches: { t: [{ id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }] } });
  const data = pageData(tjson, 'bad');
  assert.doesNotThrow(() => renderVenue({ slug: 'bad', view: 'venues' }, data, clockAt(Date.parse('2026-05-02T10:00:00Z'))), 'the board renders around the absent entry');
});

test('renderers: a match on an undeclared venue renders absent on the board — never throws', () => {
  const tjson = bare({ venues: [{ id: 'c1', name: 'Court 1' }],
    players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' }],
    matches: { t: [
      { id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] },
      { id: 2, pool: 'A', scheduled: '2026-05-02T10:00:00', venue: 'ghost', sides: [{ kind: 'players', ids: ['p3'] }, { kind: 'players', ids: ['p4'] }] },
    ] } });
  const data = pageData(tjson, 'bad');
  const html = renderVenue({ slug: 'bad', view: 'venues' }, data, clockAt(Date.parse('2026-05-02T10:00:00Z')));
  assert(text(html).includes('Court 1'), 'the declared court still renders');
  assert(!text(html).includes('P3') && !text(html).includes('P4'), 'the ghost-venue match renders absent, never a throw');
});

test('renderers: a sideless match renders TBD rows, never throws', () => {
  const tjson = bare({ venues: [{ id: 'c1', name: 'Court 1' }],
    players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' }],
    matches: { t: [
      { id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] },
      { id: 2, pool: 'A', scheduled: '2026-05-02T10:00:00', venue: 'c1' },
    ] } });
  const data = pageData(tjson, 'bad');
  assert.doesNotThrow(() => renderTournament({ slug: 'bad', view: 'tournament' }, data), 'tournament page');
  assert.doesNotThrow(() => renderVenue({ slug: 'bad', view: 'venues' }, data, clockAt(Date.parse('2026-05-02T10:30:00Z'))), 'the board renders around the sideless match');
});

test('renderers: an invalid timezone renders TBD, never throws', () => {
  const bad = bare({ timezone: 'Mars/Olympus', venues: [{ id: 'c1', name: 'Court 1' }], players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], matches: { t: [{ id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }] } });
  const data = pageData(bad, 'bad');
  assert.doesNotThrow(() => renderTournament({ slug: 'bad', view: 'tournament' }, data), 'tournament page');
  const board = renderVenue({ slug: 'bad', view: 'venues' }, data, clockAt(Date.now()));
  assert(!board.includes('NaN'), 'venue board: an empty time axis renders plain TBD, never a NaN frame');
  assert.doesNotThrow(() => renderVenue({ slug: 'bad', view: 'venues' }, data, clockAt(Date.now())), 'venue board');
  assert.doesNotThrow(() => renderPlayer({ slug: 'bad', view: 'schedule', player: 'p1' }, data), 'player page');
});

test('renderers: every fixture renders every view — the never-throw contract, fixture-driven', () => {
  // The no-throw contract over the whole committed fixture set. The sweep found
  // a played result with no sides killing the venue recency line; hand-built
  // cases own output, this loop owns survival.
  const dirs = fs.readdirSync(FIX('')).filter(d => !d.startsWith('.'));
  const now = Date.parse('2026-05-02T10:00:00Z');
  for (const dir of dirs) {
    const repo = loadRepo(FIX(dir));
    const info = repo.tournaments.get(dir);
    if (!info || !info.tjson) continue; // no file to render (bad-null-tjson, index-only duplicates)
    const data = pageData(info.tjson, dir, repo.index);
    assert.doesNotThrow(() => renderTournament({ slug: dir, view: 'tournament' }, data), `${dir}: tournament view`);
    assert.doesNotThrow(() => renderVenue({ slug: dir, view: 'venues' }, data, clockAt(now)), `${dir}: venue view`);
    assert.doesNotThrow(() => renderPlayer({ slug: dir, view: 'schedule' }, data), `${dir}: player view`);
  }
});

test('pageTitle: the tournament tab names the event, the kiosk names its own board', () => {
  const data = repoPage('sample');
  assert.equal(pageTitle({ slug: 'sample', view: 'tournament' }, data), data.t.name, 'the tournament view titles the event');
  assert.notEqual(pageTitle({ slug: 'sample', view: 'venues' }, data), data.t.name, 'the venue view carries its own board label');
});

test('a rejected fragment route paints the bad-link page — a call, never the builder reference', () => {
  const app = { innerHTML: '' };
  paintBadRoute(app);
  // the old bug assigned the BAD_LINK reference: innerHTML was a function, the
  // page painted its source. This is the shipped recovery page's one contract.
  assert.equal(typeof app.innerHTML, 'string', 'the branch assigns rendered HTML, not a function');
  assert(app.innerHTML.includes('href="#"'), 'the page offers a route home — the shipped recovery link');
});

test('setPending: the busy token is spelled "true", and a settle removes it', () => {
  const el = { attrs: {}, setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; } };
  setPending(el, true);
  assert.equal(el.attrs['aria-busy'], 'true', 'the busy token is spelled "true" — a valueless attribute reads as false');
  setPending(el, false);
  assert.equal(el.attrs['aria-busy'], undefined, 'a settled load leaves no busy state behind');
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

// A stubbed fetch for one test — the real one comes back even on a throw.
const withFetch = async (stub, fn) => {
  const orig = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = orig; }
};

test('loadAll: a slug route fetches only the tournament file; the index view only the index', async () => {
  const calls = [];
  const stub = url => { // fetchJson passes { cache: 'no-cache' }; the stub ignores it
    calls.push(url);
    const body = {
      'tournaments.json': [{ slug: 'sample', name: 'Sample', dates: ['2025-07-14'] }],
      'tournaments/sample.json': require(FIX('sample', 'tournaments', 'sample.json')),
    }[url] ?? null;
    if (url === 'tournaments/flaky.json') return Promise.resolve({ ok: false, status: 503 });
    return body === null ? Promise.resolve({ ok: false, status: 404 }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  await withFetch(stub, async () => {
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
    const flaky = await loadAll({ slug: 'flaky', view: 'tournament' });
    assert.equal(flaky.httpError, undefined, 'a 5xx is transient — retryable, never a permanent stop');
    assert.equal(flaky.tjson, null, 'a 5xx returns no data, so the poll keeps trying next tick');
  });
});

test('loadAll: a failed index fetch reports failure, never an empty list', async () => {
  const stub = () => Promise.resolve({ ok: false, status: 503 });
  await withFetch(stub, async () => {
    const d = await loadAll({ view: 'index' });
    assert.equal(d.failed, true, 'a 5xx index is a reported failure, not "no tournaments yet"');
    assert.equal(d.index, null, 'no index data rides a failure');
  });
});

test('loadAll recovers from a rejected cache revalidation (Safari 304)', async () => {
  const modes = [];
  const stub = (url, opts) => {
    modes.push(opts.cache);
    // Safari over HTTP/2 rejects the fetch when the CDN answers the revalidation with 304
    if (opts.cache === 'no-cache') return Promise.reject(new TypeError('Load failed'));
    const body = require(FIX('sample', 'tournaments', 'sample.json'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  await withFetch(stub, async () => {
    const d = await loadAll({ slug: 'sample', view: 'tournament' });
    assert(d.tjson, 'data arrives despite the rejected revalidation — the bypassing fetch recovers');
    assert.deepEqual(modes, ['no-cache', 'no-store'], 'the rejected mode is retried once, within the same load');
  });
});

test('freshness: live inside a poll cycle, lagging behind it, reconnecting past the tolerance', () => {
  const now = 1e12;
  const tol = STALE_MS; // the value the code derives from FETCH_TIMEOUT_MS + 2 * POLL_MS
  assert.equal(freshness(0, now), 'reconnecting', 'no successful fetch yet — never pretends live');
  assert.equal(freshness(now - 5000, now), 'live', 'the last fetch succeeded seconds ago');
  assert.equal(freshness(now - LAG_MS, now), 'live', 'two poll cycles still count as live');
  assert.equal(freshness(now - LAG_MS - 1, now), 'lagging', 'a millisecond past the live window — behind, still trying');
  assert.equal(freshness(now - tol, now), 'lagging', 'the tolerance edge is not yet reconnecting');
  assert.equal(freshness(now - tol - 1, now), 'reconnecting', 'a millisecond past it — reconnecting');
});

test('changedTournament: the pulse fires only when the same tournament file changed', () => {
  const base = { slug: 'a', hash: 'h1' };
  assert.equal(changedTournament(null, 'a', 'h1'), false, 'the first load is a baseline, not a change');
  assert.equal(changedTournament(base, 'a', 'h1'), false, 'an unchanged poll stays quiet');
  assert.equal(changedTournament(base, 'a', 'h2'), true, 'a changed file pulses the dot');
  assert.equal(changedTournament(base, 'b', 'h2'), false, 'a different tournament is navigation, not a change');
});

test('a timed-out poll does not retry in the other cache mode', async () => {
  const modes = [];
  const real = AbortSignal.timeout;
  // a bound that has already fired: the fetch rejects and the signal reads aborted
  AbortSignal.timeout = () => { const c = new AbortController(); c.abort(); return c.signal; };
  const stub = (url, opts) => {
    modes.push(opts.cache);
    const e = new Error('aborted');
    e.name = 'AbortError';
    return Promise.reject(e);
  };
  try {
    await withFetch(stub, async () => {
      const d = await loadAll({ slug: 'sample', view: 'tournament' });
      assert.equal(d.tjson, null, 'a timed-out poll yields no data, so the snapshot stays up');
      assert.deepEqual(modes, ['no-cache'], 'a slow link is not the revalidation bug — one attempt, not two');
    });
  } finally { AbortSignal.timeout = real; }
});

test('timeoutSignal: the bound exists without AbortSignal.timeout too', async () => {
  const real = AbortSignal.timeout;
  AbortSignal.timeout = undefined; // old Safari: the native bound is missing
  try {
    const signal = timeoutSignal(10);
    assert.equal(signal.aborted, false, 'the bound has not fired yet');
    await new Promise(res => signal.addEventListener('abort', res, { once: true }));
    assert.equal(signal.aborted, true, 'the fallback timer aborts the load, so its slot always frees');
  } finally { AbortSignal.timeout = real; }
});

test('superseded: a same-slug hop still feeds the current route, a different slug drops it', () => {
  assert.equal(superseded(null, { slug: 'a' }), true, 'no route to land the response on');
  assert.equal(superseded({ slug: 'a' }, { slug: 'a' }), false, 'a category/view hop must not discard the poll');
  assert.equal(superseded({ view: 'index' }, { view: 'index' }), false, 'the index is never superseded by itself');
  assert.equal(superseded({ view: 'index' }, { slug: 'a' }), true, 'an index route never consumes a tournament response');
  assert.equal(superseded({ slug: 'a' }, { view: 'index' }), true, 'a tournament route never consumes an index response');
  assert.equal(superseded({ slug: 'b' }, { slug: 'a' }), true, 'a different tournament drops the in-flight response');
});

test('needsFetch: index refetches, a same-slug view hop renders cached, a new slug refetches', () => {
  const d = { t: { slug: 'sample', name: 'Sample' } };
  assert.equal(needsFetch({ view: 'index' }, d), true, 'the index always refetches');
  assert.equal(needsFetch({ slug: 'sample', view: 'schedule' }, d), false, 'same slug — a view hop renders the cached snapshot');
  assert.equal(needsFetch({ slug: 'other', view: 'tournament' }, d), true, 'a different slug refetches');
  assert.equal(needsFetch({ slug: 'sample', view: 'tournament' }, null), true, 'no snapshot yet — refetch');
});

test('pool A standings: 4 sides, order, leader record', () => {
  const md = catOf('sample', 'md40');
  const st = poolStandings(md, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1|p2' && st[1].sig === 'p3|p4' && st[3].sig === 'p7|p8', 'pool A order by wins alone');
  assert(st[0].wins === 3 && st[0].losses === 0, 'leader record');
  assert(st.every(r => !r.splitBy && !r.tie), 'no tie, so no rung placed a row');
});

test('standings tiebreak: wins, then head-to-head', () => {
  const ctx = catOf('tiebreak', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 beat p2 head-to-head');
  assert(st[0].wins === 2 && st[1].wins === 2, 'both on two wins');
  assert(st[0].splitBy === 'h2hWins' && st[1].splitBy === 'h2hWins' && st[0].h2h.w === 1, 'the h2h wins rung placed them');
  assert(!isDeadTie(st, 1) && !isDeadTie(st, 2), 'and it separated them');
});

test('h2h ladder: the mutual-match winner ranks first', () => {
  const ctx = catOf('h2h', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 won the p1-p2 match — same wins, p1 ranks first');
  assert(st[0].wins === 2 && st[1].wins === 2 && st[0].splitBy === 'h2hWins', 'placed by the head-to-head win');
  assert(st[2].sig === 'p3' && st[3].sig === 'p4', 'lower pair also splits by h2h');
  assert(!isDeadTie(st, 1) && !isDeadTie(st, 2), 'both resolved — no TBD');
  const slot = resolveSide(ctx.byId.get(13).sides[0], ctx);
  assert(slot && slot.has('p1'), 'rank-1 slot takes the h2h winner');
});

test('h2h ladder: a trio level on every rung is a dead tie', () => {
  const ctx = catOf('h2h', 't');
  const st = poolStandings(ctx, 'B');
  assert(st && st.length === 4, 'pool B has 4 sides');
  assert(st[0].sig === 'p5' && st[1].sig === 'p6' && st[2].sig === 'p7', 'dead-tie order is the pool order');
  assert(st.slice(0, 3).every(r => r.wins === 2 && r.tie && !r.splitBy), 'p5, p6 and p7 share a record no rung can split');
  assert.deepEqual(poolRanks(st), [1, 1, 1, 4], 'the trio shares rank 1');
  assert(isDeadTie(st, 1) && isDeadTie(st, 2), 'both slots stay TBD for the organizer');
  assert(resolveSide(ctx.byId.get(14).sides[0], ctx) === null, 'the rank-2 slot is unresolved');
});

test('h2h ladder: the rungs are ratios — a pair level on point difference still separates', () => {
  // A, B and C each win one match 2-0. B and C are level on head-to-head point difference
  // (−2 each) and only the ratio of points won to lost separates them (32/34 vs 30/32).
  // Difference rungs would fall through to the recursion, where C beat B.
  const ctx = catOf('h2hratio', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 3, 'three tied sides');
  assert.deepEqual(st.map(r => r.sig), ['p1', 'p2', 'p3'], 'the point ratio orders A, B, C');
  assert(st.every(r => r.splitBy === 'h2hPointRatio'), 'every row is placed by the head-to-head point ratio');
  assert(!isDeadTie(st, 2), 'B and C are separated, not a dead tie');
});

test('walkover: a win with no games drops out of the ratio rungs', () => {
  // p1, p2 and p3 each win one match. p1's win is a walkover, so it earns the head-to-head win
  // but no games: its game ratio is 0 won to 2 lost, so the ratio rung ranks it last. A
  // 3-0/11-0 walkover fiction would have put p1 first instead.
  const ctx = catOf('walkover-ratio', 't');
  const st = poolStandings(ctx, 'A');
  assert.deepEqual(st.map(r => r.sig), ['p2', 'p3', 'p1'], 'the played wins rank above the walkover win');
  assert(st.every(r => r.splitBy === 'h2hGameRatio'), 'the head-to-head game ratio placed all three');
  const walk = st.find(r => r.sig === 'p1');
  assert(walk.wins === 1 && walk.h2h.w === 1, 'the walkover counts as a win, head-to-head too');
  assert(walk.h2h.gw === 0 && walk.h2h.gl === 2, 'but it adds no games — only the played loss counts');
});

test('a declared tiebreak list replaces the ladder — one rung that cannot separate leaves a dead tie', () => {
  const tjson = JSON.parse(JSON.stringify(repoPage('h2hratio').tjson));
  tjson.categories[0].tiebreak = ['h2hWins'];
  const st = poolStandings(toCats(tjson)[0], 'A');
  assert.deepEqual(st.map(r => r.sig), ['p1', 'p2', 'p3'], 'the pool order stands');
  assert(st.every(r => r.tie && !r.splitBy), 'the declared rung alone cannot separate them — the point ratio is not applied on top');
});

test('pool table: a row placed by a head-to-head rung names that rung, and a broken list still renders', () => {
  const data = repoPage('h2hratio');
  const html = renderTournament({ slug: 'h2hratio', view: 'tournament' }, data);
  assert.deepEqual(vals(html, 'data-tiebreak'), ['h2hPointRatio', 'h2hPointRatio', 'h2hPointRatio'], 'each tied row carries the rung that placed it');
  const broken = JSON.parse(JSON.stringify(data.tjson));
  broken.categories[0].tiebreak = ['nonsense'];
  assert.doesNotThrow(() => renderTournament({ slug: 'h2hratio', view: 'tournament' }, withTjson(data, broken)), 'an unknown rung ranks nothing and never throws');
});

test('pointDiff: overall point difference places a wins-level trio', () => {
  const st = poolStandings(catOf('rungs', 'pd'), 'A');
  assert.deepEqual(st.map(r => r.sig), ['a1', 'a3', 'a2'], 'a1 +10, a3 +8, a2 −18');
  assert(st.every(r => r.splitBy === 'pointDiff' && !r.tie), 'the whole-pool point difference placed every row');
});

test('h2hPointDiff: the difference is measured over the tied teams only', () => {
  const st = poolStandings(catOf('rungs', 'hpd'), 'A');
  assert.deepEqual(st.map(r => r.sig), ['b1', 'b3', 'b2'], 'the same scores, read head-to-head');
  assert(st.every(r => r.splitBy === 'h2hPointDiff'), 'the head-to-head point difference placed every row');
});

test('pointsFor: total points is the last resort when the differences stay level', () => {
  const st = poolStandings(catOf('rungs', 'pf'), 'A');
  assert.deepEqual(st.map(r => r.sig), ['c3', 'c1', 'c2'], 'c3 40, c1 32, c2 22');
  assert(st.every(r => r.splitBy === 'pointsFor'), 'total points placed every row');
});

test('pointDiff stays pinned to the whole pool while a head-to-head rung re-measures the survivors', () => {
  const st = poolStandings(catOf('rungs', 'mix'), 'A');
  assert.deepEqual(st.map(r => r.sig), ['d2', 'd3', 'd1', 'd4'], 'd2/d3 tie on the whole-pool difference, so d1 drops out and d4 never reaches a rung');
  assert.deepEqual(st.slice(0, 2).map(r => r.splitBy), ['h2hPointDiff', 'h2hPointDiff'], 'the surviving pair is separated head-to-head, on their own match only');
  assert.equal(st[2].splitBy, 'pointDiff', 'd1 was placed on the whole-pool difference');
  assert.equal(st[2].splitVal, 2, 'd1 reads its whole-pool +2, not the mutual 0 that would leave the trio level');
  assert(st.every(r => !r.tie), 'the ladder separates every row — no dead tie');
});

test('pointDiff: a side-b win credits the points to the side that scored them', () => {
  const st = poolStandings(catOf('rungs', 'bside'), 'A');
  const by = Object.fromEntries(st.map(r => [r.sig, r]));
  assert.equal(by.e2.pf, 38, 'e2 scored 22 as side b in match 1 and 16 as side a in match 2');
  assert.equal(by.e2.pa, 30);
  assert.equal(by.e1.pf, 30, 'e1 scored 22 as side b in match 3');
  assert.equal(by.e1.pa, 40);
  assert.deepEqual(st.map(r => r.sig), ['e2', 'e3', 'e1'], 'the whole-pool difference ranks three side-b wins correctly');
  assert.deepEqual(st.map(r => r.splitBy), ['pointDiff', 'pointDiff', 'pointDiff'], 'every row is placed on the whole-pool difference');
});

test('pool table: each pool names its placing rung and carries an info overlay', () => {
  const data = repoPage('rungs');
  for (const [cat, rung] of [['pd', 'pointDiff'], ['hpd', 'h2hPointDiff'], ['pf', 'pointsFor']]) {
    const html = renderTournament({ slug: 'rungs', view: 'tournament', cat }, data);
    assert.deepEqual(vals(html, 'data-tiebreak'), [rung, rung, rung], `${cat} carries ${rung}`);
    for (const kind of ['played', 'won', 'tb']) {
      assert(html.includes(`<button type="button" data-info="${kind}"`), `${cat} carries the ${kind} info button`);
      assert(html.includes(`<dialog class="info" data-info="${kind}"`), `${cat} carries the ${kind} overlay`);
    }
  }
});

test('pool table: the tiebreak column stays put where the wins alone ranked the pool', () => {
  const html = renderTournament({ slug: 'ready', view: 'tournament' }, repoPage('ready'));
  assert.deepEqual(vals(html, 'data-tiebreak'), [], 'no row was placed by a rung or left level');
  assert(html.includes('data-info="tb"'), 'the column and its rules stay discoverable anyway');
});

test('pool table: only a wins-tie carries a tiebreak state — a wins-separated row stays blank', () => {
  const html = renderTournament({ slug: 'blocked-tie', view: 'tournament' }, repoPage('blocked-tie'));
  assert.deepEqual(vals(html, 'data-tiebreak'), ['level', 'level', 'level'], 'the three tied rows carry a state; the wins-separated row carries none');
});

test('pool table: a tie reads level only once the pool is sealed — a live tie and an unplayed pool show no tie state', () => {
  const live = renderTournament({ slug: 'multiday', view: 'tournament' }, repoPage('multiday'));
  assert(!vals(live, 'data-tiebreak').includes('level'), 'an unfinished pool claims no dead tie — its bracket slot is unclaimed too');
  const open = renderTournament({ slug: 'live-tie', view: 'tournament' }, repoPage('live-tie'));
  assert.deepEqual(vals(open, 'data-tiebreak'), ['h2hWins'], 'a live pool still names the rung that placed a row, but its open tie claims no level');
  const unplayed = renderTournament({ slug: 'tie', view: 'tournament' }, repoPage('tie'));
  assert(!vals(unplayed, 'data-tiebreak').includes('level'), 'a pool with no counted match claims no tie');
});

// The table test above reads a state hook, so it cannot tell an all-void pool from a sealed one on words
// or columns alone (per AGENTS, renderer tests are smoke only). The predicate the renderer gates on is
// domain behavior, so it is pinned here.
test('poolSealed: only a settled pool with counted play seals a tie', () => {
  const sealed = (name, cat) => poolSealed(catOf(name, cat), 'A');
  assert.equal(sealed('blocked-tie', 't'), true, 'every match settled and the play counted');
  assert.equal(sealed('multiday', 'md40'), false, 'a match is still to play');
  assert.equal(sealed('live-tie', 't'), false, 'a match is still to play even though a rung already placed a row');
  assert.equal(sealed('tie', 't'), false, 'fully settled but nothing counted — missing evidence, not a level pool');
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

test('slot resolution: a dead tie is labelled, not silently unresolved', () => {
  const ctx = catOf('blocked-tie', 't');
  const ko = ctx.byId.get(8);
  assert.equal(resolveSide(ko.sides[0], ctx), null, 'a dead-tie rank resolves to nothing');
  assert.match(sideLabel(ko.sides[0], ctx), /tie not broken/, 'the slot says why it is TBD — the gate no longer warns');
});

test('slot resolution: a pool nothing was played in names itself, but no tie', () => {
  const ctx = catOf('tie', 't'); // one pool match, void
  const ko = ctx.byId.get(3);
  assert.equal(resolveSide(ko.sides[0], ctx), null, 'an all-void pool resolves to nothing');
  const label = sideLabel(ko.sides[0], ctx);
  assert(!label.includes('tie not broken'), 'missing evidence is not a tie the ladder exhausted');
  assert.match(label, /Pool A/, 'the slot still names the pool it waits on');
});

test('playerStatus: a live pool names its rank without calling the tie final', () => {
  const live = catOf('live-tie', 't'); // pool A has play left
  const s = playerStatus(live, 'p2');
  assert.match(s, /2nd in Pool A/, 'the live rank still shows — b and c share it');
  assert(!s.includes('tie not broken'), 'a tie play can still break is not a dead one');
});

test('resolveSide: string ids on a players side is TBD, never a char-split team', () => {
  const ctx = makeCat({ meta: {}, matches: [
    { id: 1, sides: [{ kind: 'players', ids: 'p1' }, { kind: 'players', ids: ['p2'] }] },
  ] }, { timezone: 'UTC', players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] });
  assert.equal(resolveSide(ctx.byId.get(1).sides[0], ctx), null, 'a string ids would char-split in Set — must resolve to nothing instead');
  const ok = resolveSide(ctx.byId.get(1).sides[1], ctx);
  assert(ok && ok.has('p2'), 'an array ids beside it still resolves');
});

test('pool standings: a side with non-array ids is skipped, never crashes the ladder', () => {
  // rec() skips it, but the ladder re-reads every pool match — the guard must hold there too
  const ctx = catOf('bad-pool-ids-shape', 't');
  assert.doesNotThrow(() => poolStandings(ctx, 'A', true), 'the pool table survives a malformed sibling side');
  assert.doesNotThrow(() => playerStatus(ctx, 'p1'), 'the player line survives it too');
  assert.doesNotThrow(() => catStatus(ctx), 'category status survives it');
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

test('catStatus: pre-start zero progress, groups live, the KO wave in play, and the podium at full finish', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const mk = ms => makeCat({ meta: tjson.categories[0], matches: ms }, tjson);
  const base = catOf('sample', 'md40').matches;
  const pre = mk(base.map(m => ({ ...m, games: [], result: undefined })));
  assert(catStatus(pre).kind === 'groups' && catStatus(pre).played === 0 && catStatus(pre).count === 6, 'nothing played: zero progress on the opening stage — no separate start state');
  const mid = mk(base.map(m => m.id === 1 ? { ...m, result: undefined } : m));
  const g = catStatus(mid);
  assert(g.kind === 'groups' && g.played === 5 && g.count === 6, 'groups live: the progress count, no next-slot noise');
  const live = catOf('sample', 'md40');
  const k = catStatus(live);
  assert(k.kind === 'ko' && k.wave === 1 && roundName(k.wave) === 'Semifinals', 'the Semifinals are in play — a scheduled final/bronze stays silent while its semifinals still decide them');
  const full = catOf('full', 't');
  const w = catStatus(full);
  assert(w.kind === 'winners' && w.first.join() === 'p1' && w.second.join() === 'p5' && w.third.join() === 'p6', 'full finish: the podium off the played final and bronze');
  const xd = catOf('sample', 'xd');
  assert(catStatus(xd).kind === 'finished', 'pool-only finish: no final to name, plain Finished');
  const tied = catOf('tie', 't');
  const blocked = catStatus(tied);
  assert.deepEqual(blocked, { kind: 'blocked' }, 'a dead-tied pool rank blocks the bracket instead of claiming the final is in play');
  assert.deepEqual(currentWave(tied, blocked), [], 'a blocked bracket cannot expose a phantom next match');
  assert(text(renderTournament({ slug: 'tie', view: 'tournament' }, repoPage('tie'))).includes('blocked by unresolved slots'), 'the page explains why the knockout cannot advance');
});

test('catStatus: the wave is the earliest playable round, never a directly seeded later one', () => {
  // An open play-in round (col 3) beside a quarterfinal (col 2) already playable
  // from both sides being direct seeds — the front round owns the status.
  const ctx = catOf('playin', 't');
  const st = catStatus(ctx);
  assert(st.kind === 'ko' && st.wave === 3 && roundName(st.wave) === 'Round of 16', 'the open play-in round is the wave, not the directly seeded quarterfinal beside it');
});

test('catStatus: an open classification band outranks the deeper main round beside it', () => {
  // Main semis done, final live (col 0), one 5th–8th semi open (col 1): the
  // earliest unfinished band owns the status, so it reads Semifinals, not Final.
  const ctx = catOf('placewave', 't');
  const st = catStatus(ctx);
  assert(st.kind === 'ko' && st.wave === 1 && roundName(st.wave) === 'Semifinals', 'the open 5th–8th semi is the wave, not the final it runs beside');
});

test('roundName: a cycle-corrupted column names no round, never "Round of 0"', () => {
  assert.equal(roundName(-1), 'TBD', 'a negative depth is not a round to name');
  assert.equal(roundName(1), 'Semifinals', 'a valid depth still names its round');
});

// podium details: third exists only when a bronze match decided it; a void
// anywhere leaves no winner to name — the line falls back to Finished
const place8Ctx = tjson => makeCat({ meta: tjson.categories[0], matches: tjson.matches.t }, tjson);

test('placement bands: a non-array-sided match in the walk is skipped, never throws', () => {
  // A duplicate id lets the walk reach the malformed match; it must be skipped, not passed to .find
  const tjson = require(FIX('place8', 'tournaments', 'place8.json'));
  const t = JSON.parse(JSON.stringify(tjson));
  t.matches.t.unshift({ id: 21, sides: 'oops' }); // non-array first — byId still maps 21 to the real placement match
  const ctx = makeCat({ meta: t.categories[0], matches: t.matches.t }, t);
  assert.doesNotThrow(() => placementColumn(ctx.byId.get(20), ctx), 'the band walk survives a non-array-sided sibling');
});

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

test('playerStatus: the podium lands the moment the final is played, not when the category wraps', () => {
  const tjson = JSON.parse(JSON.stringify(require(FIX('place8', 'tournaments', 'place8.json'))));
  tjson.matches.t.find(m => m.id === 20).result = undefined; // bronze still to play
  const ctx = place8Ctx(tjson);
  assert(playerStatus(ctx, 'p1') === 'Champion', 'the final winner is already champion with a bronze pending');
  assert(playerStatus(ctx, 'p2') === 'Runner-up', 'the final loser is runner-up, not eliminated');
  assert(playerStatus(ctx, 'p5') === 'In placement — 3rd–4th', 'a bronze-pending player stays in placement, with the band at stake');
});

test('playerStatus: the finish is what the player got — pool standing, place or band', () => {
  // out in groups: the final pool standing, pool-scoped (pools are never ranked against each other)
  const full = catOf('full', 't');
  assert(playerStatus(full, 'p3') === 'Out in groups — 3rd in Pool A', 'a group-stage exit reports its final pool place');
  // live pool rank once one pool match is decided, while only group matches remain
  const live = JSON.parse(JSON.stringify(require(FIX('full', 'tournaments', 'full.json'))));
  live.matches.t.forEach(m => { if (m.id !== 1 && m.id !== 2) m.result = undefined; });
  const mid = makeCat({ meta: live.categories[0], matches: live.matches.t }, live);
  assert(playerStatus(mid, 'p1') === 'In groups — 1st in Pool A', 'a live pool ranks a player after the first decided match');
  // placement decider: the match settles an exact place, so the place is the finish
  const p8 = catOf('place8', 't');
  assert(playerStatus(p8, 'p3') === '7th', 'the winner of a 7-8 decider is exactly 7th');
  assert(playerStatus(p8, 'p4') === '6th', 'the loser of a 5th-place decider is exactly 6th');
  // no placement tree: the elimination round fixes the band; a bye'd round clamps its top
  const P = (...ids) => ({ kind: 'players', ids });
  const win = m => ({ kind: 'match', match: m, result: 'winner' });
  const r = { status: 'played', winner: 'a' };
  const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(id => ({ id, name: id }));
  const pure = makeCat({ meta: {}, matches: [
    { id: 1, sides: [P('p1'), P('p2')], result: r },
    { id: 2, sides: [P('p3'), P('p4')], result: r },
    { id: 3, sides: [P('p5'), P('p6')], result: r },
    { id: 4, sides: [P('p7'), P('p8')], result: r },
    { id: 5, sides: [win(1), win(2)], result: r },
    { id: 6, sides: [win(3), win(4)], result: r },
    { id: 7, sides: [win(5), win(6)], result: r },
  ] }, { timezone: 'UTC', players });
  assert(playerStatus(pure, 'p2') === '5th–8th', 'a pure bracket bands QF losers 5th–8th');
  const six = makeCat({ meta: {}, matches: [
    { id: 1, sides: [P('p3'), P('p4')], result: r },
    { id: 2, sides: [P('p5'), P('p6')], result: r },
    { id: 3, sides: [P('p1'), win(1)], result: r },
    { id: 4, sides: [P('p2'), win(2)], result: r },
    { id: 5, sides: [win(3), win(4)], result: r },
  ] }, { timezone: 'UTC', players: players.slice(0, 6) });
  assert(playerStatus(six, 'p4') === '5th–6th', 'byes clamp the band top — a 6-player bracket has no 7th');
});

test('playerStatus: a capped classification band is the finish for both semi results', () => {
  // placementRounds: 1 — the band plays its semis only, so a won semi earns no
  // finer place: every team in the band finishes 5th–8th, the round never named.
  const capped = catOf('capped', 't');
  assert(playerStatus(capped, 'p7') === '5th–8th', 'a won 5-8 semi finishes 5th–8th, not eliminated earlier');
  assert(playerStatus(capped, 'p6') === '5th–8th', 'a lost 5-8 semi finishes the same band — no decider separates it');
});

test('playerStatus: a dead pool tie is a pending entry, not a group exit', () => {
  // 4-team pool, p4 3-0 and p1/p2/p3 a 1-2 cycle with equal differentials — the
  // ladder calls 2nd–4th a dead tie, so no knockout slot resolves for them. They
  // are not out: their seats are still owned by the tie.
  const ctx = catOf('blocked-tie', 't');
  assert(playerStatus(ctx, 'p4') === 'In the Semifinals', 'the decided pool winner keeps its resolved slot');
  for (const p of ['p1', 'p2', 'p3']) {
    const s = playerStatus(ctx, p);
    assert(!s.includes('Out in groups'), `${p} is not eliminated while its knockout seat is unresolved`);
    assert(s.includes('tie not broken'), `${p} names the unresolved tie`);
  }
});

test('playerStatus: a settled knockout row keeps a player out, never pending', () => {
  // A void semi seats nobody but still owns p4's row: the final and bronze it
  // opens are reachable, not p4's. Reading reachable rounds as a seat would
  // call a settled exit a pending entry.
  const tjson = require(FIX('blocked-tie', 'tournaments', 'blocked-tie.json'));
  const matches = catOf('blocked-tie', 't').matches.map(m => m.id === 7 ? { ...m, result: { status: 'void' } } : m);
  const ctx = makeCat({ meta: tjson.categories[0], matches }, tjson);
  assert(playerStatus(ctx, 'p4') === 'Out in groups — 1st in Pool A', 'the voided semi owns the row, so p4 is out, not a pending entry');
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

test('result statuses: walkover counts a win, void counts nothing, pool completes', () => {
  const res = catOf('result', 't');
  const st = poolStandings(res, 'A');
  assert(st && st.length === 3, 'a void match does not stall the pool');
  const rec = sig => st.find(r => r.sig === sig);
  assert(rec('p1').wins === 1 && rec('p1').losses === 0, 'played win counts');
  assert(rec('p3').wins === 1 && rec('p3').losses === 0, 'walkover win counts');
  assert(rec('p2').wins === 0 && rec('p2').losses === 2, 'walkover loss counts, void contributes nothing to either side');
  assert(st[0].sig === 'p1' && st[1].sig === 'p3', 'the pool order');
  assert(isDeadTie(st, 1), 'p1 and p3 are level — their own match was void, so no rung has a number to split them on');
  assert.deepEqual(poolRanks(st), [1, 1, 3], 'they share rank 1');
  assert(winnerIdx(res.byId.get(3)) === null && isDone(res.byId.get(3)), 'void: settled, no winner');
  const f = res.byId.get(4);
  assert(resolveSide(f.sides[0], res) === null && resolveSide(f.sides[1], res) === null, 'a dead tie leaves its pool-rank slots TBD');
});

test('result statuses render: W/O and void on cards, settled matches stay on the board', () => {
  const data = repoPage('result');
  const st = renderTournament({ slug: 'result', view: 'tournament' }, data);
  assert(st.includes('data-win'), 'the winning side rows a data-win marker');
  const venue = renderVenue({ slug: 'result', view: 'venues' }, data, clockAt(Date.parse('2026-05-02T09:30:00Z')));
  assert(vals(venue, 'data-status').includes('done'), 'settled matches — played, walkover, void — all stay on the full-day board');
  assert(vals(venue, 'data-status').includes('upcoming'), 'the open 11:00 final is still upcoming at 09:30');
  assert(!vals(venue, 'data-status').includes('next'), 'a blocked front — a dead-tied pool rank leaves the final unplayable — lights no card');
});

test('category chip: the category name rides a per-category slot on the board and the schedule, escaped', () => {
  const data = repoPage('sample');
  const venue = renderVenue({ slug: 'sample', view: 'venues' }, data, clockAt(Date.parse('2025-07-14T10:00:00Z')));
  assert.deepEqual([...new Set(vals(venue, 'data-cat'))].sort(), ['1', '2'], 'both categories ride the venue board, each on its own slot');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  assert.equal(new Set(vals(ppage, 'data-cat')).size, 2, 'the player schedule carries both categories too');
  const tour = renderTournament({ slug: 'sample', view: 'tournament' }, data);
  assert.deepEqual([...new Set(vals(tour, 'data-cat'))].sort(), ['1', '2'], 'the category tabs wear each category slot too');
  const evil = JSON.parse(JSON.stringify(data.tjson));
  evil.categories[0].name = '<b>C</b>';
  const out = renderVenue({ slug: 'sample', view: 'venues' }, withTjson(data, evil), clockAt(Date.parse('2025-07-14T10:00:00Z')));
  assert(!out.includes('<b>C</b>') && out.includes('&lt;b&gt;C&lt;/b&gt;'), 'the chip name is escaped, never HTML');
});

test('kiosk calendar: cards sit by wall-clock top — a slot only on a late venue never drops below earlier times', () => {
  // The old row-union ordered rows by per-venue insertion, so a 12:00 match on
  // the second court only landed after the whole afternoon. The calendar has
  // no row order to misalign: position is wall-clock, so 12:00 must fall
  // between 11:30 and 14:00 no matter which venue carries it.
  const tjson = bare({
    name: 'Cal',
    venues: [{ id: 'c1', name: 'Court 1' }, { id: 'c2', name: 'Court 2' }],
    players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' }, { id: 'p5', name: 'P5' }, { id: 'p6', name: 'P6' }],
    matches: { t: [
      { id: 1, pool: 'A', scheduled: '2026-05-02T11:30:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] },
      { id: 2, pool: 'A', scheduled: '2026-05-02T12:00:00', venue: 'c2', sides: [{ kind: 'players', ids: ['p3'] }, { kind: 'players', ids: ['p4'] }] },
      { id: 3, pool: 'A', scheduled: '2026-05-02T14:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p5'] }, { kind: 'players', ids: ['p6'] }] },
    ] },
  });
  const html = renderVenue({ slug: 'cal', view: 'venues' }, pageData(tjson, 'cal'), clockAt(Date.parse('2026-05-02T12:05:00Z')));
  const topOf = {};
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)[^>]*style="top:([\d.]+)px[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const time = /<time[^>]*>([^<]*)<\/time>/.exec(m[3]);
    if (time) topOf[time[1]] = +m[2];
  }
  assert(topOf['11:30'] < topOf['12:00'] && topOf['12:00'] < topOf['14:00'], 'the 12:00 card sits between 11:30 and 14:00 — placement is wall-clock, not venue order');
  // the grid classes, hour ruler, and now-line offsets that carry the order are
  // layout — review surface; the position contract is the wall-clock order above
});

test('kiosk: classification cards are flagged off the title road — pool and main bracket are not', () => {
  // Off the road means the match settles a lower rank (bronze, placement bands); the pool
  // stage is the first leg of the road, so it never flags.
  const data = repoPage('place8');
  const html = renderVenue({ slug: 'place8', view: 'venues' }, data, clockAt(Date.parse('2026-06-01T11:30:00Z')));
  const ctx = data.cats[0];
  const flagged = vals(html, 'data-road');
  const onRoad = ctx.matches.filter(m => m.pool !== undefined || plRange(m, ctx) === null).length;
  assert(flagged.every(v => v === 'off'), 'the flag carries its one value');
  // every card is one chip; the flag must land on exactly the classification tree
  assert.equal(vals(html, 'data-cat').length - flagged.length, onRoad, 'the flag marks the classification cards only');
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
  assert(st && st.length === 2 && st[0].wins === st[1].wins && st[0].tie && st[0].tie === st[1].tie, 'tie detected in standings');
  assert(resolveSide(tie.byId.get(3).sides[0], tie) === null, 'dead-tied pool slot -> TBD');
});

test('3-way dead tie: standings tie + pool slot TBD', () => {
  const tie3 = catOf('tie3', 't');
  const st = poolStandings(tie3, 'A');
  assert(st && st.length === 3 && st.every(r => r.wins === st[0].wins && r.tie === st[0].tie), '3-way tie detected');
  assert(resolveSide(tie3.byId.get(4).sides[0], tie3) === null, '3-way dead-tied pool slot -> TBD');
});

test('poolRanks: dead-tie members share their group rank, resolved rows have their own', () => {
  assert.deepEqual(poolRanks(poolStandings(catOf('tie', 't'), 'A')), [1, 1], '2-way dead tie shares rank 1');
  assert.deepEqual(poolRanks(poolStandings(catOf('tie3', 't'), 'A')), [1, 1, 1], '3-way dead tie: all rank 1');
  const adj = poolStandings(catOf('adjtie', 't'), 'A');
  assert.deepEqual(adj.map(r => [r.wins, r.tie]), [[2, 1], [2, 1], [0, 2], [0, 2]], 'two adjacent dead-tie clusters, each with its own id');
  assert.deepEqual(poolRanks(adj), [1, 1, 3, 3], 'adjacent clusters keep separate ranks — 1 1 3 3, not 1 1 1 1');
  assert.deepEqual(poolRanks(poolStandings(catOf('sample', 'md40'), 'A')), [1, 2, 3, 4], 'resolved ladder: sequential ranks');
  const h2h = poolStandings(catOf('h2hratio', 't'), 'A'); // resolved by the point ratio
  assert.deepEqual(poolRanks(h2h), [1, 2, 3], 'head-to-head separations are resolved rows, each its own rank');
  assert.deepEqual(poolRanks(poolStandings(catOf('h2h', 't'), 'B')), [1, 1, 1, 4], 'a trio level on every rung dead-ties');
});

test('koOrdinal: bracket ordinals are structural — schedule edits cannot renumber them', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample.json'));
  const raw = catOf('sample', 'md40').matches.map(m => ({ ...m }));
  const t7 = raw.find(m => m.id === 7).scheduled, t8 = raw.find(m => m.id === 8).scheduled;
  raw.find(m => m.id === 7).scheduled = t8; // swap the two SFs on the clock
  raw.find(m => m.id === 8).scheduled = t7;
  const md = makeCat({ meta: tjson.categories[0], matches: raw }, tjson);
  assert(matchLabel(md.byId.get(7), md) === 'SF-1' && matchLabel(md.byId.get(8), md) === 'SF-2', 'labels read who feeds the final, not the clock');
  // the final's open slot keeps its reference label; the decided feeder's side
  // resolves to a team, so only the open one renders the slot form
  assert(sideLabel(md.byId.get(9).sides[1], md) === 'Winner of SF-2', 'the open feeder ref holds under schedule edits');
});

test('matchLabel: every knockout round carries its bracket ordinal — R16-N, QF-N, SF-N', () => {
  // A 16-team field is a real Round of 16 — the depth the sample fixture never reaches;
  // the generator builds it through the same derive the site renders.
  const spec = {
    slug: 'lab', name: 'Label Open', location: 'Z', timezone: 'Europe/Zurich', date: '2026-05-02', poolSize: 6,
    blocks: { t: '09:00' },
    venues: { c1: 'C1', c2: 'C2', c3: 'C3', c4: 'C4', c5: 'C5', c6: 'C6' },
    players: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['p' + i, 'P' + i])),
    categories: [{ id: 't', name: 'T', bestOf: 1, slotMinutes: 30, tiebreak: ['h2hWins', 'h2hGameRatio', 'h2hPointRatio'] }],
    teams: { t: Array.from({ length: 16 }, (_, i) => ['p' + i]) },
  };
  const tourney = generate(spec);
  const ms = tourney.matches.t;
  const ctx = makeCat({ meta: tourney.categories[0], matches: ms }, tourney);
  const round1 = ms.filter(m => m.pool === undefined && koColumn(m, ctx) === 3);
  assert.equal(round1.length, 8, 'a 16-team field plays eight first-round matches');
  assert(round1.every(m => /^R16-\d+$/.test(matchLabel(m, ctx))), 'first round reads R16-N, never the unnumbered "Round of 16"');
  assert.equal(new Set(round1.map(m => matchLabel(m, ctx))).size, 8, 'each R16 match carries its own ordinal');
  const qf = ms.find(m => m.pool === undefined && koColumn(m, ctx) === 2);
  const sf = ms.find(m => m.pool === undefined && koColumn(m, ctx) === 1);
  assert(/^QF-\d+$/.test(matchLabel(qf, ctx)) && /^SF-\d+$/.test(matchLabel(sf, ctx)), 'quarterfinals and semifinals read QF-N / SF-N');
  // an open slot referencing a round-1 match names a visible card, without the
  // article ("Winner of the Round of 16" would be the old broken form)
  assert(/^Winner of R16-\d+$/.test(sideLabel(qf.sides.find(s => s.kind === 'match'), ctx)), 'a QF slot names its feeder as "Winner of R16-N"');
  assert(matchLabel(ms[0], ctx).includes('Pool'), 'a pool match still reads Pool N');
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
  // the semis are cards you can name (the deciders' slots point at them), not two
  // identical "5th–8th semi" labels
  assert(matchLabel(p8.byId.get(21), p8) === '5-8 SF-1' && matchLabel(p8.byId.get(22), p8) === '5-8 SF-2', 'classification semis read as numbered band cards');
});

test('an entered-but-unresolved band keeps its semis terminal and distinct', () => {
  // place8 with its deciders (23 5th, 24 7th) dropped: the band is entered, not resolved.
  const tjson = JSON.parse(JSON.stringify(require(FIX('place8', 'tournaments', 'place8.json'))));
  tjson.matches.t = tjson.matches.t.filter(m => m.id !== 23 && m.id !== 24);
  const pp = makeCat({ meta: tjson.categories[0], matches: tjson.matches.t }, tjson);
  const semis = pp.matches.filter(m => placementLabel(m, pp) === '5th–8th semi');
  assert.equal(semis.length, 2, 'two classification semis, no 5th/7th deciders');
  assert.deepEqual(semis.map(m => matchLabel(m, pp)).sort(), ['5-8 SF-1', '5-8 SF-2'], 'each semi names a distinct card');
  assert.ok(semis.every(m => !plRange(m, pp).win), 'a terminal band entry still reads as a semi, not a place');
  const ids = new Set(semis.map(m => m.id));
  for (const m of pp.matches) for (const s of m.sides) {
    assert.ok(!(s.kind === 'match' && ids.has(s.match)), 'nothing consumes a classification semi — the band is entered, not resolved');
  }
});

test('classification deciders name their feeder semis as cards', () => {
  const players = {};
  const teams = [];
  for (let i = 1; i <= 8; i++) { players['p' + i] = 'P' + i; teams.push(['p' + i]); }
  const spec = {
    slug: 'lab', name: 'Label Open', location: 'Z', timezone: 'Europe/Zurich', date: '2026-05-02', poolSize: 4,
    blocks: { t: '09:00' },
    venues: { c1: 'C1', c2: 'C2', c3: 'C3', c4: 'C4' },
    players,
    categories: [{ id: 't', name: 'T', bestOf: 1, slotMinutes: 30, placements: 8, tiebreak: ['h2hWins', 'h2hGameRatio', 'h2hPointRatio'] }],
    teams: { t: teams },
  };
  const tourney = generate(spec);
  const ctx = makeCat({ meta: tourney.categories[0], matches: tourney.matches.t }, tourney);
  const decider = tourney.matches.t.find(m => placementLabel(m, ctx) === '5th place');
  assert.deepEqual(decider.sides.map(s => sideLabel(s, ctx)), ['Winner of 5-8 SF-1', 'Winner of 5-8 SF-2'], 'an open decider slot names a visible card');
});

test('plOrdinal: nested bands number their cards independently', () => {
  // A band of 8 (9-16) and its sub-band (9-12) share lo — keying the ordinal by
  // lo alone numbered the 9-16 entries 3-6 instead of 1-4.
  const players = {};
  const teams = [];
  for (let i = 1; i <= 16; i++) { players['p' + i] = 'P' + i; teams.push(['p' + i]); }
  const spec = {
    slug: 'lab', name: 'Label Open', location: 'Z', timezone: 'Europe/Zurich', date: '2026-05-02', poolSize: 8,
    blocks: { t: '09:00' },
    venues: { c1: 'C1', c2: 'C2' },
    players,
    categories: [{ id: 't', name: 'T', bestOf: 1, slotMinutes: 30, placements: 16, tiebreak: ['h2hWins', 'h2hGameRatio', 'h2hPointRatio'] }],
    teams: { t: teams },
  };
  const tourney = generate(spec);
  const ctx = makeCat({ meta: tourney.categories[0], matches: tourney.matches.t }, tourney);
  const codes = tourney.matches.t.map(m => matchLabel(m, ctx)).filter(l => l.startsWith('9-16 QF-')).sort();
  assert.deepEqual(codes, ['9-16 QF-1', '9-16 QF-2', '9-16 QF-3', '9-16 QF-4'], 'the 9-16 band numbers 1-4, never 3-6');
});

test('the next card is one card: a second category sharing the match id must not double-flag', () => {
  // Match ids are per-category — Ada's first undone xd match is given the md40
  // final's id (9); the old id-only comparison flagged both cards as next.
  const tjson = JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const xd = tjson.matches.xd.find(m => m.sides[0].ids.includes('p1'));
  xd.id = 9;
  delete xd.result;
  delete xd.games;
  const data = pageData(tjson, 'sample');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  assert.equal(cards(ppage, 'id', 'next').length, 1, 'exactly one next card despite a shared id');
  // the header line carries its own next flag — one more flagged element is the card
  assert.equal(vals(ppage, 'data-status').filter(s => s === 'next').length, 2, 'exactly one next card flag (the header line carries its own data-status)');
});

test('renderers: escapes, a11y state, and behavioral hooks — the shipped surface, not its copy', () => {
  const data = repoPage('sample');
  const clone = () => JSON.parse(JSON.stringify(data.tjson));
  const standings = renderTournament({ slug: 'sample', view: 'tournament' }, data);
  const evil = clone();
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  const evilPool = clone();
  evilPool.matches.md40[0].pool = 'A" onclick="alert(1)';
  const ph = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, withTjson(data, evilPool));
  assert(!ph.includes('Pool A" onclick='), 'the injected handler never lands in the DOM');
  assert(ph.includes('A&quot; onclick=&quot;alert(1)'), 'the pool string renders entity-encoded');
  const evilVenue = clone();
  evilVenue.venues.find(v => v.id === 'court-2').name = '<b>Court 2</b>';
  const evh = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, withTjson(data, evilVenue));
  assert(!evh.includes('<b>Court 2</b>') && evh.includes('&lt;b&gt;Court 2&lt;/b&gt;'), 'the venue name renders entity-encoded');
  assert(standings.includes('aria-hidden="true"'), 'unplayed best-of slots are placeholders, hidden from screen readers');
  assert.doesNotThrow(() => renderTournament({ slug: 'sample', view: 'tournament', cat: 'xd' }, data), 'the ?cat= view renders');
  assert(!standings.includes('<a href="#m-'), 'slot labels are plain text, not anchors');
  assert(!standings.includes('data-feeders') && !standings.includes('data-stage') && !standings.includes('toggle') && !standings.includes('id="m-'), 'no trace or disclosure machinery ships');
  for (const j of vals(standings, 'data-jump')) assert(card(standings, 'id', j) !== undefined, `every jump link has its target section (${j})`);
  assert.equal(vals(standings, 'data-status').filter(s => s === 'next').length, 2, 'ko in play: the Next line and the one unscored semifinal card carry the accent');
  assert(cards(standings, 'data-status', 'next').some(c => c.includes('SF-2')), 'the highlighted card is the unresolved semifinal');
  const midJson = clone();
  midJson.matches.md40[0].result = undefined;
  const mid = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, withTjson(data, midJson));
  assert(vals(mid, 'data-jump').includes('group-matches'), 'running groups: the Next line links the group matches');
  assert.equal(vals(mid, 'data-status').filter(s => s === 'next').length, 2, 'groups in play: the Next line and the one unscored group match carry the accent');
  const preJson = clone();
  for (const ms of Object.values(preJson.matches)) for (const m of ms) { delete m.result; delete m.games; }
  const pre = renderTournament({ slug: 'sample', view: 'tournament' }, withTjson(data, preJson));
  assert(!text(pre).includes('1 Ada Lovelace'), 'roster renders before any result, no phantom rank 1s');
  const sLink = links(pre).find(l => l.jump === 'group-matches');
  assert(sLink && sLink.href === '#sample', 'the pre-start line says Next, like every other stage — a link to the opening block');
  assert(vals(pre, 'data-status').includes('next'), 'pre-start: the opening block is lit — playable before the first result');
  const schedSeg = links(standings).find(l => l.text === 'Schedule');
  const current = cards(standings, 'aria-current', 'page');
  assert(current.includes('Tournament') && schedSeg.href === '#sample/schedule' && !schedSeg.current, 'tournament page: Tournament current, Schedule links');
  assert(current.includes("Men's Doubles 40+"), 'the current category is marked current; the first is the default');
  const xdLink = links(standings).find(l => l.text === 'Mixed Doubles');
  assert(xdLink.href === '#sample?cat=xd' && !xdLink.current, 'the other category links with ?cat=');
  const mdLink = links(renderTournament({ slug: 'sample', view: 'tournament', cat: 'xd' }, data)).find(l => l.text === "Men's Doubles 40+");
  assert(mdLink.href === '#sample' && !mdLink.current, 'the first category stays canonical at the bare slug');
  const ppage = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1' }, data);
  const tourSeg = links(ppage).find(l => l.text === 'Tournament');
  assert(tourSeg.href === '#sample?player=p1' && !tourSeg.current && cards(ppage, 'aria-current', 'page').includes('Schedule'), 'player page: Schedule current, pick preserved in the Tournament link');
  const nextLink = links(ppage).find(l => l.jump === 'next');
  assert(nextLink && nextLink.href === '#sample/schedule?player=p1', 'the body after "Next:" links to the next card');
  assert(vals(ppage, 'data-status').includes('next'), 'the next line is flagged as next');
  assert(text(ppage).includes('Ada Lovelace') && text(ppage).includes('Court 1'), 'player card finds the player, names the court');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule' }, data);
  const picks = links(picker).filter(l => /\/schedule\?player=/.test(l.href));
  const names = picks.map(l => l.label);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'the picker lists players alphabetically');
  assert.equal(new Set(names).size, 8, 'the fixture\'s eight players each appear once — a two-category player is not duplicated');
  assert(picks.every(l => /Men's Doubles 40\+/.test(l.text) && /Mixed Doubles/.test(l.text)), 'each card names every category the player plays in');
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
  const boards = links(idx).filter(l => l.href === '#sample/venues');
  assert(boards.length === 1 && boards[0].label, 'venue board appears once per tournament, named for screen readers');
});

test('possible stages render as cards: a status flag per stage, and the next header goes conditional', () => {
  const repo = loadRepo(FIX('byes'));
  const info = repo.tournaments.get('byes');
  const data = pageData(info.tjson, 'byes', repo.index);
  const page = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p4' }, data);
  const poss = cards(page, 'data-status', 'possible');
  assert.equal(poss.length, 3, 'p4 (pool open): three possible stages — QF, SF, and the merged final/bronze');
  // next points at the earliest possible stage when no confirmed match is left
  const tjson = JSON.parse(JSON.stringify(info.tjson));
  for (const id of [1, 4, 7, 10, 13]) tjson.matches.t.find(m => m.id === id).result = { status: 'walkover', winner: 'a' };
  const page2 = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p1' }, withTjson(data, tjson));
  assert(vals(page2, 'data-status').includes('next'), 'the next header line is flagged as next');
  assert(vals(page2, 'datetime').includes('2026-07-12T10:30:00.000Z'), 'the next line carries the instant in a semantic time element');
  assert(card(page2, 'id', 'next').includes('Quarterfinals'), 'the earliest possible card is the jump target, never carrying the confirmed accent');
  assert.equal(vals(page2, 'data-status').filter(s => s === 'next').length, 1, 'only the header line carries the green accent — possible cards never do');
});

test('staggered rounds: a stage lists every possible time and takes its earliest slot', () => {
  const stages = possibleStages(catOf('stagger', 't'), 'p4');
  const qf = stages.find(s => s.label === 'Quarterfinals');
  assert.deepEqual(qf.times, [Date.parse('2026-07-12T10:20:00Z'), Date.parse('2026-07-12T10:30:00Z')], 'the round carries every distinct start, ascending');
  assert.deepEqual(qf.courts, [], 'a mixed court renders TBD, not a list');
  const pair = stages.find(s => s.label.includes('/'));
  assert.deepEqual(pair.times, [Date.parse('2026-07-12T11:30:00Z'), Date.parse('2026-07-12T11:40:00Z')], 'a merged twin stage keeps its times — the merge sees raw arrays, deduped once at output');
  const page = renderPlayer({ slug: 'stagger', view: 'schedule', player: 'p4' }, repoPage('stagger'));
  assert(!text(page).includes('Time TBD'), 'every possible stage has a start — nothing falls under Time TBD');
  assert(vals(page, 'datetime').includes('2026-07-12T10:20:00.000Z') && vals(page, 'datetime').includes('2026-07-12T10:30:00.000Z'), 'both possible QF instants render as semantic times');
  const qfCard = cards(page, 'data-status', 'possible').find(c => c.includes('Quarterfinals'));
  assert(qfCard.indexOf('10:20') < qfCard.indexOf('10:30') && qfCard.includes('TBD'), 'the QF card lists its times ascending; the mixed court reads TBD');
  const flat = text(page);
  assert(flat.indexOf('P4 · P5') < flat.indexOf('Quarterfinals') && flat.indexOf('Quarterfinals') < flat.indexOf('Semifinals'), 'the card sorts by its earliest start — after the last group match, before the SF');
});

test('multi-day kiosk: one day at a time, previewing day one early, falling back to the last day', () => {
  const repo = loadRepo(FIX('multiday'));
  const info = repo.tournaments.get('multiday');
  const data = pageData(info.tjson, 'multiday', repo.index);
  const page = renderTournament({ slug: 'multiday', view: 'tournament' }, data);
  assert(vals(page, 'data-jump').includes('group-matches'), 'the Next line links the running group stage');
  // moving a match to another day just re-dates its card — no divider machinery
  const split = JSON.parse(JSON.stringify(info.tjson));
  split.matches.md40[5].scheduled = '2026-07-12T15:00:00'; // m6 (pool) -> Sunday
  const spage = renderTournament({ slug: 'multiday', view: 'tournament' }, pageData(split, 'multiday', repo.index));
  assert(vals(spage, 'datetime').includes('2026-07-12T19:00:00.000Z'), 'a rescheduled pool match carries its new day on the card');
  // kiosk: strict same-day in the tournament timezone, from the device clock instant
  const at = iso => Date.parse(iso);
  const sat = renderVenue({ slug: 'multiday', view: 'venues' }, data, clockAt(at('2026-07-11T12:00:00-04:00')));
  assert(text(sat).includes('Katherine Johnson') && !text(sat).includes('SF') && !text(sat).includes('Final'), 'saturday board: open pool match, no tomorrow');
  const sun = renderVenue({ slug: 'multiday', view: 'venues' }, data, clockAt(at('2026-07-12T08:00:00-04:00')));
  assert(text(sun).includes('SF') && text(sun).includes('Final') && !text(sun).includes('Katherine Johnson'), 'sunday board: knockout only, yesterday gone');
  const mon = renderVenue({ slug: 'multiday', view: 'venues' }, data, clockAt(at('2026-07-13T12:00:00-04:00')));
  assert(text(mon).includes('SF') && text(mon).includes('Final') && !text(mon).includes('Katherine Johnson'), 'after the last day: the board falls back to the last day (Sunday knockout), not a stale today');
  const fri = renderVenue({ slug: 'multiday', view: 'venues' }, data, clockAt(at('2026-07-10T12:00:00-04:00')));
  assert(text(fri).includes('Katherine Johnson') && !text(fri).includes('SF') && !text(fri).includes('Final'), 'a day before day one: the board previews the first day, pools only');
  // the follow is the earliest playable wave, not the clock: the board stamps its target
  // (shown day + wave start minute) and only a new result that moves it re-aims
  assert(vals(sat, 'data-aim').length > 0 && vals(sat, 'data-aim').every(m => m === '660'), 'every aim hook sits at the earliest wave minute');
  assert.equal(cards(sat, 'data-status', 'next').length, 1, 'the open pool match is the one accented card');
  assert(!vals(sat, 'data-status').some(s => s === 'now' || s === 'overdue'), 'the kiosk carries no clock statuses');
  assert(vals(sat, 'data-status').includes('done'), 'finished matches keep their done treatment');
  assert(sat.includes('data-follow="2026-07-11|660"'), 'the board stamps the followed target: shown day + wave start minute');
  const joined = JSON.parse(JSON.stringify(info.tjson));
  joined.matches.md40[5].result = { status: 'played', winner: 'a' };
  const satDone = renderVenue({ slug: 'multiday', view: 'venues' }, pageData(joined, 'multiday', repo.index), clockAt(at('2026-07-11T13:00:00-04:00')));
  assert(satDone.includes('data-follow="2026-07-11|"'), 'the key moves when the last pool match lands — the only thing that re-aims');
});

test('kiosk follow: the aim target is the earliest wave, not the first venue that has one', () => {
  // Two categories, two courts: court 1's wave is 14:00, court 3's is 11:00. The
  // board renders column-major, so a DOM-order target would land on the 14:00 card.
  const tjson = bare({
    venues: [{ id: 'c1', name: 'Court 1' }, { id: 'c3', name: 'Court 3' }],
    players: ['p1', 'p2', 'p3', 'p4'].map(id => ({ id, name: id.toUpperCase() })),
    categories: [{ ...bareCat, id: 'a', name: 'A' }, { ...bareCat, id: 'b', name: 'B' }],
    matches: {
      a: [{ id: 1, pool: 'A', scheduled: '2026-05-02T11:00:00', venue: 'c3', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }],
      b: [{ id: 1, pool: 'A', scheduled: '2026-05-02T14:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p3'] }, { kind: 'players', ids: ['p4'] }] }],
    },
  });
  const html = renderVenue({ slug: 'aim', view: 'venues' }, pageData(tjson, 'aim'), clockAt(Date.parse('2026-05-02T09:00:00Z')));
  assert.deepEqual(vals(html, 'data-aim'), ['660'], 'the 11:00 wave is the target, though court 1 opens the board');
  assert(card(html, 'data-aim', '660').includes('11:00'), 'the follow lands on the earliest wave card');
  assert(!card(html, 'data-aim', '660').includes('14:00'), 'never the later wave in the first column');
  assert.equal(vals(html, 'data-status').filter(s => s === 'next').length, 2, 'both waves stay accented — the aim is the earliest');
});

test('kiosk ready: a free team\'s later match is marked ahead — a held one is not', () => {
  // Round 1 done, round 2's second match spilled a slot. Both its teams are free,
  // so it can be pulled onto a court now; round 3 still waits on the running matches.
  const ctx = catOf('ready', 'rd');
  assert.deepEqual(startableAhead(ctx, catStatus(ctx)).map(m => m.id), [4],
    'the free spilled match is ready ahead; the wave and the matches fed by it are not');
  assert.deepEqual(startableAhead(ctx, { kind: 'blocked' }), [], 'a blocked category exposes nothing, never throws');
  const html = renderVenue({ slug: 'ready', view: 'venues' }, repoPage('ready'), clockAt(Date.parse('2026-05-02T10:05:00Z')));
  const ready = cards(html, 'data-status', 'ready');
  assert.equal(ready.length, 1, 'exactly one card carries the ready hook');
  assert(ready[0].includes('Cid') && ready[0].includes('Gus'), 'the ready card is the free spilled match');
  assert.equal(cards(html, 'data-status', 'next').length, 1, 'the running 10:00 match stays the wave');
});

test('kiosk clock: a match day shows a bare time, off day the shown date as a readout', () => {
  const repo = loadRepo(FIX('multiday'));
  const data = pageData(repo.tournaments.get('multiday').tjson, 'multiday', repo.index);
  const rt = { slug: 'multiday', view: 'venues' };
  const mon = renderVenue(rt, data, clockAt(Date.parse('2026-07-13T12:00:00-04:00'))); // after the last day: the board falls back to Sunday
  assert(mon.includes('<time id="clock" data-mode="date" datetime="2026-07-12"'), 'off match day the clock is the shown day, a plain readout');
  const sat = renderVenue(rt, data, clockAt(Date.parse('2026-07-11T12:00:00-04:00')));
  assert(sat.includes('<time id="clock" data-mode="time"'), 'a match day shows a plain time');
});

test('kiosk: the board title links back to the tournaments index', () => {
  const repo = loadRepo(FIX('multiday'));
  const data = pageData(repo.tournaments.get('multiday').tjson, 'multiday', repo.index);
  const board = renderVenue({ slug: 'multiday', view: 'venues' }, data, clockAt(Date.parse('2026-07-11T12:00:00-04:00')));
  assert(links(board).some(l => l.href === '#'), 'the board header carries the trail link, so the kiosk is never a dead end');
});

test('kiosk: the status dot never pretends live without a successful fetch', () => {
  const tjson = () => ({
    name: 'Live', location: 'Hall', timezone: 'UTC', venues: [{ id: 'c1', name: 'Court 1' }],
    players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    categories: [{ id: 't', name: 'T', bestOf: { groups: 1, knockout: 1 }, slotMinutes: { groups: 30, knockout: 30 } }],
    matches: { t: [{ id: 1, pool: 'A', scheduled: '2026-05-02T09:00:00', venue: 'c1', sides: [{ kind: 'players', ids: ['p1'] }, { kind: 'players', ids: ['p2'] }] }] },
  });
  const rt = { slug: 'kiosk-live', view: 'venues' };
  const open = renderVenue(rt, pageData(tjson(), 'kiosk-live'), clockAt(Date.parse('2026-05-02T09:30:00Z')));
  assert(open.includes('data-status="reconnecting"'), 'no successful fetch yet — the stamp reads reconnecting, never pretends live');
  assert(open.includes('role="status"'), 'a11y: the reconnecting state is its own live region, not the counting time');
});

// A renderer reads no clock and no module variable: every level is reachable by handing it
// a stamp, which is what lets this be a test instead of a coincidence.
test('the freshness dot names the level its stamp implies, on every polling view', () => {
  const data = repoPage('full');
  const now = 1e12;
  const stamp = age => ({ at: now - age, now });
  const levels = [['live', 1000], ['lagging', STALE_MS], ['reconnecting', STALE_MS + 1]];
  const views = [
    ['tournament', s => renderTournament({ slug: 'full', view: 'tournament' }, data, s)],
    ['kiosk', s => renderVenue({ slug: 'full', view: 'venues' }, data, s)],
    ['schedule', s => renderPlayer({ slug: 'full', view: 'schedule' }, data, s)],
  ];
  for (const [name, draw] of views) {
    for (const [level, age] of levels) {
      assert(draw(stamp(age)).includes(`data-status="${level}"`), `${name}: a stamp ${age}ms old reads ${level}`);
    }
  }
});

test('routing: cat and player ride along between tournament and schedule — applied on their home view only', () => {
  const data = repoPage('sample');
  const t = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  assert(lk(t, 'Schedule').href === '#sample/schedule?cat=md40', 'tournament page carries cat onto the schedule link');
  assert(lk(t, 'Mixed Doubles').href === '#sample?cat=xd', 'the switcher selects another category, no extra params');
  const s = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1', cat: 'md40' }, data);
  assert(lk(s, 'Tournament').href === '#sample?cat=md40&player=p1', 'schedule page carries cat and player back onto the tournament link');
  assert(lk(s, 'Change player').href === '#sample/schedule?cat=md40', 'Change keeps the cat, drops only the player');
  const back = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40', player: 'p1' }, data);
  assert(lk(back, 'Schedule').href === '#sample/schedule?cat=md40&player=p1', 'tournament page carries the pick onto Schedule');
  assert(lk(back, 'Mixed Doubles').href === '#sample?cat=xd&player=p1', 'category switch keeps the riding player');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule', cat: 'md40' }, data);
  assert(links(picker).some(x => x.href.startsWith('#sample/schedule?cat=md40&player=')), 'picker picks carry the cat and the pick');
});

test('routing: schedule links carry the chosen language — a shared URL keeps it', () => {
  const data = repoPage('sample');
  const s = renderPlayer({ slug: 'sample', view: 'schedule', player: 'p1', cat: 'md40', lang: 'de' }, data);
  assert(lk(s, 'Change player').href.endsWith('&lang=de'), 'Change player keeps the language');
  const picker = renderPlayer({ slug: 'sample', view: 'schedule', cat: 'md40', lang: 'de' }, data);
  assert(links(picker).some(x => x.href.endsWith('&lang=de')), 'picker picks keep the language');
});

test('knockout wave link names the merged band; playable placement matches share the accent', () => {
  const base = () => JSON.parse(JSON.stringify(require(FIX('sample', 'tournaments', 'sample.json'))));
  const render = tjson => {
    const data = pageData(tjson, 'sample', [{ slug: 'sample', name: tjson.name, location: tjson.location }]);
    return renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, data);
  };
  const played = (tjson, ids) => { for (const id of ids) { const m = tjson.matches.md40.find(x => x.id === id); m.result = { status: 'played', winner: 'a' }; delete m.games; } };
  // as-is: semis (m8) and final (m9) open, bronze (m10) open — the wave is the
  // Semifinals, not the bronze; a placement match whose feeder is undecided is
  // not flagged
  const a = render(base());
  assert(vals(a, 'data-jump').includes('ko-1') && !vals(a, 'data-jump').includes('ko-0'), 'jump lands on Semifinals, never on Final for a placement match');
  assert.equal(vals(a, 'data-status').filter(s => s === 'next').length, 2, 'a placement match whose feeder is undecided: the Next line and the card are flagged');
  // championship finished, only the bronze left open: the wave is the placement
  // band, and the open bronze carries the accent so the link has its partner
  const done = base(); played(done, [7, 8, 9]);
  const doneHtml = render(done);
  assert(vals(doneHtml, 'data-jump').includes('ko-0'), 'placement-pending links to the merged band, not a round or a Placement section');
  assert.equal(vals(doneHtml, 'data-status').filter(s => s === 'next').length, 2, 'the Next line and the open bronze carry the flag');
  assert(cards(doneHtml, 'data-status', 'next').some(c => c.includes('3rd place')), 'the accent lands on the open placement card in the band');
  // both semis decided, final + bronze open: the Final wave flags both playable matches
  const tjson = base(); played(tjson, [7, 8]);
  const html = render(tjson);
  assert(vals(html, 'data-jump').includes('ko-0'), 'the wave is the Final');
  assert.equal(vals(html, 'data-status').filter(s => s === 'next').length, 3, 'the Next line, the final, and the playable bronze all carry the accent');
});

test('i18n: the language override is accepted in either query position', () => {
  assert.equal(resolveLang('#slug?lang=de', '?lang=en'), 'de', 'the fragment form (which rides the links) wins');
  assert.equal(resolveLang('#slug', '?lang=de'), 'de', 'the URL query — where people actually type it — is read too');
  assert.equal(resolveLang('#slug', '?lang=fr'), 'en', 'an unknown language falls back to the browser language (en in tests)');
});

test('i18n: a native-digit locale still keys days in ISO — Intl digits never leak into the stored form', () => {
  setLocale('ar-EG');
  try {
    assert.equal(dayKey(Date.parse('2026-05-02T12:00:00Z'), 'Europe/Zurich'), '2026-05-02', 'day keys stay latn Y-M-D, or grouping/sorting silently breaks');
  } finally {
    setLocale('en');
  }
});

test('i18n: every translation key exists in both languages', () => {
  // string keys only — the fmt/refs/art sub-maps legitimately differ per locale
  // (en needs no articles, a third language may decline where en does not).
  const words = o => Object.entries(o).filter(([, v]) => typeof v === 'string').map(([k]) => k).sort();
  assert.deepEqual(words(I18N.de), words(I18N.en), 'a key missing from one language leaves a {placeholder} on the page');
});

test('i18n: German derives domain labels and date spans — not just chrome', () => {
  setLocale('de');
  try {
    assert.equal(roundName(1), 'Halbfinale', 'round names follow the dialect');
    assert(fmtRange(['2026-07-11', '2026-07-12']).includes('11. Juli'), 'German date spans keep the day first');
    // the same-byes scenario the en chip test pins, in German — articles decline by case
    const info = loadRepo(FIX('byes')).tournaments.get('byes');
    const page = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p4' }, pageData(info.tjson, 'byes', info.index));
    const poss = cards(page, 'data-status', 'possible');
    assert(poss[1].includes('als Sieger vom Viertelfinale'), 'the doer takes the dative — never "von das"');
    assert(poss[2].includes('über das Halbfinale'), 'the via takes the accusative');
    const md = catOf('sample', 'md40');
    assert.equal(sideLabel(md.byId.get(9).sides[1], md), 'Sieger SF-2', 'an unresolved slot names the bundle words, never an English "Winner of"');
    // the art map is per-key data, not a locale branch: the in-progress round and the
    // finished band both render in the dialect, never a removed-key placeholder
    const capped = catOf('capped', 't');
    assert.equal(playerStatus(capped, 'p1'), 'Im Halbfinale', 'the in-progress round takes the bundle article — never an English "In the"');
    assert.equal(playerStatus(capped, 'p6'), '5.\u20138.', 'a finished band renders in the dialect — no leftover elimination wording');
  } finally {
    setLocale('en');
  }
});

test('i18n: German renders stay whole — no raw placeholders, never a throw', () => {
  setLocale('de');
  try {
    const repo = loadRepo(FIX('full'));
    const info = repo.tournaments.get('full');
    const data = pageData(info.tjson, 'full', repo.index);
    const views = [
      () => renderTournament({ slug: 'full', view: 'tournament' }, data),
      () => renderVenue({ slug: 'full', view: 'venues' }, data, clockAt(Date.now())),
      () => renderPlayer({ slug: 'full', view: 'schedule' }, data),
    ];
    for (const v of views) {
      const html = v();
      assert(typeof html === 'string' && !html.includes('{'), 'a German view renders complete — no translation placeholder survives');
    }
  } finally {
    setLocale('en');
  }
});

test('i18n: a third locale with deviant word order and declined refs derives cleanly — no code branch sniffs strings', () => {
  // Synthetic fr: classification words at the FRONT ('place 3') where en and de
  // both put them at the back, its own round names, ordinal style, and declined
  // refs. Under the old isDe branches a third language silently got English
  // rules — this pins that adds-a-language = adds-a-bundle only.
  I18N.fr = {
    ...I18N.en,
    'round-final': 'Finale', 'round-semi': 'Demi-finales', 'round-quart': 'Quarts',
    'round-16': 'Seizièmes', 'round-of': 'Tour {n}',
    'pl-place': 'place {n}', 'pl-semi': 'demi {a}–{b}',
    fmt: {
      ord: n => `${n}e`, place: n => String(n),
      bandShort: l => l.replace(/^(place|demi) /, ''),
    },
    refs: {
      'round-final': { acc: 'la finale', dat: 'de la finale' },
      '': { acc: 'le {label}', dat: 'du {label}' },
    },
    art: { 'round-of': 'dans la' },
  };
  setLocale('fr');
  try {
    assert.equal(roundName(1), 'Demi-finales', 'round names ride the bundle keys, not en/de branches');
    assert.equal(roundName(2), 'Quarts', 'the quart key applies at n=4');
    assert.equal(roundName(3), 'Seizièmes', 'the n=16 key is unconditional — no isDe guard');
    const sample = loadRepo(FIX('sample')).tournaments.get('sample');
    const tour = renderTournament({ slug: 'sample', view: 'tournament', cat: 'md40' }, pageData(sample.tjson, 'sample', sample.index));
    assert(!tour.includes('{'), 'the deviant-locale tournament view renders whole — no placeholder');
    assert(tour.includes('place 3'), 'the classification word sits at the front — merge/band logic never sniffs word position');
    const info = loadRepo(FIX('byes')).tournaments.get('byes');
    const page = renderPlayer({ slug: 'byes', view: 'schedule', player: 'p4' }, pageData(info.tjson, 'byes', info.index));
    const poss = cards(page, 'data-status', 'possible');
    assert(poss.length && !poss.some(c => c.includes('{')), 'possible-stage chips render whole under the deviant locale');
    assert(poss.some(c => c.includes('du Quarts')), 'the dative chip ref declines from bundle data — never "vom"');
    assert(poss.some(c => c.includes('le Demi-finales')), 'the accusative chip ref too — never "the"');
    assert.equal(schedTime({ scheduled: '2026-05-02T09:00:00' }, 'Europe/Zurich'), Date.parse('2026-05-02T09:00:00+02:00'), 'the offset parse is locale-independent — a dialect that spells the zone "UTC+02:00" must not null every time');
  } finally {
    setLocale('en');
    delete I18N.fr;
  }
});
