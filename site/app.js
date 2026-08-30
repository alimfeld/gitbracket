'use strict';

const POLL_MS = 10000;
const FOLLOW_MS = 60000; // the kiosk re-follows the play on this cadence, data change or not

// Browser: derive.js loads first (script tag) and its top-level names are
// already page globals — functions/vars on globalThis, consts in the shared
// global lexical environment — so re-declaring them here duplicates a global
// binding. Node has no script-tag sharing, so the module lands on globalThis.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./derive.js'));
}

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
  // ponytail: no match deep-links — an in-page anchor (?cat=md#final) dies on the
  // id regex here. Upgrade path if event comms ever asks: anchor-aware routing,
  // ids on cards, one scroll handler.
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

const segmentBar = r => {
  const t = r.view === 'tournament', m = r.view === 'schedule';
  return `<nav class="segments" aria-label="Views"><a href="${esc(href(r.slug, 'tournament', r))}"${t ? ' aria-current="true"' : ''}>Tournament</a><a href="${esc(href(r.slug, 'schedule', r))}"${m ? ' aria-current="true"' : ''}>My Schedule</a></nav>`;
};

// The one missing-data message, verbatim in every view.
const MISSING = '<p>No tournament data yet — check back soon.</p>';


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
      // the card link opens the tournament (the installable, player view); the
      // venue board is a sibling chip pinned to the corner — a link can't nest a link
      return `<div class="tcard-wrap"><a class="tcard" aria-label="${name}" href="#${esc(e.slug)}"><h2>${name}</h2>${meta ? `<p>${meta}</p>` : ''}</a><a class="board-link" href="#${esc(e.slug)}/venues">Venue board</a></div>`;
    });
  if (!items.length) return `<header><h1>Tournaments</h1><p>No tournaments yet.</p></header>`;
  // the home-screen tip lives in the header once — the cards carry only the two paths
  return `<header><h1>Tournaments</h1><p>Tip: add a tournament to your home screen for easy access to live results and your match schedule.</p></header><section class="stack">${items.join('')}</section>`;
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
  const ctxs = data.cats;
  const show = ctxs.find(c => c.id === route.cat) || ctxs[0]; // an unknown cat falls back to the first
  const multi = multiDay(ctxs);
  const parts = [segmentBar(route), `<header><h1>${esc(data.t.name)}</h1>`];
  // the heading states the span and the location once — single-day cards never repeat the date
  const range = fmtRange(schedDays(ctxs.flatMap(c => c.matches), tz));
  parts.push(`<p>${[range, esc(data.tjson.location)].filter(Boolean).join(' · ')}</p></header>`);
  parts.push(`<nav class="cats" aria-label="Categories">${catNav(data.t.slug, ctxs, route)}</nav>`);
  parts.push(catSection(show, { multi, href: href(data.t.slug, 'tournament', route) }));
  return parts.join('');
}

// data-only: played/unplayed + scheduled times, never the device clock —
// the stage word links to its section (data-jump) when one exists.
const statusLine = (st, ctx, href) => {
  const jump = (text, id) => `<a data-jump="${id}" href="${esc(href)}">${text}</a>`;
  if (st.kind === 'starts') return `<p>Starts ${st.time !== null ? timeEl(st.time, ctx.tz) : 'soon'}</p>`;
  if (st.kind === 'groups') return `<p>${jump('Group stage', 'group-matches')} · ${st.played} of ${st.count} played</p>`;
  if (st.kind === 'ko') return st.col === null
    ? `<p>Knockout stage · ${jump('Placement', 'ko-placement')}</p>`
    : `<p>Knockout stage · ${jump(roundName(st.col), `ko-${st.col}`)}</p>`;
  if (st.kind === 'finished') return '<p data-status="finished">Finished</p>';
  // winners: the podium is one line, third only when a bronze match decided it;
  // the names carry the weight, Finished dims — the podium stays full
  const names = [st.first, st.second, st.third].filter(Boolean).map(ids => teamLabel(ids, ctx));
  const ranks = ['Champion', 'Runner-up', '3rd'];
  return `<p>${names.map((n, i) => `${ranks[i]} <strong>${esc(n)}</strong>`).join(' · ')}</p>`;
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
  // All pools, chronological by wall-clock (stable sort keeps file order on ties).
  const grp = [...byPool.values()].flat().sort((a, b) => (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));
  // one category subline: the date span on multi-day pages only — a single-day
  // heading already states the date once — then the status sentence or podium
  const st = catStatus(ctx);
  // the subline's stage link names the wave in play — its unscored cards carry
  // the player page's next accent, so the link and the play always agree
  const next = m => st && !isDone(m) && (st.kind === 'groups'
    ? m.pool !== undefined
    // main bracket: the wave column. Placement: ready as soon as its feeder results
    // decide it — the bronze lights up with the final, a 5th–8th semi with the QFs.
    : st.kind === 'ko' && m.pool === undefined && (
      placementLabel(m, ctx) === null
        ? koColumn(m, ctx) === st.col
        : Array.isArray(m.sides) && m.sides.length === 2 &&
          !!resolveSide(m.sides[0], ctx) && !!resolveSide(m.sides[1], ctx)));
  const lines = [];
  if (opts.multi) lines.push(`<p>${esc(fmtRange(schedDays(ctx.matches, ctx.tz)))}</p>`);
  if (st) lines.push(statusLine(st, ctx, opts.href));
  parts.push(`<section><h2>${esc(ctx.name)}</h2>${lines.join('')}`);
  if (grp.length) {
    parts.push(`<section><h3>Group stage</h3>`);
    // pools belong to the group stage — scoreboard first, cards last; the
    // category subline above carries the status sentence
    if (byPool.size) {
      parts.push('<div class="grid">');
      for (const [pool] of byPool) {
        parts.push(`<div><h4>Pool ${esc(String(pool))}</h4>`);
        parts.push('<table><thead><tr><th scope="col" class="num">#</th><th scope="col">Team</th><th scope="col" class="num">W</th><th scope="col" class="num">L</th><th scope="col" class="num">GD</th><th scope="col" class="num">PD</th></tr></thead><tbody>');
        const st = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
        // a rank is a fact only once a match decided a record — before that every team ties at zero and a wall of 1s reads as "all ranked first"
        const ranks = st.some(r => r.wins || r.losses) ? poolRanks(st) : null;
        st.forEach((r, i) => {
          const team = teamLabel(r.ids, ctx);
          parts.push(`<tr><td class="num">${ranks ? ranks[i] : ''}</td><td>${esc(team)}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${fmtDiff(r.gd)}</td><td class="num">${fmtDiff(r.pd)}</td></tr>`);
        });
        parts.push('</tbody></table></div>');
      }
      parts.push('</div>');
    }
    parts.push(`<h4 id="group-matches">Group matches</h4>`, matchGrid(grp, ctx, opts.multi, next), '</section>');
  }
  if (ko.length) parts.push(bracketHtml(ctx, ko, opts.multi, next));
  parts.push('</section>');
  return parts.join('');
}


// Bracket order first: a card's position must match its QF/SF ordinal, which
// schedule edits can't move. Time breaks ties and orders unnumbered matches.
const koOrder = (ms, ctx) => [...ms].sort((a, b) =>
  (koOrdinal(a, ctx) || Infinity) - (koOrdinal(b, ctx) || Infinity) ||
  (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0));

function bracketHtml(ctx, ko, multi, next) {
  const main = ko.filter(m => placementLabel(m, ctx) === null);
  const placement = ko.filter(m => placementLabel(m, ctx) !== null);
  const maxR = main.reduce((mx, m) => Math.max(mx, koColumn(m, ctx)), 0);
  const cols = [];
  for (const m of main) {
    const r = maxR - koColumn(m, ctx); // koColumn is distance from the final; render that column rightmost
    (cols[r] = cols[r] || []).push(m);
  }
  const parts = [];
  parts.push(`<section><h3>Knockout stage</h3>`);
  for (let r = 0; r <= maxR; r++) { // index by depth, skip holes — labels stay aligned if a column is empty
    const ms = cols[r];
    if (!ms || !ms.length) continue;
    parts.push(`<h4 id="ko-${maxR - r}">${roundName(maxR - r)}</h4>`, matchGrid(koOrder(ms, ctx), ctx, multi, next));
  }
  // Classification (bronze / 5th / 7th …) is its own tree, not a championship round — keep it off the round headings.
  if (placement.length) {
    parts.push(`<h4 id="ko-placement">Placement</h4>`, matchGrid(koOrder(placement, ctx), ctx, multi, next));
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
  return `<article${opts.id ? ` id="${opts.id}"` : ''}${opts.status ? ` data-status="${opts.status}"` : ''}>${head}${sideRow(m, ctx, 0)}${sideRow(m, ctx, 1)}<div class="meta">${meta}</div></article>`;
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

function renderVenue(route, data, now) {
  if (!data.tjson) return MISSING;
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
  // courts with no matches are simply absent; the cat contexts already derived the venue names from this tjson
  const shown = v ? rows.filter(r => r.m.venue === v) : rows;
  const tz = data.tjson.timezone || 'UTC';
  const today = dayKey(now, tz); // one day per screen — an overnight board must not list yesterday
  const firstDay = rows.length ? dayKey(rows[0].t, rows[0].ctx.tz) : null; // rows are time-sorted above — the first instant's day
  const lastDay = rows.length ? dayKey(rows.at(-1).t, rows.at(-1).ctx.tz) : null; // … and the last instant's
  // no "today" inside the event's span: before day one preview day one (a screen switched on early
  // shows the schedule); after the last day show its board — "Today · Nothing scheduled." reads stale
  const shownDay = firstDay && today < firstDay ? firstDay : lastDay && today > lastDay ? lastDay : today;
  const open = shown.filter(r => dayKey(r.t, r.ctx.tz) === shownDay); // the full day stays on the board; the scroll follows the current slot
  const cols = (data.tjson.venues || []).map(x => x.id).filter(id => open.some(r => r.m.venue === id));
  const header = `<header><div><h1>${esc(data.t.name)}</h1><p>${shownDay === today ? 'Today' : dayLabel(shownDay)}</p></div><time id="clock"></time></header>`;
  // header and venue titles stick as one block — the titles ride the running
  // clock, aligned to the board by the shared --cols track
  const top = `<div class="kiosk-top" style="--cols: ${cols.length}">${header}${cols.map(id => `<h2>${esc((ctxs[0] && ctxs[0].venues.get(id)) || id)}</h2>`).join('')}</div>`;
  if (!cols.length) return top + '<p>Nothing scheduled.</p>';
  // columns are venues, rows are start times — every column holds the same
  // cells, so the cards of one wave line up; holes stay empty cells. ponytail:
  // one card per (venue, start) cell — the validator only checks unplayed
  // pairs, so a done match squeezed into a taken slot hides its sibling; fix the
  // data, the grid has no cell for two.
  const byVenue = new Map(cols.map(id => [id, new Map()]));
  for (const r of open) byVenue.get(r.m.venue).set(r.t, r);
  const times = [...new Set(open.map(r => r.t))];
  const card = r => {
    const st = kioskStatus(r, now);
    const when = timeEl(r.t, r.ctx.tz);
    const flag = st === 'due' || st === 'overdue' ? st : ''; // the status word is the flag; done and upcoming cards show none
    return matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
      head: [{ html: when }, { html: flag }], status: st });
  };
  const cells = [];
  const anchorTime = times[currentRowIndex(times, now)];
  for (const t of times) {
    for (const id of cols) {
      const r = byVenue.get(id).get(t);
      // only the anchor row's cells carry data-current — the scroll target; a
      // render recomputes the anchor from now, which is what the follow needs
      cells.push(r ? (t === anchorTime ? `<div data-current="${r.t}">${card(r)}</div>` : card(r)) : '<div></div>');
    }
  }
  // data-anchor: the board's current row start time, derived here where times and
  // now live; the follow scrolls to the row's data-current cells
  return top + `<div class="board" data-anchor="${anchorTime}" style="--cols: ${cols.length}">${cells.join('')}</div>`;
}

// One tournament-wide fact, derived at render: do scheduled matches span more
// than one wall-clock day? Gates the date on match cards — single-day pages
// state the date once, multi-day cards carry their own. (Same derivation as
// the index's stored dates: schedDays + dayKey — one day-key source.)
const multiDay = ctxs => schedDays(ctxs.flatMap(c => c.matches), (ctxs[0] && ctxs[0].tz) || 'UTC').length > 1;


// A possible stage: the round the player could reach once the pools decide —
// the certain bits (label, count, uniform time/court) inline, the chip
// carrying the rank or outcome that gets in.
function possibleCard(st, ctx, opts) {
  const when = st.time !== null ? timeEl(st.time, ctx.tz, opts.day) : '<span class="tbd">TBD</span>';
  const where = st.court !== null ? esc(ctx.venues.get(st.court) || st.court) : '<span class="tbd">TBD</span>';
  const label = esc(st.label);
  return `<article${opts.id ? ` id="${opts.id}"` : ''} data-status="possible"><div class="head"><span>${when}</span><span>${where}</span></div><div class="meta">${esc(ctx.name)} · ${label}${st.chip ? ` — ${esc(st.chip)}` : ''}</div></article>`;
}

function renderPlayer(route, data) {
  if (!data.tjson) return MISSING;
  const pid = route.player;
  const players = (data.tjson.players || []).filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  const p = pid ? players.find(x => x.id === pid) : null;
  if (!p) {
    // only participants are pickable — a pick must always render a schedule. One
    // section per category: the picker doubles as "who is in which category", and
    // the browser's native find covers name search — no JS search box at this size
    const ctxs = data.cats;
    const secs = ctxs.map(c => {
      const items = players
        .filter(pl => playerMatches(c, pl.id).length)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
        .map(pl => `<li><a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat, player: pl.id }))}">${esc(pl.name || pl.id)}</a></li>`)
        .join('');
      return items ? `<section><h2>${esc(c.name || c.id)}</h2><ul>${items}</ul></section>` : '';
    }).join('');
    if (!secs) return `${segmentBar(route)}<header><h1>Pick your player</h1></header><p>No players yet.</p>`;
    return `${segmentBar(route)}<header><h1>Pick your player</h1></header>${secs}`;
  }
  const rows = [];
  const ctxs = data.cats;
  const multi = multiDay(ctxs); // the stage times need their date on multi-day pages
  for (const ctx of ctxs) {
    for (const pm of playerMatches(ctx, pid)) rows.push({ m: pm.m, i: pm.i, ctx });
  }
  rows.sort((a, b) => (schedTime(a.m, a.ctx.tz) ?? Infinity) - (schedTime(b.m, b.ctx.tz) ?? Infinity));
  // One flat timeline under date headings — the day owns the context, so cards
  // never repeat it; the heading swaps with each new day. Possible stages merge
  // into it at their own time: an undecided pool leaves the knockout open, so
  // the stage cards sit where those rounds would be, next to the match cards.
  const events = [];
  for (const ctx of ctxs) {
    for (const st of possibleStages(ctx, pid)) events.push({ t: st.time ?? Infinity, st, ctx });
  }
  for (const r of rows) events.push({ t: schedTime(r.m, r.ctx.tz) ?? Infinity, r, ctx: r.ctx });
  // times ascending; a confirmed row wins an exact tie against a possible stage
  events.sort((a, b) => a.t - b.t || (a.r ? 0 : 1) - (b.r ? 0 : 1));
  const statuses = [];
  for (const ctx of ctxs) {
    const s = playerStatus(ctx, pid);
    if (s) statuses.push(`<strong>${esc(ctx.name || ctx.id)}</strong>: ${esc(s)}`);
  }
  // the "what's next" line names the earliest playable event — a confirmed
  // match, or the earliest possible stage, with its condition said out loud
  const nextEv = events.find(e => e.r ? !isDone(e.r.m) : true);
  let next = null;
  if (nextEv) {
    const link = `<a data-jump="next" href="${esc(href(data.t.slug, 'schedule', route))}">`;
    if (nextEv.r) {
      const m = nextEv.r.m, nctx = nextEv.r.ctx;
      const t = schedTime(m, nctx.tz);
      next = `${link}Next: ${t !== null ? timeEl(t, nctx.tz, multi) : 'TBD'}${m.venue ? ` · ${esc(nctx.venues.get(m.venue) || m.venue)}` : ' · TBD'}</a>`;
    } else {
      const st = nextEv.st, nctx = nextEv.ctx;
      next = `${link}Next: ${esc(st.label)}${st.time !== null ? ' · ' + timeEl(st.time, nctx.tz, multi) : ''}${st.chip ? ` (${esc(st.chip)})` : ''}</a>`;
    }
  }
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}<a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat }))}">Not you?</a></h1>${statuses.length ? `<p>${statuses.join(' · ')}</p>` : ''}${next ? `<p data-status="next">${next}</p>` : ''}</header>`];
  const out = [];
  let curDay = null;
  for (const e of events) {
    const t = e.t;
    const day = Number.isFinite(t) ? dayKey(t, e.ctx.tz) : null;
    if (day !== curDay) {
      curDay = day;
      out.push(`<h2>${esc(day === null ? 'Unscheduled' : dayLabel(day))}</h2>`);
    }
    // the row itself, not the match id — ids are per-category, two cats can share one
    const isNext = e === nextEv;
    if (e.r) {
      out.push(matchCard(e.r.m, e.ctx, { meta: ['catName', 'label'], head: [{ key: 'time' }, { key: 'court' }], status: isNext ? 'next' : undefined, id: isNext ? 'next' : undefined }));
    } else {
      out.push(possibleCard(e.st, e.ctx, { day: multi, id: isNext ? 'next' : undefined }));
    }
  }
  parts.push(`<section>${events.length ? `<div class="stack">${out.join('')}</div>` : '<p>No matches.</p>'}</section>`);
  return parts.join('');
}

// Read-once views load once and recover via manual reload; the kiosk polls.
function boot() {
  const app = document.querySelector('main');

  const renderers = { index: renderIndex, tournament: renderTournament, venues: (r, d) => renderVenue(r, d, Date.now()), schedule: renderPlayer };
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
  let lastFollow = 0;     // last minute-tick re-follow — the kiosk tracks the play even when data never changes
  let pollTimer = null, clockTimer = null;

  // Auto-refresh only on the kiosk; the other views are read-on-load.
  const setKiosk = on => {
    if (on && !pollTimer) {
      pollTimer = setInterval(tick, POLL_MS + Math.random() * 5000); // jitter: no lockstep across a hall of screens
      // Clock lives in an element the change-guard never re-renders; look it up
      // fresh each tick (the poll re-renders).
      clockTimer = setInterval(() => {
        const now = Date.now();
        const el = document.getElementById('clock');
        if (el) {
          const tz = (data && data.tjson && data.tjson.timezone) || 'UTC';
          el.textContent = `${dayShort(now, tz)} · ${fmtTime(now, tz)}`; // the kiosk clock carries its date
          el.dateTime = new Date(now).toISOString(); // the instant, derived — the label stays wall clock
        }
        // once a minute, re-follow from the last snapshot — statuses and the anchor
        // recompute against now, so the play is tracked through a quiet hour too
        if (now - lastFollow >= FOLLOW_MS && data) {
          lastFollow = now;
          render(route, data);
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

  // The kiosk follows the current slot: centre the anchor row on every render;
  // the clock handler re-aims on its own minute, so a quiet hour still tracks.
  const aim = () => {
    const cell = document.querySelector('.board [data-current]');
    if (cell) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const render = (r, d) => {
    data = d;
    // full-width board layout keys off body.venue — present only on the venue view
    document.body.classList.toggle('venue', r.view === 'venues');
    document.title = pageTitle(r, d);
    // a view, category, or player change is new content — start at the top;
    // shorter pages clamp the residual scroll. A venue hop keeps the position
    // (the kiosk re-aims itself each minute).
    const key = `${r.view}|${r.cat || ''}|${r.player || ''}`;
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
    aim();
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

  // data-jump links keep the route — the href stays a valid fragment; a click
  // only scrolls the target section (every jump link is same-view today)
  const jumpTo = id => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start' });
  };
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });

  navigate();
  window.addEventListener('hashchange', navigate);
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer };
}
