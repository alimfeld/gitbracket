'use strict';

const POLL_MS = 10000;


if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./derive.js'));
}

// ---------- data loading ----------

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(url) {
  try {
    // cache: 'no-cache' revalidates — 304s return 0 bytes, changes arrive fresh
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null; // 404 -> null -> renders empty, never throws
    return await res.json();
  } catch (e) {
    return null;
  }
}

// One page, fragment routing: #<slug>[/schedule|venues][?cat=&player=&venue=].
// Segments and param values are id-regex-checked first — raw input never reaches
// a URL; unknown param names and bad values are ignored, never fatal. Cat is a
// param, never a path segment: the path keeps one grammar (view names only),
// so a category id can't shadow a view.
function parseRoute(hash) {
  if (hash === undefined) hash = location.hash;
  const [path, query] = String(hash).replace(/^#/, '').split('?');
  const segs = path.split('/');
  if (segs.length === 1 && segs[0] === '') return { view: 'index' };
  if (segs.length > 2 || segs.some(s => !s || !ID_RE.test(s))) return null; // #../../ -> reject
  const [slug, view] = segs;
  if (view !== undefined && view !== 'schedule' && view !== 'venues') return null;
  const r = { slug, view: view || 'tournament' };
  const q = new URLSearchParams(query);
  for (const k of ['cat', 'player', 'venue']) {
    const v = q.get(k);
    if (v && ID_RE.test(v)) r[k] = v;
  }
  return r;
}

// Fragment URLs with params in fixed order. Each target keeps only the params
// legal on it: cat and player are symmetric — cat picks the one category on the
// tournament page, player the schedule, and both ride along across the two views
// so switching keeps the focus and My Schedule restores the pick. The kiosk
// sits on its own path and carries neither.
const LEGAL = { tournament: ['cat', 'player'], schedule: ['cat', 'player'], venues: ['venue'] };
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
  // one file per tournament — a poll is a single atomic fetch, no index roundtrip.
  const tjson = await fetchJson(`tournaments/${route.slug}.json`);
  const t = tjson ? { slug: route.slug, name: tjson.name } : null;
  return { t, tjson, cats: toCats(tjson) };
}

// ---------- renderers ----------

const segmentBar = r => {
  const t = r.view === 'tournament', m = r.view === 'schedule';
  return `<nav class="segments" aria-label="Views"><a href="${esc(href(r.slug, 'tournament', r))}"${t ? ' aria-current="true"' : ''}>Tournament</a><a href="${esc(href(r.slug, 'schedule', r))}"${m ? ' aria-current="true"' : ''}>My Schedule</a></nav>`;
};

// The one missing-data message, verbatim in every view.
const MISSING = '<p>No tournament data yet — check back soon.</p>';


// day lands the multi-day flag on the cards (date + time)
const matchGrid = (ms, ctx, day) => `<section class="grid">${ms.map(m => matchCard(m, ctx, { meta: ['label', 'court', 'time'], day })).join('')}</section>`;

// Date leads, undated entries defer to the end, ties hold index order (stable sort).
function renderIndex(route, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .sort((a, b) => {
      const ad = a.dates && a.dates[0], bd = b.dates && b.dates[0];
      if (ad && bd) return ad === bd ? 0 : ad < bd ? -1 : 1; // Y-M-D strings sort chronologically
      return ad ? -1 : bd ? 1 : 0;
    })
    .map(e => {
      const dates = fmtRange(e.dates); // stored ISO days -> span
      return `<tr><td>${dates ? esc(dates) : ''}</td><td><a href="#${esc(e.slug)}">${esc(e.name || e.slug)}</a> · <a href="#${esc(e.slug)}/venues">Venue board</a></td><td>${esc(e.location)}</td></tr>`;
    });
  if (!items.length) return `<h1>Tournaments</h1><p>No tournaments yet.</p>`;
  return `<h1>Tournaments</h1><table><thead><tr><th scope="col">Date</th><th scope="col">Tournament</th><th scope="col">Location</th></tr></thead><tbody>${items.join('')}</tbody></table>`;
}

// One category per page; the switcher is the navigation — the first category
// stays canonical at the bare slug, the rest select via ?cat=.
const catNav = (slug, ctxs, route) => ctxs.map((c, i) => {
  const p = { ...route, cat: i === 0 ? undefined : c.id };
  const active = (route.cat || ctxs[0].id) === c.id;
  return `<a href="${esc(href(slug, 'tournament', p))}"${active ? ' aria-current="true"' : ''}>${esc(c.name || c.id)}</a>`;
}).join('');

function renderTournament(route, data) {
  if (!data.tjson) return MISSING;
  const tz = data.tjson.timezone || 'UTC';
  const ctxs = catCtxs(data);
  const show = ctxs.find(c => c.id === route.cat) || ctxs[0]; // an unknown cat falls back to the first
  const multi = multiDay(ctxs);
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}</h1>`];
  // the heading states the span and the location once — single-day cards never repeat the date
  const range = dateRange(ctxs.flatMap(c => c.matches), tz);
  parts.push(`<p class="subline">${[range, esc(data.tjson.location)].filter(Boolean).join(' · ')}</p></header>`);
  // the category switcher pins under the view bar for the whole page — it must
  // sit outside the header, or the header's height would be its sticky ceiling
  parts.push(`<nav class="cats" aria-label="Categories">${catNav(data.t.slug, ctxs, route)}</nav>`);
  parts.push(catSection(show, { multi }));
  return parts.join('');
}

// data-only: played/unplayed + scheduled times, never the device clock
function phaseLine(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return '';
  if (ms.every(isDone)) return 'Finished';
  if (!ms.some(isDone)) {
    const ts = ms.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    return `Starts ${ts.length ? timeEl(Math.min(...ts), ctx.tz) : 'soon'}`;
  }
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) {
    const nextTs = grp.filter(m => !isDone(m)).map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    const next = nextTs.length ? `, next ${timeEl(Math.min(...nextTs), ctx.tz)}` : '';
    return `Group stage · ${grp.filter(isDone).length} of ${grp.length} played${next}`;
  }
  const next = ms.find(m => m.pool === undefined && !isDone(m));
  return `Knockout stage · ${next ? roundName(koColumn(next, ctx)) : 'awaiting'}`;
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
  // All pools, chronological by wall-clock (stable sort keeps file order on ties).
  const grp = [...byPool.values()].flat().sort((a, b) => (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));
  // one category subline: the status sentence; the day span joins on multi-day
  // pages only — a single-day heading already states the date once
  const phase = phaseLine(ctx);
  const sub = [opts.multi ? dateRange(ctx.matches, ctx.tz) : null, phase].filter(Boolean).join(' · ');
  parts.push(`<section class="cat"><h2>${esc(ctx.name)}</h2>${sub ? `<p class="subline">${sub}</p>` : ''}`);
  if (grp.length) {
    parts.push(`<section class="stage"><h3>Group stage</h3>`);
    // pools belong to the group stage — scoreboard first, cards last; the
    // category subline above carries the status sentence
    if (byPool.size) {
      const started = ctx.matches.some(isDone); // pre-play every team ties at zero — no highlight yet
      let anyTie = false;
      parts.push('<div class="pools">');
      for (const [pool] of byPool) {
        const adv = poolAdvance(ctx, pool);
        const note = !adv || adv.total === 0 ? ''
          : adv.count >= adv.total ? 'All teams advance'
          : adv.top ? `Top ${adv.count} advance`
          : `${adv.count} teams advance`;
        parts.push(`<section><h4>Pool ${esc(String(pool))}${note ? ` <span class="adv">(${esc(note)})</span>` : ''}</h4>`);
        parts.push('<table><thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col" class="num">W</th><th scope="col" class="num">L</th><th scope="col" class="num">GD</th><th scope="col" class="num">PD</th></tr></thead><tbody>');
        const st = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
        const ranks = poolRanks(st);
        st.forEach((r, i) => {
          const tied = started && isDeadTie(st, i + 1);
          if (tied) anyTie = true;
          const team = teamLabel(r.ids, ctx);
          parts.push(`<tr${tied ? ' data-tie' : ''}><td>${ranks[i]}</td><td>${esc(team)}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${fmtDiff(r.gd)}</td><td class="num">${fmtDiff(r.pd)}</td></tr>`);
        });
        parts.push('</tbody></table></section>');
      }
      // the highlight is color-only — one line names what it means
      if (anyTie) parts.push('<p class="note">Highlighted rows are dead ties on every tiebreaker — the organizer settles the order.</p>');
      parts.push('</div>');
    }
    parts.push(matchGrid(grp, ctx, opts.multi), '</section>');
  }
  if (ko.length) parts.push(bracketHtml(ctx, ko, opts.multi));
  parts.push('</section>');
  return parts.join('');
}


// Bracket order first: a card's position must match its QF/SF ordinal, which
// schedule edits can't move. Time breaks ties and orders unnumbered matches.
const koOrder = (ms, ctx) => [...ms].sort((a, b) =>
  (koOrdinal(a, ctx) || Infinity) - (koOrdinal(b, ctx) || Infinity) ||
  (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));

function bracketHtml(ctx, ko, multi) {
  const maxR = ko.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  const cols = [];
  for (const m of ko) {
    const r = maxR - koColumn(m, ctx); // koColumn is distance from the final; render that column rightmost
    (cols[r] = cols[r] || []).push(m);
  }
  const parts = [];
  parts.push(`<section class="stage"><h3>Knockout stage</h3>`);
  for (let r = 0; r <= maxR; r++) { // index by depth, skip holes — labels stay aligned if a column is empty
    const ms = cols[r];
    if (!ms || !ms.length) continue;
    parts.push(`<h4>${roundName(maxR - r)}</h4>`, matchGrid(koOrder(ms, ctx), ctx, multi));
  }
  parts.push('</section>');
  return parts.join('');
}

// datetime carries the instant (ISO); the label stays wall-clock — multi-day
// tournaments prefix the date so a scrolled page keeps day context on the card
const timeEl = (t, tz, day) => `<time datetime="${new Date(t).toISOString()}">${esc((day ? `${dayShort(t, tz)}, ` : '') + fmtTime(t, tz))}</time>`;

// opts.meta picks the meta items (fixed vocabulary); opts.head is an optional
// [left, right] headline row — a cell is { key: item field } or { html: pre-rendered }.
function matchCard(m, ctx, opts = {}) {
  const t = schedTime(m, ctx.tz);
  const item = {
    catName: esc(ctx.name),
    label: esc(matchLabel(m, ctx)),
    court: m.venue ? esc(ctx.venues.get(m.venue) || m.venue) : 'TBD',
    time: t !== null ? timeEl(t, ctx.tz, opts.day) : 'TBD',
  };
  const meta = opts.meta.map(k => item[k]).join(' · ');
  const head = opts.head ? `<div class="head">${opts.head.map(c => `<span>${c.html !== undefined ? c.html : item[c.key]}</span>`).join('')}</div>` : '';
  return `<article${opts.status ? ` data-status="${opts.status}"` : ''}>${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
}

function sideRow(m, ctx, i) {
  const w = winnerIdx(m);
  const games = m.games || [];
  const r = m.result;
  // one slot per best-of game — placeholders keep the shape, so no label is needed
  const bo = bestOfOf(m, ctx) || 1; // unset stage config -> one unmarked slot
  const slot = () => Array.from({ length: bo }, (_, g) => {
    const game = games[g];
    // aria-hidden: the placeholder dot is shape-as-label, noise to a screen reader
    return `<span${game ? '' : ' class="ph" aria-hidden="true"'}>${game ? (i === 0 ? game.a : game.b) : '·'}</span>`;
  }).join('');
  // the winning side carries the W/O mark (tennis draws put "w/o" beside the advancing name)
  const score = !r || r.status === 'played' ? slot()
    : r.status === 'void' ? '<span>void</span>'
    : sideIdx(r.winner) === i ? '<span>W/O</span>'
    : slot();
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${esc(sideLabel(m.sides[i], ctx))}</span><span class="score">${score}</span></div>`;
}

function catCtxs(data) {
  return data.cats.map(c => makeCat(c, data.tjson));
}

function renderVenue(route, data, now = Date.now()) {
  if (!data.tjson) return MISSING;
  const v = route.venue;
  const rows = [];
  const ctxs = catCtxs(data);
  for (const ctx of ctxs) {
    for (const m of ctx.matches) {
      if (!m || m.venue === undefined) continue;
      const t = schedTime(m, ctx.tz);
      if (t === null) continue;
      rows.push({ m, t, ctx });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  // courts with no matches are simply absent; names come from makeCat's map
  const venueNames = ctxs[0] ? ctxs[0].venues : new Map();
  const venues = (data.tjson.venues || []).map(x => x.id).filter(id => rows.some(r => r.m.venue === id));
  const shown = v ? rows.filter(r => r.m.venue === v) : rows;
  const parts = [`<header><h1>${esc(data.t.name)}</h1><time id="k-clock"></time></header>`];
  const byVenue = new Map(venues.map(id => [id, []]));
  for (const r of shown) {
    if (byVenue.has(r.m.venue)) byVenue.get(r.m.venue).push(r); // rows pre-sorted, buckets stay sorted
  }
  let any = false;
  const today = dayKey(now, data.tjson.timezone || 'UTC'); // kiosk shows today only — an overnight screen must not list yesterday
  const cols = [];
  for (const id of venues) {
    const open = byVenue.get(id).filter(r => !isDone(r.m) && dayKey(r.t, r.ctx.tz) === today); // a result removes the card, everything else stays
    if (!open.length) continue;
    any = true;
    const col = [];
    col.push(`<h2>${esc(venueNames.get(id) || id)}</h2>`);
    col.push('<div class="stack">');
    for (const r of open) {
      const st = kioskStatus(r, now);
      const when = timeEl(r.t, r.ctx.tz);
      const flag = st === 'overdue' ? 'delayed' : st === 'live' ? 'live' : '';
      col.push(matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
        head: [{ html: flag ? `${when} <span class="flag">${flag}</span>` : when }], status: st }));
    }
    col.push('</div>');
    cols.push(`<section>${col.join('')}</section>`);
  }
  parts.push(v ? cols.join('') : `<div class="board">${cols.join('')}</div>`);
  if (!any) parts.push('<p>Nothing scheduled.</p>');
  return parts.join('');
}

// One tournament-wide fact, derived at render: do scheduled matches span more
// than one wall-clock day? Gates the date on match cards — single-day pages
// state the date once, multi-day cards carry their own.
const multiDay = ctxs => {
  const days = new Set();
  for (const c of ctxs) {
    for (const m of c.matches) {
      const t = schedTime(m, c.tz);
      if (t !== null) days.add(dayKey(t, c.tz));
    }
  }
  return days.size > 1;
};


function possibleLine(b) {
  const noun = b.count === 1 ? 'match' : 'matches';
  const when = b.min === b.max
    ? `at ${timeEl(b.min, b.ctx.tz)}`
    : `— earliest ${timeEl(b.min, b.ctx.tz)}, latest ${timeEl(b.max, b.ctx.tz)}`;
  return `<p class="note">${b.count} more ${noun} possible in ${esc(b.ctx.name)} ${when}</p>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return MISSING;
  const pid = route.player;
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = pid ? players.find(x => x.id === pid) : null;
  if (!p) {
    // only participants are pickable — a pick must always render a schedule
    const ctxs = catCtxs(data);
    const items = players.filter(pl => ctxs.some(c => playerMatches(c, pl.id).length))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map(pl => `<li><a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat, player: pl.id }))}">${esc(pl.name || pl.id)}</a></li>`)
      .join('');
    return `${segmentBar(route)}<header><h1>Pick your player</h1></header><ul>${items || '<li>No players yet.</li>'}</ul>`;
  }
  const rows = [];
  const ctxs = catCtxs(data);
  const multi = multiDay(ctxs);
  for (const ctx of ctxs) {
    for (const pm of playerMatches(ctx, pid)) rows.push({ m: pm.m, i: pm.i, ctx });
  }
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  // one flat timeline — no day headers; multi-day cards carry their own date,
  // a single-day page states it once in the heading
  const blocks = [];
  for (const ctx of ctxs) {
    const span = possibleSpan(ctx, pid);
    if (span) blocks.push({ ctx, ...span });
  }
  blocks.sort((a, b) => a.min - b.min);
  // a void settles, counts nothing
  let wins = 0, losses = 0;
  for (const r of rows) {
    const wi = winnerIdx(r.m);
    if (wi === r.i) wins++;
    else if (wi !== null) losses++;
  }
  const tz = data.tjson.timezone || 'UTC';
  const first = rows.map(r => schedTime(r.m, r.ctx.tz)).find(t => t !== null);
  const when = !multi && first !== undefined ? `${dayShort(first, tz)} · ` : '';
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}</h1><p class="subline"><span>${when}${wins} W · ${losses} L</span><a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat }))}">Not you?</a></p></header>`];
  const out = [];
  let bi = 0;
  for (const r of rows) {
    const t = schedTime(r.m, r.ctx.tz), m = r.m, ctx = r.ctx;
    while (bi < blocks.length && blocks[bi].min < t) out.push(possibleLine(blocks[bi++]));
    out.push(matchCard(m, ctx, { meta: ['catName', 'label'], day: multi, head: [{ key: 'time' }, { key: 'court' }] }));
  }
  while (bi < blocks.length) out.push(possibleLine(blocks[bi++]));
  parts.push(`<div class="stack">${out.join('')}</div>`);
  if (!rows.length) parts.push('<p>No matches.</p>');
  return parts.join('');
}

// ---------- boot ----------

// Read-once views load once and recover via manual reload; the kiosk polls.
function boot() {
  const app = document.querySelector('main');

  const renderers = { index: renderIndex, tournament: renderTournament, venues: renderVenue, schedule: renderPlayer };
  const pageTitle = (r, d) => {
    if (r.view === 'index' || !d.t) return 'Bracket';
    if (r.view === 'schedule') {
      if (r.player) {
        const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.player);
        if (p) return `${d.t.name} — ${p.name || p.id}`;
      }
      return `${d.t.name} — My Schedule`;
    }
    return d.t.name;
  };
  let route = null;    // current fragment route — the kiosk poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let lastHtml = '';   // skip re-render when nothing changed — keeps selection/focus on the player page
  let lastKey = '';    // view|cat — what the page shows; a change is new content, start at the top
  let pollTimer = null, clockTimer = null;

  // Auto-refresh only on the kiosk; the other views are read-on-load.
  const setKiosk = on => {
    if (on && !pollTimer) {
      pollTimer = setInterval(tick, POLL_MS + Math.random() * 5000); // jitter: no lockstep across a hall of screens
      // Clock lives in an element the change-guard never re-renders; look it up
      // fresh each tick (the poll re-renders).
      clockTimer = setInterval(() => {
        const el = document.getElementById('k-clock');
        if (el) {
          el.textContent = fmtTime(Date.now(), (data && data.tjson && data.tjson.timezone) || 'UTC');
          el.dateTime = new Date().toISOString(); // the instant, derived — the label stays wall clock
        }
      }, 1000);
    } else if (!on && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
      clearInterval(clockTimer); clockTimer = null;
    }
  };

  const load = r => {
    loadAll(r).then(d => {
      if (route !== r) return; // superseded by a newer navigation
      if (r.view !== 'index' && !d.tjson) { // fetch failed or unknown slug — the kiosk retries next tick
        if (!data) app.innerHTML = MISSING + '<p>Reload the page to try again.</p>';
        return;
      }
      render(r, d);
    });
  };
  const tick = () => load(route);

  const render = (r, d) => {
    data = d;
    // the kiosk dark theme keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    // a category or view switch is new content — start at the top; shorter
    // pages clamp the residual scroll. Player/venue hops keep the position.
    const key = `${r.view}|${r.cat || ''}`;
    const contentChanged = key !== lastKey;
    lastKey = key;
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
      if (contentChanged) window.scrollTo(0, 0);
    } catch (e) {
      app.innerHTML = '<p>Something went wrong displaying this page.</p>';
      console.error(e);
    }
  };

  // Fragment navigation: same-slug hops re-render from the cached snapshot.
  const navigate = () => {
    const r = parseRoute();
    if (!r) {
      route = null;
      setKiosk(false);
      app.innerHTML = '<p>This link doesn\'t look right.</p><p><a href="#">All tournaments</a></p>';
      return;
    }
    route = r;
    setKiosk(r.view === 'venues');
    if (r.view === 'index' || !(data && data.t && data.t.slug === r.slug)) { // index has no t — always reloads; a snapshot's t carries its slug
      data = null;
      lastHtml = '';
      load(r);
    } else {
      render(r, data);
    }
  };

  navigate();
  window.addEventListener('hashchange', navigate);
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer };
}
