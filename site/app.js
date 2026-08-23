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
// a URL; unknown param names and bad values are ignored, never fatal.
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
// legal on it: cat and player are symmetric — applied on their home view
// (tournament / schedule) and riding along on both, so switching views keeps
// the focus and My Schedule brings the pick back. The kiosk sits on its own
// path and carries neither.
const LEGAL = { tournament: ['cat', 'player'], schedule: ['cat', 'player'], venues: ['venue'] };
const href = (slug, view, p) => {
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


const FULL_META = ['label', 'court', 'time'];
const matchGrid = (ms, ctx) => `<section class="grid">${ms.map(m => matchCard(m, ctx, { meta: FULL_META })).join('')}</section>`;

// Category pills — the tournament page's category filter; other params (the
// riding-along player) are preserved.
const catPills = (cats, r) => cats.map(c => {
  const active = c.id === r.cat;
  const p = { ...r, cat: active ? undefined : c.id }; // active pill is the drop link for cat only
  return `<a href="${esc(href(r.slug, 'tournament', p))}"${active ? ' aria-current="true"' : ''}>${esc(c.name)}</a>`;
}).join('');

function renderIndex(route, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .map(e => `<li><a href="#${esc(e.slug)}">${esc(e.name || e.slug)}</a> <a href="#${esc(e.slug)}/venues">Venue board</a></li>`);
  return `<h1>Tournaments</h1><ul>${items.join('') || '<li>No tournaments yet.</li>'}</ul>`;
}

function renderTournament(route, data) {
  if (!data.tjson) return MISSING;
  // one date axis per render: the first divider lands under the pills, later ones only where the day changes
  const cats = data.cats.filter(c => !route.cat || c.meta.id === route.cat);
  const tz = data.tjson.timezone || 'UTC';
  const axis = { day: null };
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}</h1>`];
  parts.push(`<nav class="pills" aria-label="Categories">${catPills(data.tjson.categories || [], route)}</nav></header>`);
  const first = earliestRun(cats, tz);
  if (first) parts.push(dayDiv(first.label, first.iso, axis)); // the first divider always lands under the pills
  for (const c of cats) {
    parts.push(catSection(makeCat(c, data.tjson), axis));
  }
  return parts.join('');
}

// data-only: played/unplayed + scheduled times, never the device clock
function phaseLine(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return '';
  if (ms.every(isDone)) return 'Finished';
  if (!ms.some(isDone)) {
    const ts = ms.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    return `Starts ${ts.length ? fmtTime(Math.min(...ts), ctx.tz) : 'soon'}`;
  }
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) {
    const nextTs = grp.filter(m => !isDone(m)).map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    const next = nextTs.length ? `, next ${fmtTime(Math.min(...nextTs), ctx.tz)}` : '';
    return `Group stage · ${grp.filter(isDone).length} of ${grp.length} played${next}`;
  }
  const next = ms.find(m => m.pool === undefined && !isDone(m));
  return `Knockout stage · ${next ? roundName(koColumn(next, ctx)) : 'awaiting'}`;
}

// Dates are one timeline axis per render, never a heading level: a block of same-day
// cards carries a divider (a dated hairline, `dayDiv`) only when its day differs from
// the last divider's, so the first block of a day states it and later blocks rest on it.
const dayLabel = (m, ctx) => { const t = schedTime(m, ctx.tz); return t === null ? 'Time TBD' : dayShort(t, ctx.tz); };
const chrono = (ms, ctx) => [...ms].sort((a, b) => (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));
const dayIso = (m, ctx) => { const t = schedTime(m, ctx.tz); return t === null ? null : dayKey(t, ctx.tz); };
const dayRuns = (ms, ctx) => {
  const map = new Map();
  for (const m of chrono(ms, ctx)) {
    const key = dayLabel(m, ctx);
    if (!map.has(key)) map.set(key, { label: key, iso: dayIso(m, ctx), ms: [] });
    map.get(key).ms.push(m);
  }
  return [...map.values()];
};
// the divider label is the friendly wall-clock date; datetime carries the tz-local date
const dayDiv = (label, iso, axis) => {
  if (label === axis.day) return ''; // the axis already states this day — no divider, no noise
  axis.day = label;
  return `<div class="day">${iso ? `<time datetime="${iso}">${esc(label)}</time>` : esc(label)}</div>`;
};
// the first day under the pills: the earliest scheduled wall-clock match among rendered categories
const earliestRun = (cats, tz) => {
  let best = null;
  for (const c of cats) for (const m of c.matches || []) {
    const t = schedTime(m, tz);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best === null ? null : { label: dayShort(best, tz), iso: dayKey(best, tz) };
};

function catSection(ctx, axis) {
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
  const phase = phaseLine(ctx); // one status sentence per category, on its own line under the heading
  parts.push(`<h2>${esc(ctx.name)}</h2>${phase && `<p class="subline">${phase}</p>`}`);
  // always visible: the tables answer "which pool am I in, who else is in mine"
  if (byPool.size) {
    const started = ctx.matches.some(isDone); // pre-play every team ties at zero — no highlight yet
    let anyTie = false;
    parts.push('<h3>Pools</h3><div class="pools">');
    for (const [pool, poolMs] of byPool) {
      const adv = poolAdvance(ctx, pool);
      const note = !adv || adv.total === 0 ? ''
        : adv.count >= adv.total ? 'All teams advance'
        : adv.top ? `Top ${adv.count} advance`
        : `${adv.count} teams advance`;
      parts.push(`<section class="pool"><h4>Pool ${esc(String(pool))}${note ? ` <span class="adv">(${esc(note)})</span>` : ''}</h4>`);
      parts.push('<table><thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>GD</th><th>PD</th></tr></thead><tbody>');
      const st = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
      const ranks = poolRanks(st);
      st.forEach((r, i) => {
        const tied = started && isDeadTie(st, i + 1);
        if (tied) anyTie = true;
        const team = teamLabel(r.ids, ctx);
        parts.push(`<tr${tied ? ' data-tie' : ''}><td>${ranks[i]}</td><td>${esc(team)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${fmtDiff(r.gd)}</td><td>${fmtDiff(r.pd)}</td></tr>`);
      });
      parts.push('</tbody></table></section>');
    }
    parts.push('</div>');
    // the highlight is color-only — one line names what it means
    if (anyTie) parts.push('<p class="note">Highlighted rows are dead ties on every tiebreaker — the organizer settles the order.</p>');
  }
  // folds to a one-line summary once the groups are decided
  if (grp.length) {
    const played = grp.filter(isDone).length;
    const [first, ...rest] = dayRuns(grp, ctx);
    // the first run's divider sits outside the fold; a run that changes the day splits its own grid
    parts.push(`<h3>Group stage</h3>`, dayDiv(first.label, first.iso, axis), progressDayline(played, grp.length));
    const body = matchGrid(first.ms, ctx) + rest.map(r2 => `${dayDiv(r2.label, r2.iso, axis)}${matchGrid(r2.ms, ctx)}`).join('');
    parts.push(`<details${played < grp.length ? ' open' : ''}><summary>Group matches</summary>${body}</details>`);
  }
  if (ko.length) parts.push(bracketHtml(ctx, ko, axis));
  return parts.join('');
}

// one subline pattern per stage heading: bar + count
const progressDayline = (done, total) => `<p class="subline"><progress value="${done}" max="${total}"></progress>${done} of ${total} played</p>`;

// Bracket order first: a card's position must match its QF/SF ordinal, which
// schedule edits can't move. Time breaks ties and orders unnumbered matches.
const koOrder = (ms, ctx) => [...ms].sort((a, b) =>
  (koOrdinal(a, ctx) || Infinity) - (koOrdinal(b, ctx) || Infinity) ||
  (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));

function bracketHtml(ctx, ko, axis) {
  const maxR = ko.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  const cols = [];
  for (const m of ko) {
    const r = maxR - koColumn(m, ctx); // koColumn is distance from the final; render that column rightmost
    (cols[r] = cols[r] || []).push(m);
  }
  const koDone = ko.filter(isDone).length;
  const parts = [`<h3>Knockout stage</h3>`, progressDayline(koDone, ko.length)];
  for (let r = 0; r <= maxR; r++) { // index by depth, skip holes — labels stay aligned if a column is empty
    const ms = cols[r];
    if (!ms || !ms.length) continue;
    const label = roundName(maxR - r);
    const [first, ...rest] = dayRuns(ms, ctx);
    // the round's first run dates the h4 first; later runs split their own dividers in order
    parts.push(`<h4>${label}</h4>`, dayDiv(first.label, first.iso, axis));
    const body = matchGrid(koOrder(first.ms, ctx), ctx) + rest.map(r2 => `${dayDiv(r2.label, r2.iso, axis)}${matchGrid(koOrder(r2.ms, ctx), ctx)}`).join('');
    parts.push(body);
  }
  return parts.join('');
}

// opts.meta picks the meta items (fixed vocabulary); opts.head is an optional
// [left, right] headline row — a cell is { key: item field } or { html: pre-rendered }.
function matchCard(m, ctx, opts = {}) {
  const t = schedTime(m, ctx.tz);
  const item = {
    catName: esc(ctx.name),
    label: esc(matchLabel(m, ctx)),
    court: m.venue ? esc(ctx.venues.get(m.venue) || m.venue) : 'TBD',
    time: t !== null ? `<time datetime="${new Date(t).toISOString()}">${esc(fmtTime(t, ctx.tz))}</time>` : 'TBD',
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
      col.push(matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
        head: [st === 'overdue' ? { html: `${esc(fmtTime(r.t, r.ctx.tz))} <span class="flag">delayed</span>` }
          : st === 'live' ? { html: `${esc(fmtTime(r.t, r.ctx.tz))} <span class="flag">live</span>` }
          : { key: 'time' }], status: st }));
    }
    col.push('</div>');
    cols.push(`<section>${col.join('')}</section>`);
  }
  parts.push(v ? cols.join('') : `<div class="board">${cols.join('')}</div>`);
  if (!any) parts.push('<p>Nothing scheduled.</p>');
  return parts.join('');
}

const dayShort = (t, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(t);

function possibleLine(b) {
  const noun = b.count === 1 ? 'match' : 'matches';
  const when = b.min === b.max
    ? `at ${fmtTime(b.min, b.ctx.tz)}`
    : `— earliest ${fmtTime(b.min, b.ctx.tz)}, latest ${fmtTime(b.max, b.ctx.tz)}`;
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
  for (const ctx of ctxs) {
    for (const pm of playerMatches(ctx, pid)) rows.push({ m: pm.m, i: pm.i, ctx });
  }
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  const groups = new Map();
  for (const r of rows) {
    const key = dayLabel(r.m, r.ctx);
    if (!groups.has(key)) groups.set(key, { iso: dayIso(r.m, r.ctx), rows: [] });
    groups.get(key).rows.push(r);
  }
  const blocksByDay = new Map();
  for (const ctx of ctxs) {
    const span = possibleSpan(ctx, pid);
    if (!span) continue;
    const key = dayShort(span.min, ctx.tz);
    if (!blocksByDay.has(key)) blocksByDay.set(key, []);
    blocksByDay.get(key).push({ ctx, ...span });
  }
  const parts = [segmentBar(route), `<header><div class="title-row"><h1>${esc(p.name)}</h1><a class="top" href="${esc(href(data.t.slug, 'schedule', { cat: route.cat }))}">Not you?</a></div></header>`];
  const axis = { day: null }; // the schedule is one timeline — each distinct day states itself once
  for (const [key, g] of groups) {
    parts.push(dayDiv(key, g.iso, axis));
    const day = [];
    const blocks = (blocksByDay.get(key) || []).sort((a, b) => a.min - b.min);
    let bi = 0;
    for (const r of g.rows) {
      const t = schedTime(r.m, r.ctx.tz), m = r.m, ctx = r.ctx;
      while (bi < blocks.length && blocks[bi].min < t) day.push(possibleLine(blocks[bi++]));
      day.push(matchCard(m, ctx, {
        meta: ['catName', 'label'],
        head: [{ key: 'time' }, { key: 'court' }],
      }));
    }
    while (bi < blocks.length) day.push(possibleLine(blocks[bi++]));
    parts.push(`<div class="stack">${day.join('')}</div>`);
  }
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
  let dataSlug = null; // slug the snapshot belongs to — a route change to another tournament reloads
  let lastHtml = '';   // skip re-render when nothing changed — keeps selection/focus on the player page
  let lastView = parseRoute()?.view ?? null; // start from the browser's restored position on reload
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
    dataSlug = r.slug;
    // the kiosk dark theme keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    // a new view is new content: start sighted users at the top and AT/keyboard users at its heading
    const viewChanged = lastView !== r.view;
    lastView = r.view;
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
      if (viewChanged) {
        window.scrollTo(0, 0);
        const h1 = app.querySelector('h1');
        h1.tabIndex = -1;
        h1.focus({ preventScroll: true });
      }
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
    if (r.view === 'index' || r.slug !== dataSlug) {
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
