'use strict';

const POLL_MS = 30000;
const FOLLOW_MS = 60000; // the kiosk re-follows the play on this cadence, data change or not
const RECENT_MS = 2 * 60 * 1000; // how long a completed result stays on the kiosk's latest line
// The dense-day floor for the kiosk calendar: one card-height per shortest
// slot, so a 10-min slot day renders as a walkable strip, a 60-min day as a
// screen. 135px is the card's measured height at base zoom — under-tune it
// and cards overlap their next slot. ponytail: re-tune on the wall screen
// with the 1.6px/min floor and the 140px header allowance beside it.
const CARD_PX = 135;

// The seam between stacked cards: each card's box ends this many px short of
// its slot, so tops stay pinned to the start minute and bottoms read as
// separate blocks. Rendered inline — the flex wrapper can't be trusted to
// shrink (its height is content-driven).
const CARD_GAP = 4;

// derive.js loads first as a classic script, so its names are already page
// globals; under node, the module lands on globalThis.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./derive.js'));
  Object.assign(globalThis, require('./i18n.js'));
}

// The venue's display name — a missing id (hand-edited or staged) falls back to the id.
const venueName = (ctx, id) => ctx.venues.get(id) || id;

// The page language, resolved once at boot (?lang= wins, else the browser's,
// else English); renders read it through u(). Node tests never boot, so they
// stay English by default.
let lang = 'en';
const u = (k, p) => t(lang, k, p);
// The override is accepted in either query position — the fragment (`#s?lang=de`,
// the form that rides the links) or the URL (?lang=de#s, where people type it);
// neither present, the browser's language decides. lang stays 'en' under node.
// A language is usable only when its bundle ships — anything else is en, so a
// half-translated page never renders (t() and derive's dispatchers agree on
// the same fallback).
const resolveLang = (hash, search) => {
  const r = parseRoute(hash);
  if (r && r.lang) return I18N[r.lang] ? r.lang : 'en';
  const v = new URLSearchParams(search).get('lang');
  if (/^[a-z]{2}$/i.test(v || '')) { const l = v.toLowerCase(); return I18N[l] ? l : 'en'; }
  if (typeof navigator === 'undefined') return 'en';
  for (const l of navigator.languages || [navigator.language]) {
    const m = /^([a-z]{2})/i.exec(l || '');
    if (m && I18N[m[1].toLowerCase()]) return m[1].toLowerCase();
  }
  return 'en';
};

// Wall-clock minutes of an instant — the day grid and the now-line both live
// in wall minutes, never offsets.
const wallClockMin = (t, tz) => {
  const f = fmtTime(t, tz).split(':');
  return f.length === 2 ? +f[0] * 60 + +f[1] : null;
};

// The sim clock's aim: land it on the event's first scheduled match, so the
// kiosk opens where the tournament starts. Pure — tests pin it.
function simAimOffset(tjson, now) {
  const tz = tjson.timezone || 'UTC';
  const ts = Object.values(tjson.matches || {}).flat().map(m => m ? schedTime(m, tz) : NaN).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) - now : null;
}

// A dead deep link (the slug's file 404s — permanent, stop polling) versus a
// transient network failure (null — the poll retries next tick).
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

// One page, fragment routing: #<slug>[/schedule|venues][?cat=&player=&venue=].
// Segments and params are id-regex-checked — raw input never reaches a URL;
// unknown names and bad values are ignored, never fatal. Cat is a param, never
// a path segment, so a category id can't shadow a view.
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
    if (k === 'lang') { if (/^[a-z]{2}$/i.test(v)) r.lang = v.toLowerCase(); continue; }
    if (v && ID_RE.test(v)) r[k] = v;
  }
  return r;
}

// Fragment URLs with params in fixed order. cat and player ride along between
// tournament and schedule so switching keeps the focus and Schedule restores
// the pick; the kiosk carries only venue.
const CARRY = ['cat', 'player', 'lang']; // the tournament and schedule views carry the pick between them
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

// The one missing-data message, verbatim in every view.
const MISSING = () => `<p>${u('missing')}</p>`;

// The one bad-route message, verbatim wherever a dead link lands: a rejected
// fragment route, or a slug whose tournament file is a permanent 404.
const BAD_LINK = () => `<p>${u('bad-link')}</p><p><a href="#">${u('all-tournaments')}</a></p>`;

// The invalid-route page, painted through a named seam so the branch is DOM-testable — it once shipped the builder's source.
const paintBadRoute = el => { el.innerHTML = BAD_LINK(); };

// The one failed-render message, verbatim in the renderer's catch and the
// load path — data the model can't digest never blanks the page.
const FAILED = () => `<p>${u('failed')}</p>`;


const matchGrid = (ms, ctx, day, next) => `<div class="grid">${ms.map(m => matchCard(m, ctx, { meta: ['label', 'court', 'time'], day, status: next && next(m) ? 'next' : undefined })).join('')}</div>`;

// Date leads, undated entries defer to the end, ties hold index order (stable sort).
function renderIndex(route, data) {
  const items = data.index
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
      return `<div class="tcard-wrap"><a class="tcard" aria-label="${name}" href="#${esc(e.slug)}"><h2>${name}</h2>${meta ? `<p>${meta}</p>` : ''}</a><a class="board-link" target="_blank" rel="noopener" href="#${esc(e.slug)}/venues">${u('venue-board')}</a></div>`;
    });
  if (!items.length) return `<header><h1>${u('tournaments')}</h1><p>${u('no-tournaments')}</p></header>`;
  // the home-screen tip lives muted in the header once — .meta is the existing
  // de-emphasis; a new class needn't exist
  return `<header><h1>${u('tournaments')}</h1><p class="meta">${u('tip')}</p></header><section class="stack">${items.join('')}</section>`;
}

// One category per page; the switcher is the navigation — the first category
// stays canonical at the bare slug, the rest select via ?cat=.
const catNav = (slug, ctxs, route) => {
  // an unknown cat renders the first category — the tabs must agree with the page
  const activeId = route.cat && ctxs.some(x => x.id === route.cat) ? route.cat : ctxs[0]?.id;
  return ctxs.map((c, i) => {
    const p = { ...route, cat: i === 0 ? undefined : c.id };
    return `<a href="${esc(href(slug, 'tournament', p))}"${activeId === c.id ? ' aria-current="true"' : ''}>${esc(c.name || c.id)}</a>`;
  }).join('');
};

// The tournament views' change cue: a poll that actually changed the file
// flashes "Updated HH:MM" for one cycle — proof the page refreshes itself,
// gone the moment nothing changed. One baseline per slug.
let viewSnap = null; // { slug, hash, changedAt }
function updatedLine(data, tz) {
  const hash = JSON.stringify(data.tjson);
  const now = Date.now();
  if (!viewSnap || viewSnap.slug !== data.t.slug) { viewSnap = { slug: data.t.slug, hash, changedAt: 0 }; return ''; }
  if (viewSnap.hash !== hash) { viewSnap.hash = hash; viewSnap.changedAt = now; }
  return now - viewSnap.changedAt < POLL_MS ? `<p class="meta">${u('updated', { time: fmtTime(viewSnap.changedAt, tz) })}</p>` : '';
}

function renderTournament(route, data) {
  if (!data.tjson) return MISSING();
  const tz = data.tjson.timezone || 'UTC';
  const ctxs = data.cats;
  const show = ctxs.find(c => c.id === route.cat) || ctxs[0]; // an unknown cat falls back to the first
  const multi = multiDay(ctxs);
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}<a href="#">${u('tournaments')}</a></h1>`];
  // the heading states the span and the location once — single-day cards never repeat the date
  const range = fmtRange(schedDays(ctxs.flatMap(c => c.matches), tz));
  parts.push(`<p>${[range, esc(data.tjson.location)].filter(Boolean).join(' · ')}</p>${updatedLine(data, tz)}</header>`);
  parts.push(`<nav class="cats" aria-label="${u('categories')}">${catNav(data.t.slug, ctxs, route)}</nav>`);
  // a tournament with no categories (hand-edited or staged) renders the shell — "missing data renders empty", never a throw
  if (show) parts.push(catSection(show, { multi, href: href(data.t.slug, 'tournament', route) }));
  return parts.join('');
}

// The status line is progress only, linkless — the page's one link lives in the
// anticipation (Next) line. Nothing played is zero progress, so the first stage
// always has a status.
const statusLine = (status, ctx) => {
  if (!status) return '';
  if (status.kind === 'groups') return `<p>${u('group-status', { played: status.played, count: status.count })}</p>`;
  if (status.kind === 'ko') {
    if (status.wave === null) return `<p>${u('ko-remain')}</p>`;
    return `<p>${u('ko-round', { round: esc(stageGroupName(roundName(status.wave), bandLabels(ctx, status.wave))) })}</p>`;
  }
  if (status.kind === 'finished') return `<p data-status="finished">${u('finished')}</p>`;
  // winners: one line per place, third only when a bronze decided it — 4th is
  // omitted, only the top 3 get awards
  return [[u('champion'), status.first], [u('runner-up'), status.second], [u('rank3'), status.third]]
    .filter(([, ids]) => ids)
    .map(([rank, ids]) => `<p>${rank}: <strong>${esc(teamLabel(ids, ctx))}</strong></p>`)
    .join('');
};

// Compact court list — a round plays several matches at once, so "next" is a
// block, not a card. Consecutive numbered courts collapse ("Court 1–5"): the
// shared head stays singular, so a German venue name ("Halle 1") isn't forced
// into an English plural.
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

// The anticipation line: "Next" at every stage — bracket and schedule share
// the word; data-only, never the clock (the 30s poll keeps it current).
const anticipationLine = (ctx, status, href, day, wave) => {
  if (!status || status.kind === 'finished' || status.kind === 'winners') return '';
  if (!wave.length) return ''; // no playable match (feeders undecided): the progress line carries the page
  const m0 = wave[0];
  const courts = [...new Set(wave.map(m => m.venue ? venueName(ctx, m.venue) : null).filter(Boolean))];
  // fmtCourts is repo data — the same esc contract as every other name on the page
  const where = courts.length ? ` · ${esc(fmtCourts(courts))}` : '';
  // the jump target is the section the wave lives in
  const section = status.kind === 'groups' ? 'group-matches' : status.wave !== null ? `ko-${status.wave}` : '';
  const body = u('next', { body: `${timeEl(schedTime(m0, ctx.tz), ctx.tz, day)}${where}` });
  // the whole line is the link — a full-size tap target, same as the schedule page
  return section ? `<p data-status="next"><a data-jump="${section}" href="${esc(href)}">${body}<span aria-hidden="true"> ↓</span></a></p>` : `<p>${body}</p>`;
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


// Bracket order first: a card's position must match its QF/SF ordinal, which
// schedule edits can't move. Time breaks ties and orders unnumbered matches;
// a TBD-time match trails (Infinity), like every other time-ordered list.
const koOrder = (ms, ctx) => [...ms].sort((a, b) =>
  (koOrdinal(a, ctx) || Infinity) - (koOrdinal(b, ctx) || Infinity) ||
  (schedTime(a, ctx.tz) ?? Infinity) - (schedTime(b, ctx.tz) ?? Infinity));

// By prize (3rd before 5th) then time — rank is structural, view-stable;
// koOrdinal numbers only the championship tree.
const placeOrder = ctx => (a, b) =>
  ((plRange(a, ctx) || {}).lo ?? Infinity) - ((plRange(b, ctx) || {}).lo ?? Infinity) ||
  (schedTime(a, ctx.tz) ?? Infinity) - (schedTime(b, ctx.tz) ?? Infinity);

// Brackets merged by depth band: each column holds the round's matches plus the
// classification matches at the same edge count — the bronze under the Final's
// heading ("Final / 3rd place"), the 5th–8th semis under the Semifinals'.
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

// opts.meta picks the meta items (fixed vocabulary); opts.head is an optional
// [left, right] headline row — a cell is { key: item field } or { html: pre-rendered }.
function matchCard(m, ctx, opts = {}) {
  const t = schedTime(m, ctx.tz);
  const item = {
    catName: esc(ctx.name),
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
  // a malformed match (missing sides) renders TBD rows — the gate reports the
  // file, the renderer must never take the board down with it
  const side = m.sides && m.sides[i];
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${esc(sideLabel(side, ctx))}</span>${w === i ? `<span class="winmark" aria-label="${u('won')}">✓</span>` : ''}<span class="score">${scoreCells(m, i, ctx)}</span></div>`;
}

function renderVenue(route, data, now) {
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
  // courts with no matches are simply absent
  const shown = v ? rows.filter(r => r.m.venue === v) : rows;
  const tz = data.tjson.timezone || 'UTC';
  const today = dayKey(now, tz); // one day per screen — an overnight board must not list yesterday
  const firstDay = rows.length ? dayKey(rows[0].t, rows[0].ctx.tz) : null; // rows are time-sorted above — the first instant's day
  const lastDay = rows.length ? dayKey(rows.at(-1).t, rows.at(-1).ctx.tz) : null; // … and the last instant's
  // No "today" inside the event's span: before day one preview day one, after
  // the last day show its board — "Today · Nothing scheduled." reads stale
  const shownDay = firstDay && today < firstDay ? firstDay : lastDay && today > lastDay ? lastDay : today;
  const open = shown.filter(r => dayKey(r.t, r.ctx.tz) === shownDay); // the full day stays on the board; the scroll follows the current slot
  // the day's columns: declared courts with matches on it — a match on a
  // venue the file never declares (the gate reports it) renders absent
  const declared = (data.tjson.venues || []).filter(venue => venue && typeof venue === 'object');
  // the same map every category context already carries (sharedFacts) — never rebuilt
  const venueNames = ctxs.length ? ctxs[0].venues : new Map();
  const cols = declared.map(v => v.id).filter(id => open.some(r => r.m.venue === id));
  // the header's foot: one line, the freshness stamp (never the sim clock)
  // holding the latest results — the board must not look live while polls
  // fail; the live region stays scoped to the ticker, so the stamp, which
  // churns every poll, never announces itself
  const rec = venueRecency(data, data.cats);
  const recText = rec.length ? rec.slice(0, 3).map(e => e.text).join(' · ') + (rec.length > 3 ? ` · ${u('more', { n: rec.length - 3 })}` : '') : '';
  const stale = Date.now() - lastPoll > POLL_MS * 2;
  const stamp = `${u('updated', { time: fmtTime(lastPoll, tz) })}${stale ? ` · ${u('reconnect')}` : ''}`;
  const ticker = `<span aria-live="polite">${recText ? ` · ${esc(recText)}` : ''}</span>`;
  const header = `<header><div><h1>${esc(data.t.name)}</h1><p>${shownDay === today ? u('today') : dayLabel(shownDay)}</p><p class="meta"${stale ? ' data-status="stale"' : ''}>${esc(stamp)}${ticker}</p></div><time id="clock"></time></header>`;
  // header and venue titles stick as one block — the titles ride the running
  // clock, aligned to the board by the shared --cols track
  const top = `<div class="kiosk-top" style="--cols: ${cols.length}">${header}${cols.map(id => `<h2>${esc(venueNames.get(id) || id)}</h2>`).join('')}</div>`;
  if (!cols.length) return top + `<p>${u('nothing')}</p>`;
  // Wall-clock minutes drive the day's layout — never instants or offsets, so
  // the board stays right if DST rules change. One window per row (start +
  // slot end) feeds the frame, the scale, and the placement alike. A missing
  // slot length (hand-edited data — the gate tolerates it) leaves e null.
  const win = open.map(r => {
    const s = wallClockMin(r.t, r.ctx.tz);
    const sl = matchSlotMs(r.m, r.ctx) / 60000;
    return { r, s, e: Number.isFinite(sl) ? s + sl : null };
  }).filter(w => w.s !== null); // a null wall minute would NaN the day's frame (Math.min coerces null to 0) — keep it off the layout
  const byVenue = new Map(cols.map(id => [id, []]));
  for (const w of win) {
    const list = byVenue.get(w.r.m.venue);
    if (list) list.push(w);
  }
  // The day's frame: first start to last slot end, padded to a quarter-hour so
  // the first/last cards breathe.
  let dayStart = Math.min(...win.map(w => w.s));
  const endMax = Math.max(...win.map(w => w.e ?? -Infinity));
  let dayEnd = Number.isFinite(endMax) ? endMax : dayStart + 60;
  dayStart = Math.floor((dayStart - 15) / 15) * 15;
  dayEnd = Math.ceil((dayEnd + 15) / 15) * 15;
  if (dayStart < 0) dayStart = 0;
  // Scale: sparse days spread to the screen, dense days to one card per slot —
  // one rule for any slot length, so a 60-min match reads six times a 10-min
  // one and the shortest card always fits. (30: no known slot lengths)
  const sShort = Math.min(...win.filter(w => w.e !== null).map(w => w.e - w.s), 30);
  const total = dayEnd - dayStart; // ≥ 30 by the quarter-hour padding — never 0
  const avail = typeof document !== 'undefined' ? document.documentElement.clientHeight : 0;
  const ppm = Math.max(1.6, avail ? (avail - 140) / total : 0, CARD_PX / sShort);
  const y = min => (min - dayStart) * ppm;
  const card = (r, h) => {
    const status = kioskStatus(r, now);
    const when = timeEl(r.t, r.ctx.tz);
    const flag = status === 'now' ? u('now') : status === 'overdue' ? u('overdue') : ''; // the status word is the flag; done and upcoming cards show none
    return matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
      head: [{ html: when }, { html: flag }], status, style: `height:${h}px` });
  };
  // Cards sit at their wall-clock top; ordering can't drift. The follow's
  // scroll target is the now-line — the render places it at the wall-minute y.
  const placed = w => {
    const { r, s, e } = w;
    return `<div class="bcard" style="top:${y(s)}px">${card(r, (e !== null ? (e - s) * ppm : CARD_PX) - CARD_GAP)}</div>`;
  };
  const dayH = Math.ceil(total * ppm);
  const nowMin = wallClockMin(now, tz);
  // The line sits at the wall-minute y while the clock is in the shown day;
  // a clock on any other day has no wall minute here, so the line pins to the
  // day's top (before) or bottom (after) — the follow rests at the day's
  // start or end instead of wandering mid-board on a stray date.
  const nowDay = dayKey(now, tz);
  let nowY = null;
  if (nowMin !== null && nowDay !== null) {
    nowY = nowDay === shownDay ? Math.min(Math.max(y(nowMin), 0), dayH) : nowDay < shownDay ? 0 : dayH;
  }
  return top + `<div class="board" style="--cols: ${cols.length}; --day-h: ${dayH}">${nowY !== null ? `<div class="now" id="now-line" style="top:${nowY}px"></div>` : ''}${cols.map((id, i) => `<div class="col" style="grid-column: ${i + 1}">${byVenue.get(id).map(placed).join('')}</div>`).join('')}</div>`;
}

// Do scheduled matches span more than one wall-clock day? Gates the date on
// match cards — single-day pages state the date once. (Same day-key source as
// the index's stored dates.)
const multiDay = ctxs => schedDays(ctxs.flatMap(c => c.matches), (ctxs[0] && ctxs[0].tz) || 'UTC').length > 1;


// ---- the kiosk's freshness + latest-results state. Renderer bookkeeping, not
// domain — module state the venue view owns; kept per slug, so a hop away and
// back compares against the last visit instead of announcing from zero.
let lastPoll = 0; // real time of the last successful fetch — never the sim clock
const slugSnap = new Map(); // slug -> { done: Map } — previous poll's done-ness per match
const slugRecent = new Map(); // slug -> [{ text, at }] — completed results, pruned at render

// One completed match's announcement: court · wall time · winner (or void).
const resultText = (ctx, m) => {
  const t = schedTime(m, ctx.tz);
  const when = t !== null ? fmtTime(t, ctx.tz) : 'TBD';
  const where = m.venue ? venueName(ctx, m.venue) : 'TBD';
  const w = winnerIdx(m);
  // a scored match with no sides (invalid via the gate, but the recency line
  // must not die on it — bad-sides-knockout's played m5 has none)
  const s = m.sides && m.sides[w];
  return w === null ? u('result-void', { where, when }) : u('result', { where, when, winner: s ? sideLabel(s, ctx) : u('the-match') });
};

// Matches that completed since the last poll, merged into the rolling window.
function venueRecency(data, cats) {
  const slug = data.t.slug;
  let lastSnap = slugSnap.get(slug);
  if (!lastSnap) { lastSnap = { done: new Map() }; slugSnap.set(slug, lastSnap); }
  let recent = slugRecent.get(slug);
  if (!recent) { recent = []; slugRecent.set(slug, recent); }
  const done = new Map();
  const fresh = [];
  for (const c of cats) for (const m of c.matches) {
    if (!m) continue;
    const k = `${c.id}:${m.id}`;
    const d = isDone(m);
    done.set(k, d);
    if (!lastSnap.done.get(k) && d) fresh.push(resultText(c, m));
  }
  lastSnap.done = done;
  const at = Date.now();
  recent = [...recent.filter(e => at - e.at < RECENT_MS), ...fresh.map(text => ({ text, at }))];
  slugRecent.set(slug, recent);
  return recent;
}

// A possible stage: the round the player could reach once the pools decide —
// the certain bits inline, the chip carrying the rank or outcome that gets in.
function possibleCard(stage, ctx, opts) {
  const when = stage.time !== null ? timeEl(stage.time, ctx.tz, opts.day) : '<span class="tbd">TBD</span>';
  const where = stage.court !== null ? esc(venueName(ctx, stage.court)) : '<span class="tbd">TBD</span>';
  const label = esc(stage.label);
  return `<article${opts.id ? ` id="${opts.id}"` : ''} data-status="possible"><div class="head"><span>${when}</span><span>${where}</span></div><div class="meta">${esc(ctx.name)} · ${label}</div>${stage.chip ? `<div class="meta">(${esc(stage.chip)})</div>` : ''}</article>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return MISSING();
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = route.player ? players.find(x => x.id === route.player) : null;
  return p ? playerSchedule(route, data, p) : playerPicker(route, data, players);
}

// Only participants are pickable — a pick must always render a schedule. One
// section per category: the picker doubles as "who is in which category".
function playerPicker(route, data, players) {
  const secs = data.cats.map(c => {
    const items = players
      .filter(pl => playerMatches(c, pl.id).length)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map(pl => `<li><a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat, player: pl.id }))}">${esc(pl.name || pl.id)}</a></li>`)
      .join('');
    return items ? `<section><h2>${esc(c.name || c.id)}</h2><ul>${items}</ul></section>` : '';
  }).join('');
  const head = `${segmentBar(route)}<header><h1>${u('pick-player')}</h1></header>`;
  return secs ? head + secs : head + `<p>${u('no-players')}</p>`;
}

// One flat timeline for the picked player — confirmed matches and possible
// stages, under date headings.
function playerSchedule(route, data, p) {
  const pid = p.id;
  const ctxs = data.cats;
  const multi = multiDay(ctxs); // the stage times need their date on multi-day pages
  const rows = ctxs.flatMap(ctx => playerMatches(ctx, pid).map(pm => ({ m: pm.m, ctx })));
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  // One flat timeline under date headings — the day owns the context, so cards
  // never repeat it. Possible stages merge in at their own time, next to the
  // match cards.
  const events = [];
  for (const ctx of ctxs) {
    for (const stage of possibleStages(ctx, pid)) events.push({ t: stage.time ?? Infinity, stage, ctx });
  }
  for (const r of rows) events.push({ t: schedTime(r.m, r.ctx.tz) ?? Infinity, r, ctx: r.ctx });
  // times ascending; a confirmed row wins an exact tie against a possible stage
  events.sort((a, b) => a.t - b.t || (a.r ? 0 : 1) - (b.r ? 0 : 1));
  // the "what's next" line names the earliest playable event — a confirmed
  // match, or the earliest possible stage
  const nextEv = events.find(e => e.r ? !isDone(e.r.m) : true);
  let next = null;
  if (nextEv) {
    // the whole "Next:" line is the link — a full-size tap target
    const link = `<a data-jump="next" href="${esc(href(data.t.slug, 'schedule', route))}">`;
    if (nextEv.r) {
      const m = nextEv.r.m, nctx = nextEv.r.ctx;
      const t = schedTime(m, nctx.tz);
      next = `${link}${u('next', { body: `${t !== null ? timeEl(t, nctx.tz, multi) : 'TBD'}${m.venue ? ` · ${esc(venueName(nctx, m.venue))}` : ' · TBD'}` })}<span aria-hidden="true"> ↓</span></a>`;
    } else {
      const stage = nextEv.stage, nctx = nextEv.ctx;
      next = `${link}${u('next', { body: `${esc(stage.label)}${stage.time !== null ? ' · ' + timeEl(stage.time, nctx.tz, multi) : ''}${stage.chip ? ` (${esc(stage.chip)})` : ''}` })}<span aria-hidden="true"> ↓</span></a>`;
    }
  }
  // the one next line rides under the progress of the category that hosts it:
  // a player has one next match, and the category lead above it says whose it is
  const blocks = [];
  for (const ctx of ctxs) {
    const s = playerStatus(ctx, pid);
    if (!s) continue;
    blocks.push(`<p>${esc(ctx.name || ctx.id)}: <strong>${esc(s)}</strong></p>`);
    if (nextEv && nextEv.ctx === ctx) blocks.push(`<p data-status="next">${next}</p>`);
  }
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}<a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat }))}">${u('change-player')}</a></h1>${blocks.join('')}${updatedLine(data, data.tjson.timezone || 'UTC')}</header>`];
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

// The sim clock: while the offset key exists, now() rides it — the ◀▶ panel
// and ]/[ keys move it, the toggle in the corner clears it. No key, real time.
// The panel lives outside main, so no render touches it, and it reads the
// current page through tjsonOf.
function mountSimClock({ tjsonOf, onChange }) {
  const SIM_KEY = 'gitbracket.sim.offset';
  const simOffset = () => Number(localStorage.getItem(SIM_KEY)) || 0;
  const simOn = () => localStorage.getItem(SIM_KEY) !== null;
  const now = () => Date.now() + simOffset();

  const aside = document.createElement('aside');
  aside.id = 'sim-clock';
  aside.setAttribute('role', 'group');
  aside.setAttribute('aria-label', 'sim clock');
  const toggle = document.createElement('button'); toggle.type = 'button';
  const back = document.createElement('button'); back.type = 'button'; back.textContent = '◀'; back.setAttribute('aria-label', 'sim clock 30 minutes back');
  const fwd = document.createElement('button'); fwd.type = 'button'; fwd.textContent = '▶'; fwd.setAttribute('aria-label', 'sim clock 30 minutes forward');
  const readout = document.createElement('span');
  const steps = [back, readout, fwd]; // shown only while the clock is on

  const panel = () => {
    const on = simOn();
    // the box belongs to the controls; at rest the chip is bare
    aside.toggleAttribute('data-sim', on);
    // the one chip is both: ● LIVE at rest, ✕ while the sim clock runs
    toggle.textContent = on ? '✕' : '● LIVE';
    toggle.setAttribute('aria-label', on ? 'turn the sim clock off' : '');
    toggle.setAttribute('aria-pressed', String(on));
    for (const el of steps) el.hidden = !on;
    if (!on) return;
    const t = now();
    const tz = (tjsonOf() || {}).timezone || 'UTC';
    readout.textContent = `${dayShort(t, tz)} · ${fmtTime(t, tz)}`;
  };
  // a clock change re-renders the board — statuses and the now-line recompute
  const apply = () => { panel(); onChange(); };
  const step = ms => { localStorage.setItem(SIM_KEY, String(simOffset() + ms)); apply(); };
  toggle.onclick = () => {
    if (simOn()) localStorage.removeItem(SIM_KEY);
    else {
      const tjson = tjsonOf();
      localStorage.setItem(SIM_KEY, String((tjson && simAimOffset(tjson, Date.now())) || 0));
    }
    apply();
  };
  back.onclick = () => step(-30 * 60000);
  fwd.onclick = () => step(30 * 60000);
  aside.append(toggle, back, readout, fwd);
  window.addEventListener('keydown', e => {
    if (!simOn() || !aside.parentNode) return; // the keys move the board's clock, and only where it is
    if (e.key === '[') { e.preventDefault(); step(-30 * 60000); }
    else if (e.key === ']') { e.preventDefault(); step(30 * 60000); }
  });
  return { aside, panel, now };
}

// The index loads once; every tournament view polls while the tab is visible,
// so results land on their own — no reload, no manual refresh.
function boot() {
  const app = document.querySelector('main');

  // The language is decided once per load: ?lang= wins (the kiosk operator's
  // control, and the tester's), else the browser's first matching language.
  lang = resolveLang(location.hash, location.search);
  setLocale(lang);
  document.documentElement.lang = lang;

  // The sim clock drives now() and the venue board's corner panel.
  const sim = mountSimClock({
    tjsonOf: () => data && data.tjson,
    onChange: () => { if (data && route) render(route, data); },
  });
  const now = sim.now;

  const renderers = { index: renderIndex, tournament: renderTournament, venues: (r, d) => renderVenue(r, d, now()), schedule: renderPlayer };
  const pageTitle = (r, d) => {
    if (r.view === 'index' || !d.t) return 'Bracket';
    if (r.view === 'schedule') {
      if (r.player) {
        const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.player);
        if (p) return `${d.t.name} — ${p.name || p.id}`;
      }
      return `${d.t.name} — ${u('schedule')}`;
    }
    return `${d.t.name} — ${u('venue-board')}`; // the venues view names itself — the kiosk tab distinguishes boards from schedules
  };
  let route = null;    // current fragment route — the poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let lastHtml = '';   // skip re-render when nothing changed (keeps selection/focus)
  let lastKey = '';    // view|cat — a change is new content, start at the top
  let lastFollow = 0;  // last minute-tick re-follow — tracks the play even when data never changes
  let pollTimer = null, clockTimer = null;
  let pollOn = false;  // view whose timers should run; false on the index

  // Every view but the index auto-refreshes while the tab is visible; a return
  // fetches immediately. The kiosk's clock is a view, not a mode.
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  };
  const startPoll = () => {
    stopPoll();
    pollTimer = setInterval(tick, POLL_MS);
    if (pollOn === 'venues') {
      // Clock lives in an element the change-guard never re-renders; look it
      // up fresh each tick.
      clockTimer = setInterval(() => {
        const t = now();
        const tz = (data && data.tjson && data.tjson.timezone) || 'UTC';
        const el = document.getElementById('clock');
        if (el) {
          el.textContent = `${dayShort(t, tz)} · ${fmtTime(t, tz)}`; // the kiosk clock carries its date
          el.dateTime = new Date(t).toISOString(); // the instant, derived — the label stays wall clock
        }
        sim.panel(); // the sim panel's readout rides the kiosk tick
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
    // a view, category, or player change is new content — start at the top; a
    // venue hop keeps the position (the kiosk re-aims each minute)
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
    // the sim clock is the venue board's alone — attached there, gone elsewhere
    if (!r || r.view !== 'venues') sim.aside.remove();
    else if (!sim.aside.parentNode) document.body.appendChild(sim.aside);
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

  // the receipt and the scroll target are the same: the first spined card —
  // a deep group stage buries the wave below its heading, and the match the
  // line names is what the jump owes the user, not the section label. Centering
  // keeps the target clear of the sticky bars on both pages.
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
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });

  sim.panel(); // the corner chip's first paint

  navigate();
  window.addEventListener('hashchange', navigate);
  // a hidden tab stops polling entirely; a return fetches immediately
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else if (pollOn) { tick(); startPoll(); }
  });
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, resolveLang, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer, simAimOffset, paintBadRoute };
}
