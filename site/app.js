'use strict';

const POLL_MS = 30000;
const FOLLOW_MS = 60000; // the kiosk re-follows the play on this cadence, data change or not
// 135px = the card's measured height at base zoom; under-tune it and cards overlap
// their next slot. ponytail: re-tune on the wall screen beside the viewport floor.
const CARD_PX = 135;

// The kiosk-top header (h1 + stamp) at base zoom; a taller header clips the day's
// last card.
const HEADER_PX = 116;

// The viewport floor — never scale the board below this many px per minute.
const MIN_PX_PER_MIN = 1.6;

// Cards end this many px short of their slot so tops stay pinned and bottoms read as
// separate blocks; rendered inline because a content-driven flex wrapper won't shrink.
const CARD_GAP = 4;

// The fixed bottom clock chip's reserved band, so no card scrolls under it.
// ponytail: re-tune beside the header constant on the wall screen.
const CHIP_PX = 60;

// Under node the classic-script globals must be reproduced on globalThis.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./derive.js'));
  Object.assign(globalThis, require('./i18n.js'));
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

// Wall-clock minutes of an instant; the grid and now-line never use offsets.
const wallClockMin = (t, tz) => {
  const f = fmtTime(t, tz).split(':');
  return f.length === 2 ? +f[0] * 60 + +f[1] : null;
};

// The sim clock's aim: a day's first match, or the event's first when no day is
// given (or that day has none). Pure.
function simAimOffset(tjson, now, day) {
  const tz = tjson.timezone || 'UTC';
  const ts = Object.values(tjson.matches || {}).flat().map(m => m ? schedTime(m, tz) : NaN).filter(Number.isFinite);
  const onDay = day ? ts.filter(t => dayKey(t, tz) === day) : ts;
  const aim = onDay.length ? onDay : ts;
  return aim.length ? Math.min(...aim) - now : null;
}

// A dead deep link (httpError — permanent, stop polling) versus a transient
// network failure (null — the poll retries next tick).
const HTTP_ERR = { httpError: true };

async function fetchJson(url) {
  try {
    // cache: 'no-cache' revalidates — 304s return 0 bytes, changes arrive fresh
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) return await res.json();
    // only a gone-for-good link stops the poll — a 5xx returns null like any
    // network failure and the poll retries next tick
    if (res.status === 404 || res.status === 410) return HTTP_ERR;
    return null;
  } catch {
    return null; // network failure — the poll retries next tick
  }
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
    const index = Array.isArray(raw) ? raw : [];
    return { index };
  }
  // one file per tournament — a poll is a single atomic fetch
  const tjson = await fetchJson(`tournaments/${route.slug}.json`);
  if (tjson === HTTP_ERR) return { httpError: true };
  const t = tjson ? { slug: route.slug, name: tjson.name } : null;
  return { t, tjson, cats: toCats(tjson) };
}

const segmentBar = r => {
  const t = r.view === 'tournament', m = r.view === 'schedule';
  return `<nav class="segments" aria-label="${u('views')}"><a href="${esc(href(r.slug, 'tournament', r))}"${t ? ' aria-current="true"' : ''}>${u('tournament')}</a><a href="${esc(href(r.slug, 'schedule', r))}"${m ? ' aria-current="true"' : ''}>${u('schedule')}</a></nav>`;
};

const MISSING = () => `<p>${u('missing')}</p>`;

// A rejected fragment route or a slug whose file is a permanent 404.
const BAD_LINK = () => `<p>${u('bad-link')}</p><p><a href="#">${u('all-tournaments')}</a></p>`;

// Painted through a named seam so the branch is DOM-testable.
const paintBadRoute = el => { el.innerHTML = BAD_LINK(); };

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
      return `<div class="card-wrap"><a class="card" aria-label="${name}" href="#${esc(e.slug)}"><h2>${name}</h2>${meta ? `<p>${meta}</p>` : ''}</a><a class="chip board-link" target="_blank" rel="noopener" href="#${esc(e.slug)}/venues">${u('venue-board')}</a></div>`;
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
    return `<a href="${esc(href(slug, 'tournament', p))}"${activeId === c.id ? ' aria-current="true"' : ''}>${esc(c.name || c.id)}</a>`;
  }).join('');
};

// The polling views' shared stamp; a changed file flashes the line, a failing poll names its state.
let stampSnap = null; // { slug, hash } — the change detector behind the flash
function updateStamp(data, tz) {
  const hash = JSON.stringify(data.tjson);
  const flash = !!stampSnap && stampSnap.slug === data.t.slug && stampSnap.hash !== hash;
  stampSnap = { slug: data.t.slug, hash };
  const stale = !lastPoll || Date.now() - lastPoll > POLL_MS * 2;
  const when = lastPoll ? fmtTime(lastPoll, tz) : '—';
  const stamp = `<time datetime="${lastPoll ? new Date(lastPoll).toISOString() : ''}">${u('updated', { time: when })}</time>${stale ? ` · <span role="status">${esc(u('reconnect'))}</span>` : ''}`;
  return `<p class="meta"${flash ? ' data-flash' : ''}${stale ? ' data-status="stale"' : ''}>${stamp}</p>`;
}

const HOME_LINK = () => `<a class="chip" href="#" aria-label="${u('tournaments')}">⎋</a>`;

function renderTournament(route, data) {
  if (!data.tjson) return MISSING();
  const tz = data.tjson.timezone || 'UTC';
  const ctxs = data.cats;
  const show = ctxs.find(c => c.id === route.cat) || ctxs[0]; // an unknown cat falls back to the first
  const days = schedDays(ctxs.flatMap(c => c.matches), tz); // one scan: the span and the multi-day cue read the same set
  const multi = days.length > 1;
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}${HOME_LINK()}</h1>`];
  // the heading states the span and the location once — single-day cards never repeat the date
  const range = fmtRange(days);
  parts.push(`<p>${[range, esc(data.tjson.location)].filter(Boolean).join(' · ')}</p>${updateStamp(data, tz)}</header>`);
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
        const bo1 = poolBo1(ctx, pool); // GD restates W−L in a best-of-1 pool — drop the column, keep PD
        const gdHead = bo1 ? '' : '<th scope="col" class="num">GD</th>';
        parts.push(`<table><thead><tr><th scope="col" class="num">#</th><th scope="col">Team</th><th scope="col" class="num">W</th><th scope="col" class="num">L</th>${gdHead}<th scope="col" class="num">PD</th></tr></thead><tbody>`);
        const std = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
        const ranks = poolDecided(std) ? poolRanks(std) : null;
        std.forEach((r, i) => {
          const team = teamLabel(r.ids, ctx);
          const gdCell = bo1 ? '' : `<td class="num">${fmtDiff(r.gd)}</td>`;
          parts.push(`<tr><td class="num">${ranks ? ranks[i] : ''}</td><td>${esc(team)}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td>${gdCell}<td class="num">${fmtDiff(r.pd)}</td></tr>`);
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
  const main = ko.filter(m => placementLabel(m, ctx) === null);
  const placement = ko.filter(m => placementLabel(m, ctx) !== null);
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

// Join a stage slot list with '/'; empty → null (callers render TBD).
const stageBit = (list, fmt) => list?.length ? list.map(fmt).join('/') : null;

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
  return `<article${opts.id ? ` id="${opts.id}"` : ''}${opts.status ? ` data-status="${opts.status}"` : ''}${opts.style ? ` style="${opts.style}"` : ''}>${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
}

function sideRow(m, ctx, i) {
  const w = winnerIdx(m);
  // a malformed match (missing sides) renders TBD rows, never takes the board down
  const side = m.sides && m.sides[i];
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${esc(sideLabel(side, ctx))}</span>${w === i ? `<span class="winmark" aria-label="${u('won')}">✓</span>` : ''}<span class="score">${scoreCells(m, i, ctx)}</span></div>`;
}

function renderVenue(route, data, now, simOn) {
  if (!data.tjson) return MISSING();
  const v = route.venue;
  const rows = [];
  const ctxs = data.cats;
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
  // sharedFacts' map, never rebuilt
  const venueNames = ctxs.length ? ctxs[0].venues : new Map();
  const cols = declared.map(v => v.id).filter(id => open.some(r => r.m.venue === id));
  // the clock is the board's only control: a bare time on a match day, the shown
  // day's date otherwise — click the date to sim that day, the running time to stop
  // (the stamp carries the real last-fetch; only its stale state is a live region)
  const dayText = fmtRange([shownDay]); // null when the day or tz is unreadable
  const time = esc(fmtTime(now, tz));
  const clock = isMatchDay && !simOn
    ? `<time id="clock" data-mode="time">${time}</time>`
    : simOn || dayText
      ? `<button type="button" id="clock" data-sim-toggle data-mode="${simOn ? 'time' : 'date'}"${simOn ? '' : ` data-day="${esc(shownDay)}"`}>${simOn ? time : esc(dayText)}</button>`
      : '';
  const simHint = simOn ? `<span class="sim-hint">${u('sim-hint')}</span>` : '';
  // the title carries the same trail link as the tournament page; the clock is a
  // fixed bottom chip so it never competes with the title for width
  const header = `<header><h1>${esc(data.t.name)}${HOME_LINK()}</h1>${updateStamp(data, tz)}</header>`;
  const chip = clock ? `<div class="kiosk-clock">${clock}${simHint}</div>` : '';
  // header and venue titles stick as one block, aligned by the shared --cols track
  const top = `<div class="kiosk-top" style="--cols: ${cols.length}">${header}${cols.map(id => `<h2>${esc(venueNames.get(id) || id)}</h2>`).join('')}</div>`;
  if (!cols.length) return top + `<p>${u('nothing')}</p>` + chip;
  // Wall-clock minutes drive the layout, never offsets. One window per row feeds the
  // frame, scale, and placement; a missing slot length leaves e null.
  const win = open.map(r => {
    const s = wallClockMin(r.t, r.ctx.tz);
    const sl = matchSlotMs(r.m, r.ctx) / 60000;
    return { r, s, e: Number.isFinite(sl) ? s + sl : null };
  }).filter(w => Number.isFinite(w.s)); // a null/NaN wall minute would NaN the day's frame — keep it off the layout
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
  // the fixed bottom clock chip owns its own band, same as the sticky header above
  const ppm = Math.max(MIN_PX_PER_MIN, avail ? (avail - HEADER_PX - CHIP_PX) / total : 0, (CARD_PX + CARD_GAP) / sShort);
  const y = min => (min - dayStart) * ppm;
  const card = (r, h) => {
    const status = kioskStatus(r, now);
    const when = timeEl(r.t, r.ctx.tz);
    const flag = status === 'now' ? u('now') : status === 'overdue' ? u('overdue') : ''; // the status word is the flag; done and upcoming cards show none
    return matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
      head: [{ html: when }, { html: flag }], status, style: `height:${h}px` });
  };
  // Cards sit at their wall-clock top; the scroll target is the now-line.
  const placed = w => {
    const { r, s, e } = w;
    return `<div class="bcard" style="top:${y(s)}px">${card(r, e !== null ? (e - s) * ppm - CARD_GAP : CARD_PX)}</div>`;
  };
  const dayH = Math.ceil(total * ppm);
  const nowMin = wallClockMin(now, tz);
  // The line is the day's "now" — it exists only while the board's day is today;
  // on any other day there is nothing for aim() to follow.
  const nowY = nowMin !== null && dayKey(now, tz) === shownDay ? Math.min(Math.max(y(nowMin), 0), dayH) : null;
  return top + `<div class="board" style="--cols: ${cols.length}; --day-h: ${dayH}">${nowY !== null ? `<div class="now" id="now-line" style="top:${nowY}px"></div>` : ''}${cols.map((id, i) => `<div class="col" style="grid-column: ${i + 1}">${byVenue.get(id).map(placed).join('')}</div>`).join('')}</div>` + chip;
}

// Do scheduled matches span more than one wall-clock day? Gates the date on cards.
const multiDay = ctxs => schedDays(ctxs.flatMap(c => c.matches), (ctxs[0] && ctxs[0].tz) || 'UTC').length > 1;


// The last successful fetch, in real time — never the sim clock.
let lastPoll = 0;

// The round a player could reach once the pools decide; the chip carries the rank
// or outcome that gets in.
function possibleCard(stage, ctx, opts) {
  const when = stageBit(stage.times, t => timeEl(t, ctx.tz, opts.day)) ?? '<span class="tbd">TBD</span>';
  const where = stageBit(stage.courts, c => esc(venueName(ctx, c))) ?? '<span class="tbd">TBD</span>';
  const label = esc(stage.label);
  return `<article${opts.id ? ` id="${opts.id}"` : ''} data-status="possible"><div class="head"><span>${when}</span><span>${where}</span></div><div class="meta">${catChip(ctx)} · ${label}</div>${stage.chip ? `<div class="meta">(${esc(stage.chip)})</div>` : ''}</article>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return MISSING();
  const players = (Array.isArray(data.tjson.players) ? data.tjson.players : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = route.player ? players.find(x => x.id === route.player) : null;
  return p ? playerSchedule(route, data, p) : playerPicker(route, data, players);
}

// Only participants are pickable, so a pick always renders a schedule; one
// alphabetical card per player — its meta names every category they play in, so
// a player in three categories is still one card.
function playerPicker(route, data, players) {
  const cards = players
    .map(pl => ({ pl, cats: data.cats.filter(c => playerMatches(c, pl.id).length) }))
    .filter(x => x.cats.length)
    .sort((a, b) => String(a.pl.name || a.pl.id).localeCompare(String(b.pl.name || b.pl.id)))
    .map(({ pl, cats }) => {
      const name = esc(pl.name || pl.id);
      return `<a class="card" aria-label="${name}" href="${esc(href(data.t.slug, 'schedule', { ...route, player: pl.id }))}"><h2>${name}</h2><p>${cats.map(catChip).join(' · ')}</p></a>`;
    });
  const head = `${segmentBar(route)}<header><h1>${u('pick-player')}</h1></header>`;
  return cards.length ? `${head}<section class="grid">${cards.join('')}</section>` : head + `<p>${u('no-players')}</p>`;
}

// One flat timeline for the picked player: confirmed matches and possible stages.
function playerSchedule(route, data, p) {
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
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}<a class="chip" href="${esc(href(data.t.slug, 'schedule', { ...route, player: null }))}" aria-label="${u('change-player')}">⇄</a></h1>${updateStamp(data, data.tjson.timezone || 'UTC')}${progress ? `<p class="progress">${progress}</p>` : ''}${next ? `<p data-status="next">${next}</p>` : ''}</header>`];
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

// The sim clock's state — the board's clock button toggles it, j/k step it, Esc ends it.
function mountSimClock({ tjsonOf, onChange }) {
  const SIM_KEY = 'gitbracket.sim.offset';
  const simOffset = () => Number(localStorage.getItem(SIM_KEY)) || 0;
  const simOn = () => localStorage.getItem(SIM_KEY) !== null;
  const now = () => Date.now() + simOffset();
  // a clock change re-renders the board — statuses and the now-line recompute
  const step = ms => { localStorage.setItem(SIM_KEY, String(simOffset() + ms)); onChange(); };
  const toggle = day => {
    if (simOn()) localStorage.removeItem(SIM_KEY);
    else localStorage.setItem(SIM_KEY, String(simAimOffset(tjsonOf() || {}, Date.now(), day) || 0));
    onChange();
  };
  window.addEventListener('keydown', e => {
    if (!simOn() || !document.body.classList.contains('venue')) return; // the keys move the board's clock, and only where it is
    if (e.key === 'j') { e.preventDefault(); step(5 * 60000); } // j drops the now line later, k rewinds it
    else if (e.key === 'k') { e.preventDefault(); step(-5 * 60000); }
    else if (e.key === 'Escape') { e.preventDefault(); toggle(); }
  });
  return { simOn, now, step, toggle };
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

  // The sim clock drives now() and the venue board's clock controls.
  const sim = mountSimClock({
    tjsonOf: () => data && data.tjson,
    onChange: () => { if (data && route) render(route, data); },
  });
  const now = sim.now;

  const renderers = { index: renderIndex, tournament: renderTournament, venues: (r, d) => renderVenue(r, d, now(), sim.simOn()), schedule: renderPlayer };
  let route = null;    // current fragment route — the poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let lastHtml = '';   // skip re-render when nothing changed (keeps selection/focus)
  let lastKey = '';    // view|cat — a change is new content, start at the top
  let lastFollow = 0;  // last minute-tick re-follow — tracks the play even when data never changes
  let pollTimer = null, clockTimer = null;
  let pollOn = false;  // view whose timers should run; false on the index

  // Every view but the index auto-refreshes while visible; a return fetches immediately.
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  };
  const startPoll = () => {
    stopPoll();
    pollTimer = setInterval(tick, POLL_MS);
    if (pollOn === 'venues') {
      // The clock's label lives in an element the change-guard never re-renders;
      // look it up fresh each tick — a date stays static, only a time ticks.
      clockTimer = setInterval(() => {
        const t = now();
        const el = document.getElementById('clock');
        if (el && el.dataset.mode === 'time') {
          el.textContent = fmtTime(t, (data && data.tjson && data.tjson.timezone) || 'UTC');
          el.dateTime = new Date(t).toISOString(); // the instant, derived — the label stays wall clock
        }
        // once a minute, re-follow from the last snapshot — statuses and the
        // now-line recompute against now
        if (t - lastFollow >= FOLLOW_MS && data) {
          lastFollow = t;
          render(route, data);
        }
      }, 1000);
    }
  };

  const load = r => {
    loadAll(r).then(d => {
      if (route !== r) return; // superseded by a newer navigation
      if (r.view === 'index') return render(r, d); // the index never 404s the tournament file
      if (d.httpError) {
        // a dead deep link — the file is gone for good; stop the futile poll
        stopPoll();
        if (!data) app.innerHTML = BAD_LINK();
        return;
      }
      if (!d.tjson) { // transient fetch failure — the poll retries next tick
        if (!data) app.innerHTML = MISSING() + `<p>${u('reload')}</p>`;
        return;
      }
      lastPoll = Date.now(); // the freshness stamp reads the last success, never the sim clock
      render(r, d);
    }, e => {
      // loadAll rejects only on repo data its model can't digest — degrade, never blank
      console.error(e);
      if (!data) app.innerHTML = FAILED();
    });
  };
  const tick = () => load(route);

  // Centre the now-line on every render; the clock handler re-aims on its
  // own minute.
  const aim = () => {
    const ln = document.getElementById('now-line');
    if (ln) ln.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const render = (r, d) => {
    data = d;
    // full-width board layout keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    // a view, category, or player change starts at the top; a venue hop keeps position
    const key = `${r.view}|${r.cat || ''}|${r.player || ''}`;
    const contentChanged = key !== lastKey;
    lastKey = key;
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
      if (contentChanged) window.scrollTo(0, 0);
    } catch (e) {
      app.innerHTML = FAILED();
      lastHtml = ''; // the memo is void once the DOM is painted outside the guard — a later identical render must repaint
      console.error(e);
    }
    aim();
  };

  // Fragment navigation: same-slug hops re-render from the cached snapshot.
  const navigate = () => {
    const r = parseRoute();
    if (!r) {
      route = null;
      pollOn = false; stopPoll();
      document.body.classList.remove('venue'); // a dead link is not the kiosk — never inherit the board layout
      paintBadRoute(app);
      lastHtml = ''; // as in the render catch: a later cached re-render must repaint over the bad-link page
      return;
    }
    route = r;
    pollOn = r.view === 'index' ? false : r.view;
    if (pollOn && !document.hidden) startPoll(); else stopPoll();
    if (r.view === 'index' || !(data && data.t && data.t.slug === r.slug)) { // index has no t — always reloads; a snapshot's t carries its slug
      data = null;
      lastHtml = '';
      load(r);
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
    targets.forEach(box => {
      box.setAttribute('data-flash', '');
      box.addEventListener('animationend', () => box.removeAttribute('data-flash'), { once: true });
    });
  };
  document.addEventListener('click', e => {
    const toggle = e.target.closest('button[data-sim-toggle]');
    if (toggle) return sim.toggle(toggle.dataset.day);
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });

  navigate();
  window.addEventListener('hashchange', navigate);
  // a hidden tab stops polling entirely; a return fetches immediately
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else if (pollOn) { tick(); startPoll(); }
  });
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, resolveLang, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer, simAimOffset, paintBadRoute, pageTitle };
}
