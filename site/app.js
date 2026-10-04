'use strict';

// Players watch the board for their own result, so the cadence stays short; a poll that fires
// mid-download is dropped, so a slow link holds one request per page, not one per tick.
const POLL_MS = 10000;
// The abort bound for one load — a link's bound, never the poll's cadence.
const FETCH_TIMEOUT_MS = 30000;
// One full load (either cache mode), then the wait for the next poll and a grace poll — derived so the relation can't drift.
const STALE_MS = FETCH_TIMEOUT_MS + 2 * POLL_MS;
// 135px = the card's measured height at base zoom; under-tune it and cards overlap
// their next slot. ponytail: re-tune on the wall screen beside the viewport floor.
const CARD_PX = 135;

// The kiosk-top header (h1 + venue titles) at base zoom; a taller header clips the
// day's last card. ponytail: measured beside the wall screen — re-tune with the header.
const HEADER_PX = 79;

// The viewport floor — never scale the board below this many px per minute.
const MIN_PX_PER_MIN = 1.6;

// Cards end this many px short of their slot so tops stay pinned and bottoms read as
// separate blocks; rendered inline because a content-driven flex wrapper won't shrink.
const CARD_GAP = 4;

// The board's foot clearance — the gap the last card leaves, matching the gap above
// the first card (.board margin-top). ponytail: re-tune beside the header constant.
const GAP_PX = 16;

// Under node the classic-script globals must be reproduced on globalThis; in
// the browser each script publishes its names in page order.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./i18n.js'), require('./derive.js'), require('./views.js'));
}

// Missing venue id falls back to the id.
const venueName = (ctx, id) => ctx.venues.get(id) || id;

// Page language, resolved once at boot: ?lang= wins, else the browser's, else English.
let lang = 'en';
const u = (k, p) => t(lang, k, p);
// ?lang= is accepted in the fragment (#s?lang=de) or the query (?lang=de#s); a
// language is usable only when its bundle ships.
const langOf = v => { const l = String(v || '').toLowerCase(); return /^[a-z]{2}$/.test(l) && I18N[l] ? l : null; };
const resolveLang = (hash, search) => {
  const r = parseRoute(hash);
  if (r && r.lang) return r.lang;
  const l = langOf(new URLSearchParams(search).get('lang'));
  if (l) return l;
  if (typeof navigator === 'undefined') return 'en';
  for (const tag of navigator.languages || [navigator.language]) {
    const m = langOf(/^([a-z]{2})/i.exec(tag || '')?.[1]);
    if (m) return m;
  }
  return 'en';
};

// A dead deep link (httpError — permanent, stop polling) versus a transient
// network failure (null — the poll retries next tick).
const HTTP_ERR = { httpError: true };

// A load must always settle inside the bound — that one guarantee is what lets the poll
// keep a single request per page and need no ordering at all. AbortSignal.timeout is the
// native bound; the timer is the same bound for a browser that lacks it (old Safari).
const timeoutSignal = ms => {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms); // ponytail: no clearTimeout — the late abort hurts nothing
  return c.signal;
};

// 'no-cache' keeps the CDN's 304 byte-saving; a browser that rejects that
// revalidation (Safari over HTTP/2, WebKit #114738) retries with 'no-store'.
async function fetchJson(url) {
  // One abort bound covers both cache modes, so a whole load is a single FETCH_TIMEOUT_MS, never two.
  const signal = timeoutSignal(FETCH_TIMEOUT_MS);
  const get = async cache => {
    const res = await fetch(url, { cache, signal });
    if (res.ok) return await res.json();
    // only a gone-for-good link stops the poll — a 5xx returns null like any
    // network failure and the poll retries next tick
    if (res.status === 404 || res.status === 410) return HTTP_ERR;
    return null;
  };
  for (const cache of ['no-cache', 'no-store']) {
    try { return await get(cache); }
    // a bound that fired is a slow link, not the rejected revalidation the retry exists for
    catch { if (signal.aborted) break; }
  }
  return null; // network failure — the poll retries next tick
}

// One page, fragment routing. Segments and params are id-regex-checked; cat is a
// param, never a path segment, so a category id can't shadow a view.
function parseRoute(hash) {
  if (hash === undefined) hash = location.hash;
  const [path, query] = String(hash).replace(/^#/, '').split('?');
  const segs = path.split('/');
  if (segs.length === 1 && segs[0] === '') return { view: 'index' };
  // ponytail: no match deep-links — an in-page anchor (?cat=md#final) dies on the
  // id regex here. Upgrade path if event comms ever asks: anchor-aware routing,
  // ids on cards, one scroll handler.
  if (segs.length > 2 || segs.some(s => !s || !ID_RE.test(s))) return null; // #../../ -> reject
  const [slug, view] = segs;
  if (view !== undefined && view !== 'schedule' && view !== 'venues') return null;
  const r = { slug, view: view || 'tournament' };
  const q = new URLSearchParams(query);
  for (const k of ['cat', 'player', 'venue', 'lang']) {
    const v = q.get(k);
    if (k === 'lang') { const l = langOf(v); if (l) r.lang = l; continue; }
    if (v && ID_RE.test(v)) r[k] = v;
  }
  return r;
}

// Fragment URLs with params in fixed order; cat/player/lang ride between the
// tournament and schedule views so switching keeps the pick.
const CARRY = ['cat', 'player', 'lang'];
const LEGAL = { tournament: CARRY, schedule: CARRY, venues: ['venue', 'lang'] };
const href = (slug, view, p = {}) => {
  const q = LEGAL[view].filter(k => p[k]).map(k => `${k}=${p[k]}`).join('&');
  return `#${slug}${view === 'tournament' ? '' : '/' + view}${q ? '?' + q : ''}`;
};

async function loadAll(route) {
  if (route.view === 'index') {
    const raw = await fetchJson('tournaments.json');
    // a failure must not read as the legitimate empty list — the poll can't retry the index
    if (!Array.isArray(raw)) return { index: null, failed: true };
    return { index: raw };
  }
  // one file per tournament — a poll is a single atomic fetch
  const tjson = await fetchJson(`tournaments/${route.slug}.json`);
  if (tjson === HTTP_ERR) return { httpError: true };
  const t = tjson ? { slug: route.slug, name: tjson.name } : null;
  return { t, tjson, cats: toCats(tjson) };
}

// The index has no snapshot; a snapshot renders in place only for its own slug,
// so a view/cat/player hop is a cache hit and anything else refetches.
const needsFetch = (r, d) => r.view === 'index' || !(d && d.t && d.t.slug === r.slug);

// A same-slug response is the same file: a category/view hop supersedes nothing and
// still feeds the route on screen; only a different tournament drops it.
const superseded = (route, r) => !route || route.slug !== r.slug;

const segmentBar = r => {
  const t = r.view === 'tournament', m = r.view === 'schedule';
  const item = (v, on) => on ? `<span aria-current="page">${u(v)}</span>` : `<a href="${esc(href(r.slug, v, r))}">${u(v)}</a>`;
  return `<nav class="segments" aria-label="${u('views')}">${item('tournament', t)}${item('schedule', m)}</nav>`;
};

const MISSING = () => `<p>${u('missing')}</p>`;

// A rejected fragment route or a slug whose file is a permanent 404.
const BAD_LINK = () => `<p>${u('bad-link')}</p><p><a href="#">${u('all-tournaments')}</a></p>`;

// Painted through a named seam so the branch is DOM-testable.
const paintBadRoute = el => { el.innerHTML = BAD_LINK(); };

// A busy page reads as loading, not dead. Named as a seam so the state flip is
// DOM-testable; "true" is spelled out because a valueless attribute reads as false.
const setPending = (el, on) => { if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); };

const FAILED = () => `<p>${u('failed')}</p>`;


const matchGrid = (ms, ctx, day, next) => `<div class="grid">${ms.map(m => matchCard(m, ctx, { meta: ['time', 'label', 'court'], day, status: next && next(m) ? 'next' : undefined })).join('')}</div>`;

// Date leads, undated entries defer to the end, ties hold index order (stable sort).
function renderIndex(route, data) {
  const items = (Array.isArray(data.index) ? data.index : [])
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .sort((a, b) => {
      const ad = a.dates && a.dates[0], bd = b.dates && b.dates[0];
      if (ad && bd) return ad === bd ? 0 : ad < bd ? 1 : -1; // Y-M-D strings sort chronologically, newest first
      return ad ? -1 : bd ? 1 : 0;
    })
    .map(e => {
      const dates = fmtRange(e.dates); // stored ISO days -> span
      const meta = [dates, e.location].filter(Boolean).map(esc).join(' · ');
      const name = esc(e.name || e.slug);
      // the card opens the tournament; the venue board is a sibling chip — a
      // link can't nest a link
      return `<div class="card-wrap"><a class="card" aria-label="${name}" href="#${esc(e.slug)}"><h2>${name}</h2>${meta ? `<p>${meta}</p>` : ''}</a><a class="chip board-link" target="_blank" rel="noopener" href="#${esc(e.slug)}/venues" aria-label="${u('venue-board')}">⛶</a></div>`;
    });
  if (!items.length) return `<header><h1>${u('tournaments')}</h1><p>${u('no-tournaments')}</p></header>`;
  return `<header><h1>${u('tournaments')}</h1></header><section class="stack">${items.join('')}</section>`;
}

// One category per page; the first stays canonical at the bare slug, the rest select via ?cat=.
const catNav = (slug, ctxs, route) => {
  // an unknown cat renders the first category — the tabs must agree with the page
  const activeId = route.cat && ctxs.some(x => x.id === route.cat) ? route.cat : ctxs[0]?.id;
  return ctxs.map((c, i) => {
    const p = { ...route, cat: i === 0 ? undefined : c.id };
    const label = esc(c.name || c.id);
    const cat = `data-cat="${c.order + 1}"`;
    if (activeId === c.id) return `<span ${cat} aria-current="page">${label}</span>`;
    return `<a href="${esc(href(slug, 'tournament', p))}" ${cat}>${label}</a>`;
  }).join('');
};

// Freshness is a level, not a boolean. lastPoll moves only on a success, nowMs is real
// time: inside two poll cycles the board is live, past the tolerance it names the
// reconnect, and the band between lags — behind, but a request may still be in flight.
// Before the first success it reads reconnecting.
const LAG_MS = 2 * POLL_MS;
const freshness = (lastFetchMs, nowMs) => {
  if (!lastFetchMs) return 'reconnecting';
  const age = nowMs - lastFetchMs;
  return age > STALE_MS ? 'reconnecting' : age > LAG_MS ? 'lagging' : 'live';
};

// A changed same-slug file is a pulse candidate; the caller adds the flag only when the
// change also moved the rendered markup. boot owns the hash so renderers stay pure.
const changedTournament = (prev, slug, hash) => !!prev && prev.slug === slug && prev.hash !== hash;

// The freshness dot: filled green while the last fetch sits inside two poll cycles, an
// amber ring when it lags, a red ring past the tolerance. A fixed box, so a state change
// never shifts the title row; the word is sr-only and the timestamp a hover title. The
// level doubles as the i18n key. The caller hands in the fetch stamp — statusDot reads no
// clock of its own, so a renderer's output is a function of what it is given, and a test
// can name every level.
function statusDot(data, stamp) {
  const { at = 0, now = 0 } = stamp || {};
  const level = freshness(at, now);
  const when = at ? fmtTime(at, data.tjson.timezone || 'UTC') : '—';
  return `<span class="status" role="status" data-status="${level}" title="${esc(u('updated', { time: when }))}"><span class="sr-only">${esc(u(level))}</span></span>`;
}

const HOME_LINK = () => `<a class="chip" href="#" aria-label="${u('tournaments')}">⎋</a>`;

function renderTournament(route, data, stamp) {
  if (!data.tjson) return MISSING();
  const tz = data.tjson.timezone || 'UTC';
  const ctxs = data.cats;
  const show = ctxs.find(c => c.id === route.cat) || ctxs[0]; // an unknown cat falls back to the first
  const days = schedDays(ctxs.flatMap(c => c.matches), tz); // one scan: the span and the multi-day cue read the same set
  const multi = days.length > 1;
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}<span class="head-right">${HOME_LINK()}${statusDot(data, stamp)}</span></h1>`];
  // the heading states the span and the location once — single-day cards never repeat the date
  const range = fmtRange(days);
  parts.push(`<p>${[range, esc(data.tjson.location)].filter(Boolean).join(' · ')}</p></header>`);
  parts.push(`<nav class="cats" aria-label="${u('categories')}">${catNav(data.t.slug, ctxs, route)}</nav>`);
  // a tournament with no categories renders the shell, never a throw
  if (show) parts.push(catSection(show, { multi, href: href(data.t.slug, 'tournament', route) }));
  return parts.join('');
}

// Progress only, linkless — the page's one link is the Next line.
const statusLine = (status, ctx) => {
  if (!status) return '';
  if (status.kind === 'groups') return `<p>${u('group-status', { played: status.played, count: status.count })}</p>`;
  if (status.kind === 'blocked') return `<p>${u('ko-blocked')}</p>`;
  if (status.kind === 'ko') {
    if (status.wave === null) return `<p>${u('ko-remain')}</p>`;
    return `<p>${u('ko-round', { round: esc(stageGroupName(roundName(status.wave), bandLabels(ctx, status.wave))) })}</p>`;
  }
  if (status.kind === 'finished') return `<p data-status="finished">${u('finished')}</p>`;
  // winners: one line per place, third only when a bronze decided it — 4th is
  // omitted, only the top 3 get awards
  return [[u('champion'), status.first], [u('runner-up'), status.second], [u('rank3'), status.third]]
    .filter(([, ids]) => ids)
    .map(([rank, ids]) => `<p>${rank}: ${esc(teamLabel(ids, ctx))}</p>`)
    .join('');
};

// Compact court list; consecutive numbered courts collapse ("Court 1–5") without
// pluralizing the shared head.
const fmtCourts = names => {
  const ns = [...new Set(names)];
  if (ns.length === 1) return ns[0];
  const m = ns.map(n => /^(.*?)\s*(\d+)$/.exec(n));
  if (m.every(x => x && x[1] === m[0][1])) {
    const head = m[0][1];
    const nums = m.map(x => +x[2]).sort((a, b) => a - b);
    if (new Set(nums).size === nums.length &&
        nums[nums.length - 1] - nums[0] === nums.length - 1) {
      return `${head} ${nums[0]}–${nums[nums.length - 1]}`;
    }
  }
  return ns.join(' · ');
};

// The "Next" line — data-only, never the clock.
const anticipationLine = (ctx, status, href, day, wave) => {
  if (!status || status.kind === 'finished' || status.kind === 'winners' || status.kind === 'blocked') return '';
  if (!wave.length) return ''; // no playable match (feeders undecided): the progress line carries the page
  const m0 = wave[0];
  const courts = [...new Set(wave.map(m => m.venue ? venueName(ctx, m.venue) : null).filter(Boolean))];
  // fmtCourts is repo data — the same esc contract as every other name on the page
  const where = courts.length ? ` · ${esc(fmtCourts(courts))}` : '';
  // the jump target is the section the wave lives in
  const section = status.kind === 'groups' ? 'group-matches' : status.wave !== null ? `ko-${status.wave}` : '';
  const inner = `${timeEl(schedTime(m0, ctx.tz), ctx.tz, day)}${where}`;
  const body = section ? `<a data-jump="${section}" href="${esc(href)}">${inner}</a>` : inner;
  return `<p${section ? ' data-status="next"' : ''}>${u('next', { body })}</p>`;
};

// Why a row sits where it sits: the ladder rung that placed it, with the numbers it won on. Only a
// wins-tie reaches a rung, so a row the wins alone placed stays blank; a tie no rung could split
// says level — but only in a sealed pool (derive), where no play is left to move it.
function tiebreakCell(r, sealed) {
  const tb = r.h2h && {
    h2hWins: ['tiebreak-wins', r.h2h.w],
    h2hGameRatio: ['tiebreak-games', `${r.h2h.gw}:${r.h2h.gl}`],
    h2hPointRatio: ['tiebreak-points', `${r.h2h.pw}:${r.h2h.pl}`],
  }[r.splitBy];
  if (tb) return `<td data-tiebreak="${esc(r.splitBy)}">${esc(u(tb[0]))} ${esc(String(tb[1]))}</td>`;
  if (r.tie) return sealed ? `<td data-tiebreak="level">${esc(u('tiebreak-level'))}</td>` : '<td></td>';
  return '<td></td>';
}

function catSection(ctx, opts) {
  const parts = [];
  const byPool = new Map(); // pool -> its group matches (creation order = pool order)
  const ko = [];
  for (const m of ctx.matches) {
    if (!m) continue;
    if (m.pool !== undefined) {
      if (!byPool.has(m.pool)) byPool.set(m.pool, []);
      byPool.get(m.pool).push(m);
    } else ko.push(m);
  }
  // All pools, chronological by wall-clock (stable sort keeps file order on ties);
  // a TBD-time match trails the scheduled ones.
  const grp = [...byPool.values()].flat().sort((a, b) => (schedTime(a, ctx.tz) ?? Infinity) - (schedTime(b, ctx.tz) ?? Infinity));
  // one category subline: the date span on multi-day pages only — a single-day
  // heading already states the date once — then the status sentence or podium
  const status = catStatus(ctx);
  // one current-wave predicate drives the card highlight, the Next line, and
  // the editor's next
  const wave = currentWave(ctx, status);
  const next = m => wave.includes(m);
  const lines = [];
  if (opts.multi) lines.push(`<p>${esc(fmtRange(schedDays(ctx.matches, ctx.tz)))}</p>`);
  if (status) lines.push(statusLine(status, ctx));
  lines.push(anticipationLine(ctx, status, opts.href, opts.multi, wave));
  parts.push(`<section><h2>${esc(ctx.name)}</h2>${lines.join('')}`);
  if (grp.length) {
    parts.push(`<section><h3>${u('group-stage')}</h3>`);
    // scoreboard first, cards last
    if (byPool.size) {
      parts.push('<div class="grid">');
      for (const [pool] of byPool) {
        parts.push(`<div><h4>Pool ${esc(String(pool))}</h4>`);
        const std = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
        const ranks = poolDecided(std) ? poolRanks(std) : null;
        // The reason column earns its width only where it can say something: a rung placed a row, or a
        // sealed pool left a tie the ladder could not split.
        const sealed = poolSealed(ctx, pool);
        const showTb = std.some(r => r.splitBy) || (sealed && std.some(r => r.tie));
        const tbHead = showTb ? `<th scope="col">${u('tiebreak')}</th>` : '';
        parts.push(`<table><thead><tr><th scope="col" class="num">#</th><th scope="col">${u('team')}</th><th scope="col" class="num"><abbr title="${esc(u('played-col'))}">P</abbr></th><th scope="col" class="num"><abbr title="${esc(u('won-col'))}">W</abbr></th>${tbHead}</tr></thead><tbody>`);
        std.forEach((r, i) => {
          parts.push(`<tr><td class="num">${ranks ? ranks[i] : ''}</td><td>${esc(teamLabel(r.ids, ctx))}</td><td class="num">${r.wins + r.losses}</td><td class="num">${r.wins}</td>${showTb ? tiebreakCell(r, sealed) : ''}</tr>`);
        });
        parts.push('</tbody></table></div>');
      }
      parts.push('</div>');
    }
    parts.push(`<h4 id="group-matches">${u('group-matches')}</h4>`, matchGrid(grp, ctx, opts.multi, next), '</section>');
  }
  if (ko.length) parts.push(bracketHtml(ctx, ko, opts.multi, next));
  parts.push('</section>');
  return parts.join('');
}


// Bracket order first (a card's position must match its QF/SF ordinal), then time;
// TBD-time trails.
const koOrder = (ms, ctx) => [...ms].sort((a, b) =>
  (koOrdinal(a, ctx) || Infinity) - (koOrdinal(b, ctx) || Infinity) ||
  (schedTime(a, ctx.tz) ?? Infinity) - (schedTime(b, ctx.tz) ?? Infinity));

// By prize (3rd before 5th) then time.
const placeOrder = ctx => (a, b) =>
  ((plRange(a, ctx) || {}).lo ?? Infinity) - ((plRange(b, ctx) || {}).lo ?? Infinity) ||
  (schedTime(a, ctx.tz) ?? Infinity) - (schedTime(b, ctx.tz) ?? Infinity);

// Each column holds the round's matches plus classification matches at the same edge count.
function bracketHtml(ctx, ko, multi, next) {
  const main = ko.filter(m => plRange(m, ctx) === null);
  const placement = ko.filter(m => plRange(m, ctx) !== null);
  const maxR = main.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  const cols = [];
  for (const m of main) {
    const r = maxR - koColumn(m, ctx);
    (cols[r] = cols[r] || { main: [], place: [] }).main.push(m);
  }
  for (const m of placement) {
    const c = placementColumn(m, ctx);
    if (c === null) continue; // malformed — the gate reports it
    (cols[maxR - c] = cols[maxR - c] || { main: [], place: [] }).place.push(m);
  }
  const parts = [];
  parts.push(`<section><h3>${u('ko-stage')}</h3>`);
  for (let r = 0; r <= maxR; r++) {
    const g = cols[r];
    if (!g || (!g.main.length && !g.place.length)) continue;
    const col = maxR - r; // koColumn is distance from the final; render that column rightmost
    // winner path first in bracket order, then its classification companions by prize
    const ms = [...koOrder(g.main, ctx), ...g.place.sort(placeOrder(ctx))];
    parts.push(`<h4 id="ko-${col}">${stageGroupName(roundName(col), bandLabels(ctx, col))}</h4>`, matchGrid(ms, ctx, multi, next));
  }
  parts.push('</section>');
  return parts.join('');
}

// datetime carries the instant; the label stays wall-clock — multi-day pages
// prefix the date
const timeEl = (t, tz, day) => `<time datetime="${new Date(t).toISOString()}">${esc((day ? `${dayShort(t, tz)}, ` : '') + fmtTime(t, tz))}</time>`;

// Join a stage slot list with ' / '; empty → null (callers render TBD).
const stageBit = (list, fmt) => list?.length ? list.map(fmt).join(' / ') : null;

const catChip = ctx => `<span class="cat" data-cat="${ctx.order + 1}">${esc(ctx.name)}</span>`;

// opts.meta picks the meta items; opts.head is an optional [left, right] row —
// a cell is { key: item field } or { html: pre-rendered }.
function matchCard(m, ctx, opts = {}) {
  const t = schedTime(m, ctx.tz);
  const item = {
    catName: catChip(ctx),
    label: esc(matchLabel(m, ctx)),
    court: m.venue ? esc(venueName(ctx, m.venue)) : 'TBD',
    time: t !== null ? timeEl(t, ctx.tz, opts.day) : 'TBD',
  };
  const meta = opts.meta.map(k => item[k]).join(' · ');
  const head = opts.head ? `<div class="head">${opts.head.map(c => `<span>${c.html !== undefined ? c.html : item[c.key]}</span>`).join('')}</div>` : '';
  return `<article${opts.id ? ` id="${opts.id}"` : ''}${opts.status ? ` data-status="${opts.status}"` : ''}${opts.aim != null ? ` data-aim="${opts.aim}"` : ''}${opts.style ? ` style="${opts.style}"` : ''}>${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
}

function sideRow(m, ctx, i) {
  const w = winnerIdx(m);
  // a malformed match (missing sides) renders TBD rows, never takes the board down
  const side = m.sides && m.sides[i];
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${esc(sideLabel(side, ctx))}</span>${w === i ? `<span class="winmark" aria-label="${u('won')}">✓</span>` : ''}<span class="score">${scoreCells(m, i, ctx)}</span></div>`;
}

function renderVenue(route, data, stamp) {
  if (!data.tjson) return MISSING();
  const { now = 0 } = stamp || {}; // the board's clock and the dot's level ride the one stamp the caller read
  const v = route.venue;
  const rows = [];
  const ctxs = data.cats;
  // The board's follow: each category's current wave — its earliest playable matches.
  const nexts = new Set();
  for (const ctx of ctxs) for (const m of currentWave(ctx, catStatus(ctx))) nexts.add(m);
  for (const ctx of ctxs) {
    for (const m of ctx.matches) {
      if (!m || m.venue === undefined) continue;
      const t = schedTime(m, ctx.tz);
      if (t === null) continue;
      rows.push({ m, t, ctx });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const shown = v ? rows.filter(r => r.m.venue === v) : rows;
  const tz = data.tjson.timezone || 'UTC';
  const today = dayKey(now, tz); // one day per screen — an overnight board must not list yesterday
  const isMatchDay = schedDays(ctxs.flatMap(c => c.matches), tz).includes(today); // a scheduled day, never a gap day
  const firstDay = rows.length ? dayKey(rows[0].t, rows[0].ctx.tz) : null;
  const lastDay = rows.length ? dayKey(rows.at(-1).t, rows.at(-1).ctx.tz) : null;
  // Before day one preview day one, after the last day show its board.
  const shownDay = firstDay && today < firstDay ? firstDay : lastDay && today > lastDay ? lastDay : today;
  const open = shown.filter(r => dayKey(r.t, r.ctx.tz) === shownDay); // the full day stays on the board; the scroll follows the current slot
  // a match on an undeclared venue (the gate reports it) renders absent
  const declared = (Array.isArray(data.tjson.venues) ? data.tjson.venues : []).filter(venue => venue && typeof venue === 'object');
  const venueNames = new Map(declared.map(v => [v.id, v.name])); // the board's own map — no reach into a category ctx
  const cols = declared.map(v => v.id).filter(id => open.some(r => r.m.venue === id));
  // the clock is a readout, never a control: a bare time while the board plays today,
  // the shown day's date otherwise
  const dayText = fmtRange([shownDay]); // null when the day or tz is unreadable
  const time = esc(fmtTime(now, tz));
  const clock = isMatchDay
    ? `<time id="clock" data-mode="time">${time}</time>`
    : dayText
      ? `<time id="clock" data-mode="date" datetime="${esc(shownDay)}">${esc(dayText)}</time>`
      : '';
  // the title carries the same trail link as the tournament page. The clock, that
  // link, and the freshness dot ride the title line pinned to the viewport's right
  // edge, so all three stay put while a wider-than-screen board pans sideways — and
  // the link sits against the dot, as on every other polling view
  const header = `<header><h1><span class="name">${esc(data.t.name)}</span><span class="head-right">${clock}${HOME_LINK()}${statusDot(data, stamp)}</span></h1></header>`;
  // header and venue titles stick as one block, aligned by the shared --cols track
  const top = `<div class="kiosk-top" style="--cols: ${cols.length}">${header}${cols.map(id => `<h2>${esc(venueNames.get(id) || id)}</h2>`).join('')}</div>`;
  if (!cols.length) return top + `<p>${u('nothing')}</p>`;
  // Wall-clock minutes drive the layout, never offsets. One window per row feeds the
  // frame, scale, and placement; a missing slot length leaves e null.
  const win = open.map(r => {
    const s = wallMin(r.t, r.ctx.tz);
    const sl = matchSlotMs(r.m, r.ctx) / 60000;
    return { r, s, e: Number.isFinite(sl) ? s + sl : null };
  }).filter(w => Number.isFinite(w.s)); // a null/NaN wall minute would NaN the day's frame — keep it off the layout
  // every readable row dropped: no time axis to draw, else the day math NaNs the board
  if (!win.length) return top + `<p>${u('nothing')}</p>`;
  const byVenue = new Map(cols.map(id => [id, []]));
  for (const w of win) {
    const list = byVenue.get(w.r.m.venue);
    if (list) list.push(w);
  }
  // Day frame: first start to last slot end — no pad, the board hugs its cards.
  const dayStart = Math.min(...win.map(w => w.s));
  const endMax = Math.max(...win.map(w => w.e ?? -Infinity));
  // One rule for any slot length: a 60-min match reads six times a 10-min one and the
  // shortest card always fits. (30: no known slot lengths)
  const lens = win.filter(w => w.e !== null).map(w => w.e - w.s);
  const sShort = lens.length ? Math.min(...lens) : 30;
  const total = (Number.isFinite(endMax) ? endMax : dayStart + 60) - dayStart; // never 0 — a length-less day still spans an hour
  const avail = typeof document !== 'undefined' ? document.documentElement.clientHeight : 0;
  // + CARD_GAP: the card subtracts it below, else the shortest card clips its last line
  // the board's foot gap owns its band, same as the sticky header above
  const ppm = Math.max(MIN_PX_PER_MIN, avail ? (avail - HEADER_PX - GAP_PX) / total : 0, (CARD_PX + CARD_GAP) / sShort);
  const y = min => (min - dayStart) * ppm;
  const nextRows = win.filter(w => nexts.has(w.r.m));
  const aimMin = nextRows.length ? Math.min(...nextRows.map(w => w.s)) : null;
  const card = (r, h, aim) => {
    const status = isDone(r.m) ? 'done' : nexts.has(r.m) ? 'next' : 'upcoming';
    return matchCard(r.m, r.ctx, { meta: ['catName'], aim,
      head: [{ html: timeEl(r.t, r.ctx.tz) }, { key: 'label' }], status, style: `height:${h}px` });
  };
  // Cards sit at their wall-clock top; only the earliest wave's cards carry data-aim,
  // so the follow lands on it rather than on the first venue column that has a wave.
  const placed = w => {
    const { r, s, e } = w;
    const aim = s === aimMin && nexts.has(r.m) ? aimMin : null; // the wave's earliest cards, never a done one at the same minute
    return `<div class="bcard" style="top:${y(s)}px">${card(r, e !== null ? (e - s) * ppm - CARD_GAP : CARD_PX, aim)}</div>`;
  };
  const dayH = Math.ceil(total * ppm);
  const nowMin = wallMin(now, tz);
  // The line is the day's "now" — drawn only while the board's day is today, so it
  // reads as an ahead/behind reference beside the wave the aim follows.
  const nowY = nowMin !== null && dayKey(now, tz) === shownDay ? Math.min(Math.max(y(nowMin), 0), dayH) : null;
  return top + `<div class="board" data-follow="${shownDay}|${aimMin ?? ''}" style="--cols: ${cols.length}; --day-h: ${dayH}">${nowY !== null ? `<div class="now" style="top:${nowY}px"></div>` : ''}${cols.map((id, i) => `<div class="col" style="grid-column: ${i + 1}">${byVenue.get(id).map(placed).join('')}</div>`).join('')}</div>`;
}

// Do scheduled matches span more than one wall-clock day? Gates the date on cards.
const multiDay = ctxs => schedDays(ctxs.flatMap(c => c.matches), (ctxs[0] && ctxs[0].tz) || 'UTC').length > 1;


// The round a player could reach once the pools decide; the chip carries the rank
// or outcome that gets in.
function possibleCard(stage, ctx, opts) {
  const when = stageBit(stage.times, t => timeEl(t, ctx.tz, opts.day)) ?? '<span class="tbd">TBD</span>';
  const where = stageBit(stage.courts, c => esc(venueName(ctx, c))) ?? '<span class="tbd">TBD</span>';
  const label = esc(stage.label);
  return `<article${opts.id ? ` id="${opts.id}"` : ''} data-status="possible"><div class="head"><span>${when}</span><span>${where}</span></div><div class="meta">${catChip(ctx)} · ${label}</div>${stage.chip ? `<div class="meta">(${esc(stage.chip)})</div>` : ''}</article>`;
}

function renderPlayer(route, data, stamp) {
  if (!data.tjson) return MISSING();
  const players = (Array.isArray(data.tjson.players) ? data.tjson.players : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = route.player ? players.find(x => x.id === route.player) : null;
  return p ? playerSchedule(route, data, p, stamp) : playerPicker(route, data, players, stamp);
}

// Only participants are pickable, so a pick always renders a schedule; one
// alphabetical card per player — its meta names every category they play in, so
// a player in three categories is still one card.
function playerPicker(route, data, players, stamp) {
  const cards = players
    .map(pl => ({ pl, cats: data.cats.filter(c => playerMatches(c, pl.id).length) }))
    .filter(x => x.cats.length)
    .sort((a, b) => String(a.pl.name || a.pl.id).localeCompare(String(b.pl.name || b.pl.id)))
    .map(({ pl, cats }) => {
      const name = esc(pl.name || pl.id);
      return `<a class="card" aria-label="${name}" href="${esc(href(data.t.slug, 'schedule', { ...route, player: pl.id }))}"><h2>${name}</h2><p>${cats.map(catChip).join(' · ')}</p></a>`;
    });
  const head = `${segmentBar(route)}<header><h1>${u('pick-player')}<span class="head-right">${statusDot(data, stamp)}</span></h1></header>`;
  return cards.length ? `${head}<section class="grid">${cards.join('')}</section>` : head + `<p>${u('no-players')}</p>`;
}

// One flat timeline for the picked player: confirmed matches and possible stages.
function playerSchedule(route, data, p, stamp) {
  const pid = p.id;
  const ctxs = data.cats;
  const multi = multiDay(ctxs); // the stage times need their date on multi-day pages
  const rows = ctxs.flatMap(ctx => playerMatches(ctx, pid).map(pm => ({ m: pm.m, ctx })));
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  // The day owns the context; possible stages merge in at their own time.
  const events = [];
  for (const ctx of ctxs) {
    for (const stage of possibleStages(ctx, pid)) events.push({ t: stage.times?.[0] ?? Infinity, stage, ctx });
  }
  for (const r of rows) events.push({ t: schedTime(r.m, r.ctx.tz) ?? Infinity, r, ctx: r.ctx });
  // times ascending; a confirmed row wins an exact tie against a possible stage
  events.sort((a, b) => a.t - b.t || (a.r ? 0 : 1) - (b.r ? 0 : 1));
  // the "what's next" line names the earliest playable event
  const nextEv = events.find(e => e.r ? !isDone(e.r.m) : true);
  let next = null;
  if (nextEv) {
    // only the body after "Next:" is the link; the label stays plain text
    const link = body => `<a data-jump="next" href="${esc(href(data.t.slug, 'schedule', route))}">${body}</a>`;
    if (nextEv.r) {
      const m = nextEv.r.m, nctx = nextEv.r.ctx;
      const t = schedTime(m, nctx.tz);
      next = u('next', { body: link(`${t !== null ? timeEl(t, nctx.tz, multi) : 'TBD'}${m.venue ? ` · ${esc(venueName(nctx, m.venue))}` : ' · TBD'}`) });
    } else {
      const stage = nextEv.stage, nctx = nextEv.ctx;
      const when = stageBit(stage.times, t => timeEl(t, nctx.tz, multi));
      next = u('next', { body: link(`${esc(stage.label)}${when ? ' · ' + when : ''}${stage.chip ? ` (${esc(stage.chip)})` : ''}`) });
    }
  }
  // one progress line across every category, then the next line below it
  const progress = ctxs.map(ctx => [playerStatus(ctx, pid), ctx.name || ctx.id])
    .filter(([s]) => s)
    .map(([s, name]) => `<span>${esc(name)}: ${esc(s)}</span>`)
    .join('\u00a0· '); // nbsp glues the dot to the line so the only wrap point is after it
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}<span class="head-right"><a class="chip" href="${esc(href(data.t.slug, 'schedule', { ...route, player: null }))}" aria-label="${u('change-player')}">⇄</a>${statusDot(data, stamp)}</span></h1>${progress ? `<p class="progress">${progress}</p>` : ''}${next ? `<p data-status="next">${next}</p>` : ''}</header>`];
  const out = [];
  let curDay = null;
  for (const e of events) {
    const t = e.t;
    const day = Number.isFinite(t) ? dayKey(t, e.ctx.tz) : null;
    if (day !== curDay) {
      curDay = day;
      out.push(`<h2>${esc(day === null ? u('time-tbd') : dayLabel(day))}</h2>`);
    }
    // the row itself, not the match id — ids are per-category, two cats can share one
    const isNext = e === nextEv;
    if (e.r) {
      out.push(matchCard(e.r.m, e.ctx, { meta: ['catName', 'label'], head: [{ key: 'time' }, { key: 'court' }], status: isNext ? 'next' : undefined, id: isNext ? 'next' : undefined }));
    } else {
      out.push(possibleCard(e.stage, e.ctx, { day: multi, id: isNext ? 'next' : undefined }));
    }
  }
  parts.push(`<section>${events.length ? `<div class="stack">${out.join('')}</div>` : `<p>${u('no-matches')}</p>`}</section>`);
  return parts.join('');
}

// Browser-tab title per view: the tournament tab is the event name.
function pageTitle(r, d) {
  if (r.view === 'index' || !d.t) return 'Bracket';
  if (r.view === 'tournament') return d.t.name;
  if (r.view === 'schedule') {
    if (r.player) {
      const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.player);
      if (p) return `${d.t.name} — ${p.name || p.id}`;
    }
    return `${d.t.name} — ${u('schedule')}`;
  }
  return `${d.t.name} — ${u('venue-board')}`; // the venues view names itself — the kiosk tab distinguishes boards from schedules
}

// The index loads once; every tournament view polls while the tab is visible.
function boot() {
  const app = document.querySelector('main');

  // The language is decided once per load: ?lang= wins, else the browser's first match.
  lang = resolveLang(location.hash, location.search);
  setLocale(lang);
  document.documentElement.lang = lang;

  // One clock read per render — the last success and the instant, handed to the renderers:
  // none of them reaches for a clock or a module variable.
  const renderers = { index: renderIndex, tournament: renderTournament, venues: renderVenue, schedule: renderPlayer };
  let route = null;    // current fragment route — the poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let lastPoll = 0;    // the last successful fetch, in real time — the freshness read's own input
  let pulse = null;    // { slug, hash } — the change detector behind the dot's flash
  let lastHtml = '';   // skip re-render when nothing changed (keeps selection/focus)
  let lastKey = '';    // view|cat — a change is new content, start at the top
  let pollTimer = null, clockTimer = null;
  let pollOn = false;  // view whose timers should run; false on the index
  // One request per page, by slug: a poll that fires mid-download is dropped, not re-fetched.
  // A load always settles inside FETCH_TIMEOUT_MS, so the slot can't stay stuck.
  const live = new Set();
  // Cold navigations only — a poll must never dim a board that is already up.
  // Counted, not flagged: a click on a second card keeps the page busy until the last settles.
  let navPending = 0;

  // Every view but the index auto-refreshes while visible; a return fetches immediately.
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  };
  const startPoll = () => {
    // The poll cadence belongs to the open page, not to a navigation — restarting it
    // here would let tab clicks postpone the next poll past the stale threshold.
    if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
    // The kiosk clock ticks between renders — a date stays static, only a time moves;
    // the element is looked up fresh since a poll may have rebuilt it. The play's
    // statuses and now-line ride the poll's render, not this timer.
    if (pollOn === 'venues' && !clockTimer) {
      clockTimer = setInterval(() => {
        const t = Date.now();
        const el = document.getElementById('clock');
        if (el && el.dataset.mode === 'time') {
          el.textContent = fmtTime(t, (data && data.tjson && data.tjson.timezone) || 'UTC');
          el.dateTime = new Date(t).toISOString(); // the instant, derived — the label stays wall clock
        }
      }, 1000);
    } else if (pollOn !== 'venues' && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };

  // The flash receipt: the attribute plays the animation once and leaves with it, so a
  // later render of the same element starts clean.
  const flashEl = el => {
    el.setAttribute('data-flash', '');
    el.addEventListener('animationend', () => el.removeAttribute('data-flash'), { once: true });
  };

  // The timers track the open view and the tab's visibility — the one policy both
  // navigation and the visibility event obey.
  const sync = () => {
    if (pollOn && !document.hidden) startPoll();
    else stopPoll();
  };

  // Any paint outside render's guard voids the memo — else a later identical render is suppressed.
  const paint = html => { app.innerHTML = html; lastHtml = ''; };

  const load = (r, nav) => {
    // r.slug is undefined on the index — key by view so slug-less routes can't collide.
    const key = r.slug || r.view;
    if (live.has(key)) return; // this page's answer is already on its way
    live.add(key);
    if (nav) { navPending += 1; setPending(app, true); } // only a navigation counts as pending — never tick's poll
    loadAll(r).then(d => {
      if (superseded(route, r)) return; // a different tournament won the race
      if (r.view === 'index') return d.failed ? paint(FAILED() + `<p>${u('reload')}</p>`) : render(route, d); // the index never 404s the tournament file
      if (d.httpError) {
        // a dead deep link — the file is gone for good; stop the futile poll
        pollOn = false;
        sync();
        if (!data) paint(BAD_LINK());
        return;
      }
      if (!d.tjson) { // transient fetch failure — the poll retries next tick
        if (data) render(route, data); // repaint so the stamp can name the failure
        else paint(MISSING() + `<p>${u('reload')}</p>`);
        return;
      }
      lastPoll = Date.now(); // the freshness read keys off the last success
      render(route, d);
    }, e => {
      // loadAll rejects only on repo data its model can't digest — degrade, never blank
      console.error(e);
      if (superseded(route, r)) return; // an abandoned route's failure can't blank the view that replaced it
      if (!data) paint(FAILED());
    }).finally(() => { live.delete(key); if (nav) { navPending -= 1; if (!navPending) setPending(app, false); } });
  };
  const tick = () => load(route);

  // Follow the wave, not the clock. The board stamps shown-day + the wave's start
  // minute; only when that target moves do we re-aim, so a poll that changes nothing
  // (or a later result that leaves the wave put) never yanks a manual scroll. The
  // tournament rides the key too: a hop to another board needs its own aim.
  let aimKey = null;
  const aim = () => {
    const board = document.querySelector('.board[data-follow]');
    if (!board) { aimKey = null; return; } // off the kiosk — a return re-aims
    const key = `${route ? route.slug : ''}|${board.dataset.follow}`;
    if (key === aimKey) return;
    aimKey = key;
    const target = board.querySelector('[data-aim]');
    if (!target) return; // nothing playable on this board
    // Reserve a card's worth above the target: ppm's floor makes every card at
    // least CARD_PX tall, so an abutting predecessor's tail fills the band below
    // the sticky header, and a taller one just tucks its top under the header.
    const top = target.getBoundingClientRect().top + window.scrollY - (HEADER_PX + CARD_PX + CARD_GAP);
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const render = (r, d) => {
    // the pulse keys on the file's content — a refetch is a new object every time
    const hash = d.tjson ? JSON.stringify(d.tjson) : null;
    const changed = hash !== null && changedTournament(pulse, r.slug, hash);
    if (hash !== null) pulse = { slug: r.slug, hash };
    data = d;
    // full-width board layout keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    // a view, category, or player change starts at the top; a venue hop keeps position
    const key = `${r.view}|${r.cat || ''}|${r.player || ''}`;
    const contentChanged = key !== lastKey;
    lastKey = key;
    try {
      document.title = pageTitle(r, d); // inside the guard: the never-throw invariant covers the title too
      const html = renderers[r.view](r, d, { at: lastPoll, now: Date.now() });
      if (html !== lastHtml) {
        app.innerHTML = html;
        lastHtml = html;
        // a changed file pulses the dot; the new element carries no flag, so the animation runs
        if (changed) { const dot = app.querySelector('.status'); if (dot) flashEl(dot); }
      }
      if (contentChanged) window.scrollTo(0, 0);
    } catch (e) {
      paint(FAILED());
      console.error(e);
    }
    aim(); // outside the guard — a scroll throw is not a render failure
  };

  // Fragment navigation: same-slug hops re-render from the cached snapshot.
  const navigate = () => {
    const r = parseRoute();
    if (!r) {
      route = null;
      pollOn = false; sync();
      document.body.classList.remove('venue'); // a dead link is not the kiosk — never inherit the board layout
      paintBadRoute(app);
      lastHtml = ''; // as in the render catch: a later cached re-render must repaint over the bad-link page
      return;
    }
    route = r;
    pollOn = r.view === 'index' ? false : r.view;
    sync();
    if (needsFetch(r, data)) {
      data = null;
      lastHtml = '';
      load(r, true);
    } else {
      render(r, data);
    }
  };

  // The receipt and the scroll target are the first spined card — a deep group
  // stage buries the wave below its heading, and the match the line names is what
  // the jump owes the user. Centering clears the sticky bars on both pages.
  const jumpTo = id => {
    const el = document.getElementById(id);
    if (!el) return;
    const boxes = document.querySelectorAll('article[data-status="next"]');
    const targets = boxes.length ? boxes : [el]; // a possible-stage jump has no spined card — the anchor stands in
    targets[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    targets.forEach(flashEl);
  };
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });

  navigate();
  window.addEventListener('hashchange', navigate);
  // a hidden tab stops polling entirely; a return fetches immediately
  document.addEventListener('visibilitychange', () => {
    if (pollOn && !document.hidden) tick();
    sync();
  });
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, resolveLang, loadAll, needsFetch, superseded, timeoutSignal, renderIndex, renderTournament, renderVenue, renderPlayer, paintBadRoute, setPending, pageTitle, freshness, changedTournament, LAG_MS, STALE_MS };
}
