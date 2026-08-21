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

// One page, fragment routing: #<slug>[/categories|venues|players[/<id>]].
// Segments are id-regex-checked first — a raw segment never reaches a URL.
function parseRoute(hash) {
  if (hash === undefined) hash = location.hash;
  const segs = String(hash).replace(/^#/, '').split('/');
  if (segs.length === 1 && segs[0] === '') return { view: 'index' };
  if (segs.length > 3 || segs.some(s => !s || !ID_RE.test(s))) return null; // #../../ -> reject
  const [slug, view, filter] = segs;
  if (view === undefined) return { slug, view: 'categories' };
  if (view === 'categories' || view === 'venues' || view === 'players') return filter === undefined ? { slug, view } : { slug, view, filter };
  return null;
}

async function loadAll(route, indexOnly) {
  if (indexOnly) {
    const raw = await fetchJson('tournaments.json');
    const index = Array.isArray(raw) ? raw : [];
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

// Breadcrumb trail; the current page lives in the h1 (every crumb is a link).
// hrefs arrive raw — esc once, at the attribute.
const crumbs = items => items.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join(' > ');

// The one missing-data message, verbatim in every view and the boot retry.
const MISSING = '<p>Missing tournament data — has the tournament been pushed?</p>';


const FULL_META = ['matchId', 'label', 'court', 'time'];
const matchGrid = (ms, ctx) => `<section class="grid">${ms.map(m => matchCard(m, ctx, { meta: FULL_META })).join('')}</section>`;

// Category pills — one toggle pattern for standings and picker.
const catPills = (cats, slug, base, activeId, dropHref) => cats.map(c => {
  const active = c.id === activeId;
  const href = active ? dropHref : `#${slug}/${base}/${c.id}`;
  return `<a href="${esc(href)}"${active ? ' aria-current="true"' : ''}>${esc(c.name)}</a>`;
}).join('');

function renderIndex(route, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .map(e => `<li><a href="#${esc(e.slug)}">${esc(e.name || e.slug)}</a> <a href="#${esc(e.slug)}/venues">kiosk</a></li>`);
  return `<h1>Tournaments</h1><ul>${items.join('') || '<li>No tournaments yet.</li>'}</ul>`;
}

function renderStandings(route, data) {
  if (!data.tjson) return MISSING;
  const parts = [`<header><nav class="split">${crumbs([['#', 'Home']])}<a href="#${esc(data.t.slug)}/players">Players</a></nav><h1>${esc(data.t.name)}</h1>`];
  parts.push(`<nav class="pills">${catPills(data.tjson.categories || [], data.t.slug, 'categories', route.filter, `#${data.t.slug}`)}</nav></header>`);
  for (const c of data.cats) {
    if (route.filter && c.meta.id !== route.filter) continue; // pills keep every category; only the section list narrows
    const ctx = makeCat(c, data.tjson);
    parts.push(`<h2>${esc(c.meta.name)}</h2>`);
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
    parts.push('<h3>Group matches</h3>');
    parts.push(matchGrid(grp, ctx));
    // Each table is a bridge node (id t-<pool>): feeders = its group matches, downstream = the knockout it seeds.
    parts.push('<h3>Pool standings</h3>');
    parts.push('<div class="pools">');
    for (const [pool, poolMs] of byPool) {
      const feed = poolMs.map(m => m.id).join(',');
      const down = ko.filter(m => (m.sides || []).some(s => s && s.kind === 'pool' && s.pool === pool)).map(m => m.id).join(',');
      parts.push(`<section class="pool" id="${nodeId(ctx.id, 't-' + String(pool))}" data-cat="${esc(ctx.id)}" data-feeders="${esc(feed)}" data-downstream="${esc(down)}"><h4>Pool ${esc(String(pool))}</h4>`);
      parts.push('<table><thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>GD</th><th>PD</th></tr></thead><tbody>');
      const st = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
      const ranks = poolRanks(st);
      st.forEach((r, i) => {
        const tied = isDeadTie(st, i + 1);
        const team = teamLabel(r.ids, ctx);
        parts.push(`<tr${tied ? ' data-tie' : ''}><td>${ranks[i]}</td><td>${esc(team)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${fmtDiff(r.gd)}</td><td>${fmtDiff(r.pd)}</td></tr>`);
      });
      parts.push('</tbody></table></section>');
    }
    parts.push('</div>');
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
    parts.push(matchGrid(ms, ctx));
  });
  return parts.join('');
}

// opts.meta picks the meta items (fixed vocabulary); opts.head is an optional
// [left, right] headline row — cells are item keys or pre-rendered HTML.
// Node ids are namespaced by category: match ids repeat across categories, so
// an unqualified id makes getElementById hit the wrong (first) card.
const nodeId = (cat, id) => { id = String(id); return id.startsWith('t-') ? `t-${cat}-${id.slice(2)}` : `m-${cat}-${id}`; };

function matchCard(m, ctx, opts = {}) {
  const t = schedTime(m, ctx.tz);
  const item = {
    catName: esc(ctx.name),
    matchId: esc(m.id),
    label: esc(matchLabel(m, ctx)),
    court: m.venue ? esc(ctx.venues.get(m.venue) || m.venue) : 'TBD',
    time: t !== null ? esc(fmtTime(t, ctx.tz)) : 'TBD',
  };
  const meta = opts.meta.map(k => item[k]).join(' · ');
  const head = opts.head ? `<div class="head">${opts.head.map(c => `<span>${item[c] ?? c}</span>`).join('')}</div>` : '';
  const chain = chainIds(m, ctx);
  return `<article id="${nodeId(ctx.id, m.id)}" data-cat="${esc(ctx.id)}"${opts.done ? ' data-done' : ''}${opts.status ? ` data-status="${opts.status}"` : ''} data-feeders="${esc(chain.feeders)}" data-downstream="${esc(chain.downstream)}">${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
}

function sideRow(m, ctx, i) {
  const w = winnerIdx(m);
  const games = m.games || [];
  const r = m.result;
  // one slot per best-of game — placeholders keep the shape, so no label is needed
  const bo = bestOfOf(m, ctx) || 1; // unset stage config -> one unmarked slot
  const slot = () => Array.from({ length: bo }, (_, g) => {
    const game = games[g];
    return `<span${game ? '' : ' class="ph"'}>${game ? (i === 0 ? game.a : game.b) : '·'}</span>`;
  }).join('');
  // the winning side carries the W/O mark (tennis draws put "w/o" beside the
  // advancing name); void has no winner, so no data-win mark anywhere.
  const score = !r || r.status === 'played' ? slot()
    : r.status === 'void' ? '<span>void</span>'
    : sideIdx(r.winner) === i ? '<span>W/O</span>'
    : slot();
  return `<div class="side"${w === i ? ' data-win' : ''}><span>${esc(sideLabel(m.sides[i], ctx))}</span><span class="score">${score}</span></div>`;
}

function feedsRefs(m, ctx) {
  const refs = [];
  for (const X of ctx.matches) {
    if (!X || !Array.isArray(X.sides)) continue;
    for (const s of X.sides) {
      if (s && s.kind === 'match' && s.match === m.id) refs.push(X);
    }
  }
  return refs;
}


function chainIds(m, ctx) {
  const feeders = [];
  for (const s of (m.sides || [])) {
    if (s && s.kind === 'match') {
      const ref = ctx.byId.get(s.match);
      feeders.push(ref ? ref.id : s.match);
    } else if (s && s.kind === 'pool') {
      feeders.push(`t-${s.pool}`); // a pool seed draws from the whole table node
    }
  }
  const downstream = feedsRefs(m, ctx).map(X => X.id);
  if (m.pool !== undefined) downstream.push(`t-${m.pool}`); // a group match feeds its pool's standings
  return { feeders: feeders.join(','), downstream: downstream.join(',') };
}

function catCtxs(data) {
  return data.cats.map(c => makeCat(c, data.tjson));
}

function renderVenue(route, data, now = Date.now()) {
  if (!data.tjson) return MISSING;
  const v = route.filter;
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
  const parts = [`<header><h1>${esc(data.t.name)}</h1><span id="k-clock"></span></header>`];
  const byVenue = new Map(venues.map(id => [id, []]));
  for (const r of shown) {
    if (byVenue.has(r.m.venue)) byVenue.get(r.m.venue).push(r); // rows pre-sorted, buckets stay sorted
  }
  let any = false;
  const cols = [];
  for (const id of venues) {
    const open = byVenue.get(id).filter(r => !isDone(r.m)); // a result removes the card, everything else stays
    if (!open.length) continue;
    any = true;
    const col = [];
    col.push(`<h2>${esc(venueNames.get(id) || id)}</h2>`);
    col.push('<div class="stack">');
    for (const r of open) {
      const st = kioskStatus(r, now);
      // status colors the headline time; a late start gets the remark cell beside it
      col.push(matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
        head: [st === 'overdue' ? `${esc(fmtTime(r.t, r.ctx.tz))} <span class="delayed">delayed</span>` : 'time'], status: st }));
    }
    col.push('</div>');
    cols.push(`<section>${col.join('')}</section>`);
  }
  parts.push(v ? cols.join('') : `<div class="board">${cols.join('')}</div>`);
  if (!any) parts.push('<p>Nothing scheduled.</p>');
  return parts.join('');
}

function possibleLine(b) {
  const range = b.min === b.max ? `at ${fmtTime(b.min, b.ctx.tz)}` : `between ${fmtTime(b.min, b.ctx.tz)} and ${fmtTime(b.max, b.ctx.tz)}`;
  const noun = b.count === 1 ? 'match' : 'matches';
  return `<p class="note">${b.count} more ${noun} possible in ${esc(b.ctx.name)} starting ${range}</p>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return MISSING;
  const pid = route.filter;
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = pid ? players.find(x => x.id === pid) : null;
  if (!p) {
    if (pid && !(data.tjson.categories || []).some(c => c.id === pid)) return '<p>Player not found.</p>';

    const ctxs = catCtxs(data);
    const pills = catPills(data.tjson.categories || [], data.t.slug, 'players', pid, `#${data.t.slug}/players`);
    const sel = ctxs.find(c => c.id === pid);
    const items = players.filter(pl => !sel || playerMatches(sel, pl.id).length).map(pl => {
      const lbls = ctxs.map(c => playerMatches(c, pl.id).length ? `<span class="cat-label">${esc(c.name)}</span>` : '').join('');
      const cluster = lbls ? `<span>${lbls}</span>` : '';
      return `<li><a href="${esc(`#${data.t.slug}/players/${pl.id}`)}">${esc(pl.name || pl.id)}</a>${cluster}</li>`;
    }).join('');
    return `<header><nav>${crumbs([['#', 'Home'], [`#${data.t.slug}`, data.t.name]])}</nav><h1>Players</h1><nav class="pills">${pills}</nav></header><ul class="players">${items || `<li>${sel ? 'No players in this category.' : 'No players.'}</li>`}</ul>`;
  }
  const rows = [];
  const ctxs = catCtxs(data);
  for (const ctx of ctxs) {
    for (const { m } of playerMatches(ctx, pid)) {
      rows.push({ m, ctx });
    }
  }
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  const groups = new Map();
  for (const r of rows) {
    const t = schedTime(r.m, r.ctx.tz);
    const key = t === null ? 'Time TBD' : dayKey(t, r.ctx.tz);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const blocksByDay = new Map();
  for (const ctx of ctxs) {
    const span = possibleSpan(ctx, pid);
    if (!span) continue;
    const key = dayKey(span.min, ctx.tz);
    if (!blocksByDay.has(key)) blocksByDay.set(key, []);
    blocksByDay.get(key).push({ ctx, ...span });
  }
  const parts = [`<header><nav>${crumbs([['#', 'Home'], [`#${data.t.slug}`, data.t.name], [`#${data.t.slug}/players`, 'Players']])}</nav><h1>${esc(p.name)}</h1></header>`];
  for (const [key, g] of groups) {
    parts.push(`<h2>${esc(key)}</h2>`);
    const day = [];
    const blocks = (blocksByDay.get(key) || []).sort((a, b) => a.min - b.min);
    let bi = 0;
    for (const r of g) {
      const t = schedTime(r.m, r.ctx.tz), m = r.m, ctx = r.ctx;
      while (bi < blocks.length && blocks[bi].min < t) day.push(possibleLine(blocks[bi++]));
      // same sideRow as bracket cards; headline time · court, meta cat · label
      day.push(matchCard(m, ctx, {
        done: isDone(m),
        meta: ['catName', 'label'],
        head: ['time', 'court'],
      }));
    }
    while (bi < blocks.length) day.push(possibleLine(blocks[bi++]));
    parts.push(`<div class="stack">${day.join('')}</div>`);
  }
  if (!rows.length) parts.push('<p>No matches.</p>');
  return parts.join('');
}

// ---------- boot ----------

// Read-once views don't poll, but a load in a deploy window must not leave a
// permanent "missing" page: refetch on tab-return, and retry a few times only
// when the load detectably failed (a 404 is indistinguishable from absence,
// so empty states are never retried).
function boot() {
  const app = document.querySelector('main');
  const renderers = { index: renderIndex, categories: renderStandings, venues: renderVenue, players: renderPlayer };
  const pageTitle = (r, d) => { // index: Bracket; standings/kiosk: bare tournament; players: "name — Players" or "name — player"
    if (r.view === 'index' || !d.t) return 'Bracket';
    if (r.view === 'players') {
      if (r.filter) {
        const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.filter);
        if (p) return `${d.t.name} — ${p.name || p.id}`;
      }
      return `${d.t.name} — Players`;
    }
    return d.t.name;
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
      // Clock lives in an empty span so the lastHtml change-guard isn't
      // tripped every second; look it up fresh each tick (the poll re-renders).
      clockTimer = setInterval(() => {
        const el = document.getElementById('k-clock');
        if (el) el.textContent = fmtTime(Date.now(), (data && data.tjson && data.tjson.timezone) || 'UTC');
      }, 1000);
    } else if (!on && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
      clearInterval(clockTimer); clockTimer = null;
    }
  };

  const load = r => {
    loadAll(r, r.view === 'index').then(d => {
      if (route !== r) return; // superseded by a newer navigation — don't render a stale page
      if (r.view !== 'index' && !d.tjson) { // fetch failed or unknown slug — with a board, keep it and retry silently
        if (!data) app.innerHTML = MISSING;
        if (++fails <= MAX_FAILS) setTimeout(() => load(r), RETRY_MS); // deploy window or blip — retry a few times, then give up
        return;
      }
      fails = 0;
      render(r, d);
    });
  };
  const tick = () => load(route);

  // DOM-toggled highlight: no re-render, so scroll survives the kiosk poll.
  // data-hl is the highlight state; data-feeders / data-downstream on the node
  // are the graph metadata the renderer emits. Nodes are matches (m-<id>) and
  // pool tables (t-<pool>), so a table bridges the group stage to the knockout.
  let selected = null; // full node id: "m-7" or "t-A"
  const applySelection = () => {
    document.querySelectorAll('[data-hl]').forEach(el => { delete el.dataset.hl; });
    if (!selected) return;
    const sel = document.getElementById(selected);
    if (!sel) return; // selected node no longer in the rendered set (done match on kiosk, etc.)
    sel.dataset.hl = 'sel';
    // data attrs hold bare ids ("7", "t-A") in the selected node's category — resolve to DOM ids.
    for (const id of (sel.dataset.feeders || '').split(',').filter(Boolean)) document.getElementById(nodeId(sel.dataset.cat, id))?.setAttribute('data-hl', 'feed');
    for (const id of (sel.dataset.downstream || '').split(',').filter(Boolean)) document.getElementById(nodeId(sel.dataset.cat, id))?.setAttribute('data-hl', 'down');
  };

  const render = (r, d) => {
    data = d;
    dataSlug = r.slug;
    // the kiosk dark theme keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; applySelection(); }
    } catch (e) {
      app.innerHTML = '<p>Render error.</p>';
      console.error(e);
    }
  };

  document.addEventListener('click', e => {
    const node = e.target.closest('[id^="m-"], [id^="t-"]');
    if (!node) { if (selected !== null) { selected = null; applySelection(); } return; }
    selected = selected === node.id ? null : node.id;
    applySelection();
  });

  // Fragment navigation: same-slug view hops (categories → venues → players)
  // re-render from the cached snapshot; a different slug or the index reloads.
  const navigate = () => {
    const r = parseRoute();
    if (!r) {
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

// CommonJS exports for node tests; the browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, loadAll, renderIndex, renderStandings, renderVenue, renderPlayer };
}
