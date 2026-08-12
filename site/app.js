'use strict';
// app.js — fetch/render/boot for the GitBracket pages.
// The derive engine (standings, slot resolution, scheduling, labels, time)
// lives in derive.js, loaded before this file in the browser and required here
// in node; this file is only the data loading, the HTML renderers, and the
// boot.

const POLL_MS = 10000;

// derive.js is a plain script in the browser (functions on globalThis); in
// node, pull it in so this file's bodies can call the same names.
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
    // Revalidate with the CDN every poll: Pages honors If-None-Match, so
    // unchanged data returns a 0-byte 304 instead of a full re-download, and
    // changed data still arrives fresh on the next poll.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null; // 404 -> null -> renders empty, never throws
    return await res.json();
  } catch (e) {
    return null;
  }
}

// One page, fragment routing: #<slug>[/categories|venues|players[/<id>]].
// Every segment is checked against the id regex before use — reject → render
// an error, fetch nothing (a raw segment never reaches a URL).
function parseRoute(hash) {
  if (hash === undefined) hash = location.hash;
  const segs = String(hash).replace(/^#/, '').split('/');
  if (segs.length === 1 && segs[0] === '') return { view: 'index' }; // no fragment — the tournament list
  if (segs.length > 3 || segs.some(s => !s || !ID_RE.test(s))) return null; // #../../ -> reject
  const [slug, view, filter] = segs;
  if (view === undefined) return { slug, view: 'categories' }; // bare slug — standings, all categories
  if (view === 'categories' || view === 'venues' || view === 'players') return filter === undefined ? { slug, view } : { slug, view, filter };
  return null;
}

async function loadAll(route, indexOnly) {
  if (indexOnly) {
    const index = (await fetchJson('tournaments.json')) || [];
    // a non-array index stops here (renders an empty list, not a crash)
    if (!Array.isArray(index)) return { index: [], t: null, tjson: null, cats: [] };
    return { index, t: null, tjson: null, cats: [] };
  }
  // one file per tournament — a poll is a single atomic fetch, no index roundtrip.
  const tjson = await fetchJson(`tournaments/${route.slug}.json`);
  const cats = [];
  if (tjson && Array.isArray(tjson.categories)) {
    const byCat = (tjson.matches && typeof tjson.matches === 'object') ? tjson.matches : {};
    for (const meta of tjson.categories) {
      const arr = byCat[meta.id];
      cats.push({ meta, matches: Array.isArray(arr) ? arr : [] });
    }
  }
  const t = tjson ? { slug: route.slug, name: tjson.name } : null;
  return { index: [], t, tjson, cats };
}

// ---------- renderers ----------

function renderIndex(route, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .map(e => `<li><a href="#${esc(e.slug)}">${esc(e.name || e.slug)}</a> <a href="#${esc(e.slug)}/venues">kiosk</a></li>`);
  return `<h1>Tournaments</h1><ul>${items.join('') || '<li>No tournaments yet.</li>'}</ul>`;
}

function renderStandings(route, data) {
  if (!data.tjson) return '<p>Missing tournament data — has the tournament been pushed?</p>';
  const parts = [`<header><nav><a href="#">Home</a> · <a href="#${esc(data.t.slug)}/players">Player schedules</a></nav><h1>${esc(data.t.name)}</h1>`];
  // nav from the full category list, not the route-filtered cats — a filtered page must still show every pill
  const nav = (data.tjson.categories || []).map(c => {
    const active = route.filter === c.id;
    // clicking the active category drops the filter (toggle off)
    const href = active ? `#${esc(data.t.slug)}` : `#${esc(data.t.slug)}/categories/${esc(c.id)}`;
    return `<a href="${href}"${active ? ' aria-current="true"' : ''}>${esc(c.name)}</a>`;
  });
  parts.push(`<nav class="pills">${nav.join('')}</nav></header>`);
  for (const c of data.cats) {
    if (route.filter && c.meta.id !== route.filter) continue; // pills keep every category; only the section list narrows
    const ctx = makeCat(c, data.tjson);
    parts.push(`<h2>${esc(c.meta.name)}</h2>`);
    const byPool = new Map(); // pool -> matches, first-seen order
    for (const m of ctx.matches) {
      if (m && m.pool !== undefined) {
        if (!byPool.has(m.pool)) byPool.set(m.pool, []);
        byPool.get(m.pool).push(m);
      }
    }
    for (const [pool, poolMs] of byPool) {
      parts.push(`<h3>Pool ${esc(String(pool))}</h3>`);
      // pools come from matches, so partial standings always resolve
      const st = poolStandings(ctx, pool, true);
      parts.push('<table><thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>GD</th><th>PD</th></tr></thead><tbody>');
      let rank = 0;
      st.forEach((r, i) => {
        const tied = isDeadTie(st, i + 1);
        // shared rank for ties: same record as the row above keeps the group's first rank (1 1 1 4)
        if (i === 0 || !sameRecord(st[i - 1], r)) rank = i + 1;
        const team = teamLabel(r.ids, ctx);
        parts.push(`<tr${tied ? ' data-tie' : ''}><td>${rank}</td><td>${team}</td><td>${r.wins}</td><td>${r.losses}</td><td>${fmtDiff(r.gd)}</td><td>${fmtDiff(r.pd)}</td></tr>`);
      });
      parts.push('</tbody></table>');
      parts.push('<section class="grid">');
      for (const m of poolMs) parts.push(matchCard(m, ctx));
      parts.push('</section>');
    }
    const ko = ctx.matches.filter(m => m && m.pool === undefined);
    if (ko.length) parts.push(bracketHtml(ctx, ko));
  }
  return parts.join('');
}

function bracketHtml(ctx, ko) {
  const cols = [];
  const maxR = ko.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  for (const m of ko) {
    const r = maxR - koColumn(m, ctx); // koColumn is distance from the final; render that column rightmost
    (cols[r] = cols[r] || []).push(m);
  }
  const parts = ['<h3>Knockout</h3>'];
  cols.forEach((ms, r) => {
    parts.push(`<h4>${roundName(cols.length - 1 - r)}</h4>`);
    parts.push('<section class="grid">');
    for (const m of ms) parts.push(matchCard(m, ctx));
    parts.push('</section>');
  });
  return parts.join('');
}

function matchCard(m, ctx) {
  const t = schedTime(m);
  const meta = [m.venue ? esc(ctx.venues.get(m.venue) || m.venue) : 'TBD', t !== null ? fmtTime(t, ctx.tz) : 'TBD'].join(' · ');
  const state = (m.games || []).length && !isDone(m, ctx) ? ' — in play' : '';
  return `<article>${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${esc(m.id)} · ${esc(matchLabel(m, ctx))} · ${meta}${state}</div></article>`;
}

// Shared by bracket cards (standings) and the kiosk.
function sideRow(m, ctx, i) {
  const w = winnerIdx(m, ctx);
  const games = m.games || [];
  const score = m.forfeit === i ? '<span>forfeit</span>'
    : (games.length ? games.map(g => `<span>${i === 0 ? g.a : g.b}</span>`).join('') : '');
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${sideLabel(m.sides[i], ctx)}</span><span class="score">${score}</span></div>`;
}

function kioskCard(r, status) {
  const m = r.m, ctx = r.ctx;
  const state = matchState(m, ctx);
  const t = esc(fmtTime(r.t, ctx.tz));
  const meta = [esc(ctx.name), esc(matchLabel(m, ctx)), esc(state)].filter(Boolean).join(' · ');
  const badge = { overdue: 'Late', live: 'Now', next: 'Next' }[status];
  return `<article>
    ${sideRow(m, ctx, 0)}
    ${sideRow(m, ctx, 1)}
    <div class="meta"><span class="badge" data-status="${status}">${badge}</span>${meta} · <strong>${t}</strong></div>
  </article>`;
}

// Every category as a context — shared by the venue and player renderers.
function catCtxs(data) {
  return data.cats.map(c => makeCat(c, data.tjson));
}

function renderVenue(route, data) {
  if (!data.tjson) return '<p>Missing tournament data — has the tournament been pushed?</p>';
  const v = route.filter; // #slug/venues/<id> narrows to one court; no id → all courts
  const rows = [];
  const ctxs = catCtxs(data);
  for (const ctx of ctxs) {
    for (const m of ctx.matches) {
      if (!m || m.venue === undefined) continue;
      const t = schedTime(m);
      if (t === null) continue;
      rows.push({ m, t, ctx });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const now = Date.now();
  // venues with matches — a declared-but-unused court is simply absent
  const venueNames = new Map((data.tjson.venues || []).map(x => [x.id, x.name]));
  const venues = (data.tjson.venues || []).map(x => x.id).filter(id => rows.some(r => r.m.venue === id));
  const shown = v ? rows.filter(r => r.m.venue === v) : rows;
  const parts = [`<header><h1>${esc(data.t.name)}</h1><span id="k-clock"></span></header>`];
  const byVenue = new Map(venues.map(id => [id, []]));
  for (const r of shown) {
    if (byVenue.has(r.m.venue)) byVenue.get(r.m.venue).push(r); // rows pre-sorted, buckets stay sorted
  }
  let any = false;
  const cols = [];
  for (const id of venues) {
    const open = byVenue.get(id).filter(r => !isDone(r.m, r.ctx)); // a result removes the card, everything else stays
    if (!open.length) continue;
    any = true;
    const col = [];
    col.push(`<h2>${esc(venueNames.get(id) || id)}</h2>`);
    for (const r of open) col.push(kioskCard(r, kioskStatus(r, now)));
    cols.push(`<section>${col.join('')}</section>`);
  }
  parts.push(v ? cols.join('') : `<div>${cols.join('')}</div>`);
  if (!any) parts.push('<p>Nothing scheduled.</p>');
  return parts.join('');
}

// The "N more matches possible" line, placed where that span starts.
function possibleLine(b) {
  const range = b.min === b.max ? `at ${fmtTime(b.min, b.ctx.tz)}` : `between ${fmtTime(b.min, b.ctx.tz)} and ${fmtTime(b.max, b.ctx.tz)}`;
  const noun = b.count === 1 ? 'match' : 'matches';
  const howMany = b.count > 1 ? `Up to ${b.count} more` : '1 more';
  return `<p class="note">${howMany} ${esc(b.ctx.name)} ${noun} possible ${range} · depends on results</p>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return '<p>Missing tournament data — has the tournament been pushed?</p>';
  const pid = route.filter; // no id → the picker
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  if (!pid) { // no player id — the picker
    const items = players.map(p => `<li><a href="#${esc(data.t.slug)}/players/${esc(p.id)}">${esc(p.name || p.id)}</a></li>`);
    return `<header><nav><a href="#">Home</a> · <a href="#${esc(data.t.slug)}">${esc(data.t.name)}</a></nav><h1>Players</h1></header><p>Pick a player to see their schedule</p><ul>${items.join('') || '<li>No players.</li>'}</ul>`;
  }
  const p = players.find(x => x.id === pid);
  if (!p) return '<p>Player not found.</p>';
  const rows = [];
  const ctxs = catCtxs(data);
  for (const ctx of ctxs) {
    for (const { m, i, team } of playerMatches(ctx, pid)) {
      rows.push({ m, ctx, i, team, partner: [...team].filter(id => id !== pid) });
    }
  }
  rows.sort((a, b) => (schedTime(a.m) ?? Infinity) - (schedTime(b.m) ?? Infinity));
  const groups = new Map();
  for (const r of rows) {
    const t = schedTime(r.m);
    const key = t === null ? 'Time TBD' : dayKey(t, r.ctx.tz);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const blocksByDay = new Map(); // dayKey -> [{ ctx, min, max, count }]
  for (const ctx of ctxs) {
    const span = possibleSpan(ctx, pid);
    if (!span) continue;
    const key = dayKey(span.min, ctx.tz);
    if (!blocksByDay.has(key)) blocksByDay.set(key, []);
    blocksByDay.get(key).push({ ctx, ...span });
  }
  const parts = [`<header><nav><a href="#">Home</a> · <a href="#${esc(data.t.slug)}">${esc(data.t.name)}</a></nav><h1>${esc(p.name)}</h1></header>`];
  for (const [key, g] of groups) {
    parts.push(`<h2>${esc(key)}</h2>`);
    const day = [];
    const blocks = (blocksByDay.get(key) || []).sort((a, b) => a.min - b.min);
    let bi = 0;
    for (const r of g) {
      const t = schedTime(r.m);
      while (bi < blocks.length && blocks[bi].min < t) day.push(possibleLine(blocks[bi++]));
      const m = r.m, ctx = r.ctx;
      const oppSet = resolveSide(m.sides[1 - r.i], ctx);
      const opp = oppSet ? teamLabel(oppSet, ctx) : null;
      const w = winnerIdx(m, ctx);
      const isDoneMatch = w !== null;
      const isLive = !isDoneMatch && (m.games || []).length;
      const badge = isDoneMatch ? '<span class="p-badge" data-kind="done">Done</span>'
        : isLive ? '<span class="p-badge" data-kind="live">Now</span>' : '';
      const state = m.forfeit !== undefined ? (w === r.i ? 'W (forfeit)' : 'L (forfeit)')
        : (w === null ? matchState(m, ctx) : `${w === r.i ? 'W' : 'L'} · ${gamesText(m)}`);
      const withP = r.partner.length ? `with ${teamLabel(r.partner, ctx)}` : 'singles';
      const venue = m.venue ? ctx.venues.get(m.venue) || m.venue : 'TBD';
      day.push(`<article${isDoneMatch ? ' data-done' : ''}>
        <div class="side"><span>${t === null ? 'TBD' : fmtTime(t, ctx.tz)}</span><span>${esc(venue)}</span></div>
        <div>vs ${esc(opp || slotLabel(m.sides[1 - r.i], ctx))}</div>
        <div class="meta">${badge}${esc(ctx.name)} · ${esc(withP)}${state ? ' · ' + esc(state) : ''}</div>
      </article>`);
    }
    while (bi < blocks.length) day.push(possibleLine(blocks[bi++]));
    parts.push(`<div class="stack">${day.join('')}</div>`);
  }
  if (!rows.length) parts.push('<p>No matches.</p>');
  return parts.join('');
}

// ---------- boot ----------

// Read-once views (index/categories/players) don't poll — but a load that lands
// in a Pages deploy window or a network blip must not leave a permanent
// "missing" page. Two cheap recoveries, neither of which fires on the happy
// path: re-fetch when the tab returns to the foreground, and a bounded retry
// when the snapshot is detectably failed (no index entry, or no tournament data
// on a view that needs one). A genuinely empty repo or category still renders
// empty — a 404 is indistinguishable from absence, so empty states are never
// retried.
function boot() {
  const app = document.querySelector('main');
  const renderers = { index: renderIndex, categories: renderStandings, venues: renderVenue, players: renderPlayer };
  const pageTitle = (r, d) => { // index: GitBracket; standings/kiosk: bare tournament; players: "name — Players" or "name — player"
    if (r.view === 'index' || !d.t) return 'GitBracket';
    if (r.view === 'players') {
      if (r.filter) {
        const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.filter);
        if (p) return `${d.t.name} — ${p.name || p.id}`;
      }
      return `${d.t.name} — Players`;
    }
    return d.t.name; // categories (standings) and venues (kiosk)
  };
  let route = null;    // current fragment route — the kiosk poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let dataSlug = null; // slug the snapshot belongs to — a route change to another tournament reloads
  let lastHtml = '';   // skip re-render when nothing changed — keeps selection/focus on the player page
  let fails = 0;       // consecutive detectably-failed loads (read-once views only)
  let pollTimer = null, clockTimer = null;
  const MAX_FAILS = 3;
  const RETRY_MS = 5000;

  // Auto-refresh only on the kiosk; the other views are read-on-load.
  const setKiosk = on => {
    if (on && !pollTimer) {
      // jitter so a hall of kiosk screens doesn't fetch in lockstep
      pollTimer = setInterval(tick, POLL_MS + Math.random() * 5000);
      // Wall clock, tournament-local time. Kept out of the render HTML (empty
      // span) so the lastHtml change-guard isn't tripped every second; the poll
      // re-render replaces the span, so look it up fresh each tick.
      clockTimer = setInterval(() => {
        const el = document.getElementById('k-clock');
        if (el) el.textContent = fmtClock(Date.now(), (data && data.tjson && data.tjson.timezone) || 'UTC');
      }, 1000);
    } else if (!on && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
      clearInterval(clockTimer); clockTimer = null;
    }
  };

  const render = (r, d) => {
    data = d;
    dataSlug = r.slug;
    // the kiosk dark theme keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
    } catch (e) {
      app.innerHTML = '<p>Render error.</p>';
      console.error(e);
    }
  };

  const load = r => {
    loadAll(r, r.view === 'index').then(d => {
      if (r.view !== 'index' && !d.tjson) { // fetch failed or unknown slug — with a board, keep it and retry silently
        if (!data) app.innerHTML = '<p>Missing tournament data — has the tournament been pushed?</p>';
        if (++fails <= MAX_FAILS) setTimeout(() => load(r), RETRY_MS); // deploy window or blip — retry a few times, then give up
        return;
      }
      fails = 0;
      render(r, d);
    });
  };
  const tick = () => load(route);

  // Fragment navigation: same-slug view hops (categories → venues → players)
  // re-render from the cached snapshot; a different slug or the index reloads.
  const navigate = () => {
    const r = parseRoute();
    if (!r) { // reject → render an error, fetch nothing (a raw segment never reaches a URL)
      route = null;
      setKiosk(false);
      app.innerHTML = '<p>Bad URL.</p>';
      return;
    }
    route = r;
    setKiosk(r.view === 'venues');
    if (r.view === 'index' || r.slug !== dataSlug) {
      data = null;
      lastHtml = '';
      fails = 0;
      load(r);
    } else {
      render(r, data);
    }
  };

  navigate();
  window.addEventListener('hashchange', navigate);
  // read-once views: a load that failed gets another chance when the tab comes
  // back to the foreground (fresh attempt, fresh retry budget)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && route && route.view !== 'venues') { fails = 0; load(route); }
  });
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; browser <script> ignores these. Derive
// functions come from derive.js directly (required above, on globalThis).
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, loadAll, renderIndex, renderStandings, renderVenue, renderPlayer };
}
