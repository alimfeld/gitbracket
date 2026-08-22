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

// One page, fragment routing: #<slug>[/categories|venues|me[/pick|<player-id>]].
// Segments are id-regex-checked first — a raw segment never reaches a URL.
function parseRoute(hash) {
  if (hash === undefined) hash = location.hash;
  const segs = String(hash).replace(/^#/, '').split('/');
  if (segs.length === 1 && segs[0] === '') return { view: 'index' };
  if (segs.length > 3 || segs.some(s => !s || !ID_RE.test(s))) return null; // #../../ -> reject
  const [slug, view, filter] = segs;
  if (view === undefined) return { slug, view: 'categories' };
  if (view === 'me') return filter === undefined ? { slug, view } : { slug, view, filter }; // me/<id> picks a player; me/pick forces the picker
  if (view === 'categories' || view === 'venues') return filter === undefined ? { slug, view } : { slug, view, filter };
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

const segmentBar = (slug, view) => {
  const t = view === 'categories', m = view === 'me';
  return `<nav class="segments" aria-label="Views"><a href="#${esc(slug)}"${t ? ' aria-current="true"' : ''}>Tournament</a><a href="#${esc(slug)}/me"${m ? ' aria-current="true"' : ''}>My Schedule</a></nav>`;
};

// The one missing-data message, verbatim in every view and the boot retry.
const MISSING = '<p>Missing tournament data — has the tournament been pushed?</p>';


const FULL_META = ['matchId', 'label', 'court', 'time'];
const matchGrid = (ms, ctx) => `<section class="grid">${ms.map(m => matchCard(m, ctx, { meta: FULL_META })).join('')}</section>`;

// Category pills — the tournament page's category filter.
const catPills = (cats, slug, activeId, dropHref) => cats.map(c => {
  const active = c.id === activeId;
  const href = active ? dropHref : `#${slug}/categories/${c.id}`;
  return `<a href="${esc(href)}"${active ? ' aria-current="true"' : ''}>${esc(c.name)}</a>`;
}).join('');

function renderIndex(route, data) {
  const items = data.index
    .filter(e => e && typeof e.slug === 'string' && ID_RE.test(e.slug))
    .map(e => `<li><a href="#${esc(e.slug)}">${esc(e.name || e.slug)}</a> <a href="#${esc(e.slug)}/venues">kiosk</a></li>`);
  return `<h1>Tournaments</h1><ul>${items.join('') || '<li>No tournaments yet.</li>'}</ul>`;
}

function renderTournament(route, data) {
  if (!data.tjson) return MISSING;
  const tz = data.tjson.timezone || 'UTC';
  const parts = [segmentBar(data.t.slug, 'categories'), `<header><h1>${esc(data.t.name)}</h1>`];
  // the day and timezone are facts from the schedule — this page never trusts a clock
  const ts = (data.cats || []).flatMap(c => (c.matches || []).map(m => schedTime(m, tz))).filter(Number.isFinite);
  if (ts.length) {
    const day = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(Math.min(...ts));
    parts.push(`<p class="dayline">${esc(day)} · times are local${tz !== 'UTC' ? ` (${esc(tz)})` : ''}</p>`);
  }
  parts.push(`<nav class="pills" aria-label="Categories">${catPills(data.tjson.categories || [], data.t.slug, route.filter, `#${data.t.slug}`)}</nav></header>`);
  for (const c of data.cats) {
    if (route.filter && c.meta.id !== route.filter) continue; // pills keep every category; only the section list narrows
    parts.push(catSection(makeCat(c, data.tjson)));
  }
  return parts.join('');
}

// data-only: played/unplayed + scheduled times, never the device clock
function phaseChip(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return '';
  if (ms.every(isDone)) return '<span class="chip">finished</span>';
  if (!ms.some(isDone)) {
    const ts = ms.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    return `<span class="chip">starts ${ts.length ? fmtTime(Math.min(...ts), ctx.tz) : 'soon'}</span>`;
  }
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) return `<span class="chip">groups · ${grp.filter(isDone).length} of ${grp.length}</span>`;
  const next = ms.find(m => m.pool === undefined && !isDone(m));
  return `<span class="chip">knockout · ${next ? roundName(koColumn(next, ctx)) : 'awaiting'}</span>`;
}

function catSection(ctx) {
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
  parts.push(`<h2>${esc(ctx.name)} ${phaseChip(ctx)}</h2>`);
  // always visible: the tables answer "which pool am I in, who else is in mine"
  if (byPool.size) {
    parts.push('<h3>Pools</h3><div class="pools">');
    for (const [pool, poolMs] of byPool) {
      // Each table is a bridge node (id t-<pool>): feeders = its group matches, downstream = the knockout it seeds.
      const adv = poolAdvance(ctx, pool);
      const note = !adv || adv.total === 0 ? ''
        : adv.count >= adv.total ? 'All teams advance'
        : adv.top ? `Top ${adv.count} advance`
        : `${adv.count} teams advance`;
      parts.push(`<section class="pool"><h4>Pool ${esc(String(pool))}${note ? ` <span class="adv">${esc(note)}</span>` : ''}</h4>`);
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
  }
  // folds to a one-line summary once the groups are decided
  if (grp.length) {
    const played = grp.filter(isDone).length;
    const label = played > 0 ? `Group matches · ${played} of ${grp.length} played` : `Group matches · ${grp.length}`;
    parts.push(`<details${played < grp.length ? ' open' : ''}><summary>${esc(label)}</summary>${matchGrid(grp, ctx)}</details>`);
  }
  if (ko.length) parts.push(bracketHtml(ctx, ko));
  return parts.join('');
}

function bracketHtml(ctx, ko) {
  const cols = [];
  const maxR = ko.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  for (const m of ko) {
    const r = maxR - koColumn(m, ctx); // koColumn is distance from the final; render that column rightmost
    (cols[r] = cols[r] || []).push(m);
  }
  const parts = ['<h3>Knockout stage</h3>'];
  cols.forEach((ms, r) => {
    parts.push(`<h4>${roundName(cols.length - 1 - r)}</h4>`);
    parts.push(matchGrid(ms, ctx));
  });
  return parts.join('');
}

// opts.meta picks the meta items (fixed vocabulary); opts.head is an optional
// [left, right] headline row — cells are item keys or pre-rendered HTML.
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
  return `<article${opts.next ? ' data-next' : ''}${opts.status ? ` data-status="${opts.status}"` : ''}>${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
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
  const parts = [`<header><h1>${esc(data.t.name)}</h1><time id="k-clock"></time></header>`];
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
  const pid = route.filter;
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = pid ? players.find(x => x.id === pid) : null;
  if (!p) {
    // only participants are pickable — a pick must always render a schedule
    const ctxs = catCtxs(data);
    const items = players.filter(pl => ctxs.some(c => playerMatches(c, pl.id).length))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map(pl => `<li><a href="#${esc(data.t.slug)}/me/${esc(pl.id)}">${esc(pl.name || pl.id)}</a></li>`)
      .join('');
    return `${segmentBar(data.t.slug, 'me')}<header><h1>Pick your player</h1></header><ul>${items || '<li>No players yet.</li>'}</ul>`;
  }
  const rows = [];
  const ctxs = catCtxs(data);
  for (const ctx of ctxs) {
    for (const pm of playerMatches(ctx, pid)) rows.push({ m: pm.m, i: pm.i, ctx });
  }
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  // record and next, straight from results and scheduled times — no clock
  const wins = rows.filter(r => winnerIdx(r.m) === r.i).length;
  const losses = rows.filter(r => winnerIdx(r.m) !== null && winnerIdx(r.m) !== r.i).length; // void: settled, neither
  const next = rows.find(r => !isDone(r.m));
  const nextT = next && schedTime(next.m, next.ctx.tz);
  const groups = new Map();
  for (const r of rows) {
    const t = schedTime(r.m, r.ctx.tz);
    const key = t === null ? 'Time TBD' : dayShort(t, r.ctx.tz);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const blocksByDay = new Map();
  for (const ctx of ctxs) {
    const span = possibleSpan(ctx, pid);
    if (!span) continue;
    const key = dayShort(span.min, ctx.tz);
    if (!blocksByDay.has(key)) blocksByDay.set(key, []);
    blocksByDay.get(key).push({ ctx, ...span });
  }
  // the schedule is "me" on this device; Not you? returns to the picker
  const parts = [segmentBar(data.t.slug, 'me'), `<header><div class="title-row"><h1>${esc(p.name)}</h1><a class="top" href="#${esc(data.t.slug)}/me/pick">Not you?</a></div></header>`];
  if (rows.length) parts.push(`<p class="dayline">${wins} ${wins === 1 ? 'win' : 'wins'} · ${losses} ${losses === 1 ? 'loss' : 'losses'}${nextT ? ` · next ${fmtTime(nextT, next.ctx.tz)} · ${esc(next.ctx.venues.get(next.m.venue) || 'TBD')}` : ''}</p>`);
  for (const [key, g] of groups) {
    parts.push(`<h2>${esc(key)}</h2>`);
    const day = [];
    const blocks = (blocksByDay.get(key) || []).sort((a, b) => a.min - b.min);
    let bi = 0;
    for (const r of g) {
      const t = schedTime(r.m, r.ctx.tz), m = r.m, ctx = r.ctx;
      while (bi < blocks.length && blocks[bi].min < t) day.push(possibleLine(blocks[bi++]));
      day.push(matchCard(m, ctx, {
        next: m.id === (next && next.m.id),
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

// Read-once views load once; a failed load keeps the board or shows the
// missing message, and recovery is a manual reload. The kiosk polls, so a
// transient failure there self-heals on the next tick.
function boot() {
  const app = document.querySelector('main');
  const renderers = { index: renderIndex, categories: renderTournament, venues: renderVenue, me: renderPlayer };
  // whose schedule "me" is — a per-tournament preference; the picker is the fallback when storage is blocked or stale
  const localPlayer = {
    get: slug => { try { return localStorage.getItem(`gb.player.${slug}`); } catch { return null; } },
    set: (slug, id) => { try { localStorage.setItem(`gb.player.${slug}`, id); } catch {} },
  };
  const pageTitle = (r, d) => { // index: Bracket; tournament/kiosk: bare tournament; me: "name — <player>" or "name — My Schedule"
    if (r.view === 'index' || !d.t) return 'Bracket';
    if (r.view === 'me') {
      if (r.filter) {
        const p = ((d.tjson && d.tjson.players) || []).find(x => x && x.id === r.filter);
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
  let pollTimer = null, clockTimer = null;

  // Auto-refresh only on the kiosk; the other views are read-on-load.
  const setKiosk = on => {
    if (on && !pollTimer) {
      // jitter so a hall of kiosk screens doesn't fetch in lockstep
      pollTimer = setInterval(tick, POLL_MS + Math.random() * 5000);
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
    loadAll(r, r.view === 'index').then(d => {
      if (route !== r) return; // superseded by a newer navigation — don't render a stale page
      if (r.view !== 'index' && !d.tjson) { // fetch failed or unknown slug — keep a board; the kiosk retries next tick
        if (!data) app.innerHTML = MISSING;
        return;
      }
      render(r, d);
    });
  };
  const tick = () => load(route);

  const render = (r, d) => {
    data = d;
    dataSlug = r.slug;
    // "me" is who this device last watched; me/<id> is an explicit pick, me/pick forces the picker
    if (r.view === 'me') {
      const roster = (d.tjson && d.tjson.players) || [];
      const wanted = r.filter === 'pick' ? null : (r.filter || localPlayer.get(r.slug));
      const p = roster.find(x => x && x.id === wanted);
      r = { ...r, filter: p ? p.id : undefined }; // a stale or unknown pick falls back to the picker
      if (p) localPlayer.set(r.slug, p.id); // a pick is "me" on this device
    }
    // the kiosk dark theme keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.body.classList.toggle('categories', r.view === 'categories');
    document.title = pageTitle(r, d);
    try {
      const html = renderers[r.view](r, d);
      if (html !== lastHtml) { app.innerHTML = html; lastHtml = html; }
    } catch (e) {
      app.innerHTML = '<p>Render error.</p>';
      console.error(e);
    }
  };

  // Fragment navigation: same-slug view hops (categories → venues → me)
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
