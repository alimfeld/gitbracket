'use strict';
// app.js — fetch/render/boot for the GitBracket pages. No build step, no deps.
// The derive engine (standings, slot resolution, scheduling, labels, time)
// lives in derive.js, loaded before this file in the browser and required here
// in node; this file is only the data loading, the HTML renderers, and the
// boot. `node --test` runs the derive tests against fixtures/ (test/ dir).

const POLL_MS = 30000;

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

// SPEC: every URL param is checked against the id regex before use —
// reject → render an error, fetch nothing (a raw param never reaches a URL).
function parseParams() {
  const p = new URLSearchParams(location.search);
  for (const [, v] of p) {
    if (v && !ID_RE.test(v)) return null; // ?t=../../ -> reject, fetch nothing
  }
  return p;
}

async function loadAll(params, indexOnly) {
  const index = (await fetchJson('tournaments.json')) || [];
  // a non-array index stops here (renders an empty list, not a crash)
  if (!Array.isArray(index)) return { index: [], t: null, tjson: null, cats: [] };
  if (indexOnly) return { index, t: null, tjson: null, cats: [] };
  const slug = params.get('t');
  const entry = slug ? index.find(e => e && e.slug === slug) : index[index.length - 1];
  if (!entry || typeof entry.slug !== 'string' || !ID_RE.test(entry.slug)) {
    return { index, t: null, tjson: null, cats: [] };
  }
  const tjson = await fetchJson(`tournaments/${entry.slug}/tournament.json`);
  const cats = [];
  if (tjson && Array.isArray(tjson.categories)) {
    const wanted = params.get('c');
    for (const meta of tjson.categories) {
      if (wanted && meta.id !== wanted) continue;
      const j = await fetchJson(`tournaments/${entry.slug}/matches/${meta.id}.json`);
      cats.push({ meta, matches: (j && Array.isArray(j.matches)) ? j.matches : [] });
    }
  }
  return { index, t: entry, tjson, cats };
}

// ---------- renderers ----------

function renderIndex(params, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .map(e => `<li><a href="standings.html?t=${esc(e.slug)}">${esc(e.name || e.slug)}</a> <a class="kiosk" href="venue.html?t=${esc(e.slug)}">kiosk</a></li>`);
  return `<h1>Tournaments</h1><ul class="tournaments">${items.join('') || '<li>No tournaments yet.</li>'}</ul>`;
}

function renderStandings(params, data) {
  if (!data.tjson) return '<p>Missing tournament.json — has the tournament been pushed?</p>';
  const parts = [`<h1>${esc(data.t.name)}</h1>`];
  parts.push(`<p class="sub"><a href="index.html">Home</a> · <a href="player.html?t=${esc(data.t.slug)}">Player schedules</a></p>`);
  // nav from the full category list, not the ?c=-filtered cats — a filtered page must still show every pill
  const nav = (data.tjson.categories || []).map(c => {
    const active = params.get('c') === c.id;
    // clicking the active category drops the ?c= filter (toggle off)
    const href = active ? `standings.html?t=${esc(data.t.slug)}` : `standings.html?t=${esc(data.t.slug)}&c=${esc(c.id)}`;
    return `<a href="${href}"${active ? ' class="on"' : ''}>${esc(c.name)}</a>`;
  });
  parts.push(`<nav class="cats">${nav.join('')}</nav>`);
  for (const c of data.cats) {
    const ctx = makeCat(c, data.tjson);
    parts.push(`<h2>${esc(c.meta.name)}</h2>`);
    const pools = [];
    for (const m of ctx.matches) {
      if (m && m.pool !== undefined && !pools.includes(m.pool)) pools.push(m.pool);
    }
    for (const pool of pools) {
      const poolMs = ctx.matches.filter(m => m && m.pool === pool);
      parts.push(`<h3>Pool ${esc(String(pool))}</h3>`);
      parts.push('<div class="poolgrid">');
      // pools come from matches, so partial standings always resolve
      const st = poolStandings(ctx, pool, true);
      parts.push('<table class="standings"><thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>GD</th><th>PD</th></tr></thead><tbody>');
      let rank = 0;
      st.forEach((r, i) => {
        const tied = isDeadTie(st, i + 1);
        // shared rank for ties: same record as the row above keeps the group's first rank (1 1 1 4)
        if (i === 0 || !sameRecord(st[i - 1], r)) rank = i + 1;
        const team = teamLabel(r.ids, ctx);
        parts.push(`<tr${tied ? ' class="tie"' : ''}><td>${rank}</td><td>${team}</td><td>${r.wins}</td><td>${r.losses}</td><td>${fmtDiff(r.gd)}</td><td>${fmtDiff(r.pd)}</td></tr>`);
      });
      parts.push('</tbody></table>');
      for (const m of poolMs) parts.push(matchCard(m, ctx));
      parts.push('</div>');
    }
    const ko = ctx.matches.filter(m => m && m.pool === undefined);
    if (ko.length) {
      parts.push('<h3>Knockout</h3>');
      parts.push(bracketHtml(ctx, ko));
    }
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
  const parts = ['<div class="bracket">'];
  cols.forEach((ms, r) => {
    parts.push(`<div class="bcol"><div class="bhead">${roundName(cols.length - 1 - r)}</div>`);
    for (const m of ms) parts.push(matchCard(m, ctx));
    parts.push('</div>');
  });
  parts.push('</div>');
  return parts.join('');
}

function matchCard(m, ctx) {
  const t = schedTime(m);
  const meta = [m.venue ? esc(ctx.venues.get(m.venue) || m.venue) : 'TBD', t !== null ? fmtTime(t, ctx.tz) : 'TBD'].join(' · ');
  const state = (m.games || []).length && !isDone(m, ctx) ? ' — in play' : '';
  return `<div class="bm">${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="bmeta"><span class="mid">${esc(m.id)}</span> · ${esc(matchLabel(m, ctx))} · ${meta}${state}</div></div>`;
}

// One score span per game, right-clustered on the side's own row; the winner's
// row is bold. Shared by bracket cards (standings) and the kiosk.
function sideRow(m, ctx, i) {
  const w = winnerIdx(m, ctx);
  const games = m.games || [];
  const score = m.forfeit === i ? '<span class="bscore">forfeit</span>'
    : (games.length ? games.map(g => `<span class="bscore">${i === 0 ? g.a : g.b}</span>`).join('') : '');
  return `<div class="bs${w === i ? ' win' : ''}"><span>${sideLabel(m.sides[i], ctx)}</span><span class="bscores">${score}</span></div>`;
}

function kioskCard(r, status) {
  const m = r.m, ctx = r.ctx;
  const state = matchState(m, ctx);
  const meta = [esc(ctx.name), esc(matchLabel(m, ctx)), esc(state), esc(fmtTime(r.t, ctx.tz))].filter(Boolean).join(' · '); // category first, then pool; venue is the group header now
  const badge = { overdue: 'Late', live: 'Live', next: 'Next' }[status];
  return `<div class="km">
    ${sideRow(m, ctx, 0)}
    ${sideRow(m, ctx, 1)}
    <div class="kmeta"><span class="k-badge ${status}">${badge}</span>${meta}</div>
  </div>`;
}

function renderVenue(params, data) {
  if (!data.tjson) return '<p>Missing tournament.json — has the tournament been pushed?</p>';
  const v = params.get('v');
  const rows = [];
  const ctxs = data.cats.map(c => makeCat(c, data.tjson));
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
  const parts = [`<div class="k-head"><h1>${esc(data.t.name)}</h1><span class="k-clock" id="k-clock"></span></div>`]; // title left, wall clock right; the court shows as the column header
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
    col.push(`<h2 class="k-venue">${esc(venueNames.get(id) || id)}</h2>`);
    for (const r of open) col.push(kioskCard(r, kioskStatus(r, now)));
    // one column per venue, side by side on the all-venues board
    cols.push(`<div class="k-venue-col">${col.join('')}</div>`);
  }
  parts.push(v ? cols.join('') : `<div class="k-cols">${cols.join('')}</div>`);
  if (!any) parts.push('<p class="k-empty">Nothing scheduled.</p>');
  return parts.join('');
}

// "N more <category> matches possible between H:MM and H:MM · depends on
// results" — the open-span line, placed in the schedule where that span starts.
function possibleLine(b) {
  const range = b.min === b.max ? `at ${fmtTime(b.min, b.ctx.tz)}` : `between ${fmtTime(b.min, b.ctx.tz)} and ${fmtTime(b.max, b.ctx.tz)}`;
  const noun = b.count === 1 ? 'match' : 'matches';
  const howMany = b.count > 1 ? `Up to ${b.count} more` : '1 more';
  return `<p class="pm-possible">${howMany} ${esc(b.ctx.name)} ${noun} possible ${range} · depends on results</p>`;
}

function renderPlayer(params, data) {
  if (!data.tjson) return '<p>Missing tournament.json — has the tournament been pushed?</p>';
  const pid = params.get('p');
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  if (!pid) { // no ?p= — the picker, one page per player
    const items = players.map(p => `<li><a href="player.html?t=${esc(data.t.slug)}&p=${esc(p.id)}">${esc(p.name || p.id)}</a></li>`);
    return `<h1>Players</h1><p class="sub"><a href="index.html">Home</a> · <a href="standings.html?t=${esc(data.t.slug)}">${esc(data.t.name)}</a></p><p class="sub">Pick a player to see their schedule</p><ul class="tournaments">${items.join('') || '<li>No players.</li>'}</ul>`;
  }
  const p = players.find(x => x.id === pid);
  if (!p) return '<p>Player not found.</p>';
  const rows = [];
  const ctxs = data.cats.map(c => makeCat(c, data.tjson));
  for (const ctx of ctxs) {
    for (const { m, i, team } of playerMatches(ctx, pid)) {
      rows.push({ m, ctx, i, team, partner: [...team].filter(id => id !== pid) });
    }
  }
  const now = Date.now();
  const delayByVenue = venueBacklog(ctxs, now);
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
  const parts = [`<h1>${esc(p.name)}</h1>`, `<p class="sub"><a href="index.html">Home</a> · <a href="standings.html?t=${esc(data.t.slug)}">${esc(data.t.name)}</a></p>`];
  for (const [key, g] of groups) {
    parts.push(`<h2>${esc(key)}</h2>`);
    const blocks = (blocksByDay.get(key) || []).sort((a, b) => a.min - b.min);
    let bi = 0;
    for (const r of g) {
      const t = schedTime(r.m);
      while (bi < blocks.length && blocks[bi].min < t) parts.push(possibleLine(blocks[bi++]));
      const m = r.m, ctx = r.ctx;
      const oppSet = resolveSide(m.sides[1 - r.i], ctx);
      const opp = oppSet ? teamLabel(oppSet, ctx) : null;
      const w = winnerIdx(m, ctx);
      const state = m.forfeit !== undefined ? (w === r.i ? 'W (forfeit)' : 'L (forfeit)')
        : (w === null ? matchState(m, ctx) : `${w === r.i ? 'W' : 'L'} · ${gamesText(m)}`);
      const withP = r.partner.length ? teamLabel(r.partner, ctx) : '— (singles)';
      const venue = m.venue ? ctx.venues.get(m.venue) || m.venue : 'TBD';
      const late = delayNote(t, m, ctx, delayByVenue, now);
      parts.push(`<div class="pm">
        <div class="pmtop"><span class="pmtime">${t === null ? 'TBD' : fmtTime(t, ctx.tz)}</span><span class="pmcourt">${esc(venue)}</span></div>
        <div class="pmopp">vs ${esc(opp || slotLabel(m.sides[1 - r.i], ctx))}</div>
        <div class="pmpartner">with ${esc(withP)}</div>
        <div class="pmmeta">${esc(ctx.name)}${state ? ' · ' + esc(state) : ''}${late}</div>
      </div>`);
    }
    while (bi < blocks.length) parts.push(possibleLine(blocks[bi++]));
  }
  if (!rows.length) parts.push('<p>No matches.</p>');
  return parts.join('');
}

// ---------- boot ----------

// Read-once pages (index/standings/player) don't poll — but a load that lands
// in a Pages deploy window or a network blip must not leave a permanent
// "missing" page. Two cheap recoveries, neither of which fires on the happy
// path: re-fetch when the tab returns to the foreground, and a bounded retry
// when the snapshot is detectably failed (no index entry, or no tournament.json
// on a page that needs one). A genuinely empty repo or category still renders
// empty — a 404 is indistinguishable from absence, so empty states are never
// retried.
function boot() {
  const params = parseParams();
  const app = document.getElementById('app');
  if (!params) {
    app.innerHTML = '<p>Bad URL parameters.</p>';
    return;
  }
  const renderers = { index: renderIndex, venue: renderVenue, player: renderPlayer, standings: renderStandings };
  const renderer = renderers[document.body.dataset.page] || renderIndex;
  const page = document.body.dataset.page;
  let data = null; // last good snapshot — a failed poll keeps the board up
  let lastHtml = ''; // skip re-render when nothing changed — keeps selection/focus on the player page
  let fails = 0; // consecutive detectably-failed loads (read-once pages only)
  const MAX_FAILS = 3;
  const RETRY_MS = 5000;
  const tick = () => {
    loadAll(params, page === 'index').then(d => {
      if (page !== 'index' && data && !d.t) { // index fetch failed — keep the last board
        if (++fails <= MAX_FAILS) setTimeout(tick, RETRY_MS);
        return;
      }
      data = d;
      if (page !== 'index' && !data.t) {
        app.innerHTML = '<p>Tournament not found.</p>';
        if (++fails <= MAX_FAILS) setTimeout(tick, RETRY_MS); // deploy window or blip — retry a few times, then give up
        return;
      }
      if (page !== 'index' && !data.tjson) {
        app.innerHTML = '<p>Missing tournament.json — has the tournament been pushed?</p>';
        if (++fails <= MAX_FAILS) setTimeout(tick, RETRY_MS);
        return;
      }
      fails = 0;
      try {
        const html = renderer(params, data);
        if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
      } catch (e) {
        app.innerHTML = '<p>Render error.</p>';
        console.error(e);
      }
    });
  };
  tick();
  // Auto-refresh only on the kiosk; the other pages are read-on-load.
  if (page === 'venue') {
    // ponytail: jitter so a hall of kiosk screens doesn't fetch in lockstep
    setInterval(tick, POLL_MS + Math.random() * 5000);
    // Wall clock, tournament-local time. Kept out of the render HTML (empty
    // span) so the lastHtml change-guard isn't tripped every second; the poll
    // re-render replaces the span, so look it up fresh each tick.
    setInterval(() => {
      const el = document.getElementById('k-clock');
      if (el) el.textContent = fmtClock(Date.now(), (data && data.tjson && data.tjson.timezone) || 'UTC');
    }, 1000);
  } else {
    // read-once pages: a load that failed gets another chance when the tab
    // comes back to the foreground (fresh attempt, fresh retry budget)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { fails = 0; tick(); }
    });
  }
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tools (tests, validate, cli, schedule import from
// app.js or derive.js directly); browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { ...require('./derive.js'), renderIndex, renderStandings, renderVenue, renderPlayer };
}
