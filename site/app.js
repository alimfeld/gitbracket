'use strict';

const POLL_MS = 30000;
const FOLLOW_MS = 60000; // the kiosk re-follows the play on this cadence, data change or not

// Browser: derive.js loads first (script tag) and its top-level names are
// already page globals — functions/vars on globalThis, consts in the shared
// global lexical environment — so re-declaring them here duplicates a global
// binding. Node has no script-tag sharing, so the module lands on globalThis.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./derive.js'));
}

// The venue's display name — a missing id (hand-edited or staged) falls back to the id.
const venueName = (ctx, id) => ctx.venues.get(id) || id;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A dead deep link (the slug's file 404s — permanent, stop polling) versus a
// transient network failure (null — the poll retries next tick).
const HTTP_ERR = { httpError: true };

async function fetchJson(url) {
  try {
    // cache: 'no-cache' revalidates — 304s return 0 bytes, changes arrive fresh
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) return await res.json();
    // only a gone-for-good link stops the poll — a 5xx is transient, so it
    // returns null like any network failure and the poll retries next tick
    if (res.status === 404 || res.status === 410) return HTTP_ERR;
    return null;
  } catch {
    return null; // network failure — the poll retries next tick
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
// so switching keeps the focus and Schedule restores the pick. The kiosk
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
  if (tjson === HTTP_ERR) return { httpError: true };
  const t = tjson ? { slug: route.slug, name: tjson.name } : null;
  return { t, tjson, cats: toCats(tjson) };
}

const segmentBar = r => {
  const t = r.view === 'tournament', m = r.view === 'schedule';
  return `<nav class="segments" aria-label="Views"><a href="${esc(href(r.slug, 'tournament', r))}"${t ? ' aria-current="true"' : ''}>Tournament</a><a href="${esc(href(r.slug, 'schedule', r))}"${m ? ' aria-current="true"' : ''}>Schedule</a></nav>`;
};

// The one missing-data message, verbatim in every view.
const MISSING = '<p>No tournament data yet — check back soon.</p>';

// The one bad-route message, verbatim wherever a dead link lands: a rejected
// fragment route, or a slug whose tournament file is a permanent 404.
const BAD_LINK = '<p>This link doesn\'t look right.</p><p><a href="#">All tournaments</a></p>';


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
  // the home-screen tip lives muted in the header once — the cards carry only the two paths;
  // .meta is the existing de-emphasis (small, muted), a new class or italics needn't exist
  return `<header><h1>Tournaments</h1><p class="meta">Tip: open a tournament and add it to your home screen for easy access to live results and your match schedule.</p></header><section class="stack">${items.join('')}</section>`;
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
  // a tournament with no categories (hand-edited or staged) renders the shell — "missing data renders empty", never a throw
  if (show) parts.push(catSection(show, { multi, href: href(data.t.slug, 'tournament', route) }));
  return parts.join('');
}

// data-only: played/unplayed + scheduled times, never the device clock —
// the stage word links to its section (data-jump) when one exists. The wave is
// the deepest band with a playable card: the main column, or the placement
// wave once the championship is spent — the link names the merged group
// ("Final / 3rd place") either way.
// status line: progress only, plain — the page's one link lives in the
// anticipation (Next) line. 'starts' is anticipation, not progress, so no
// status line until a match resolves; the anticipation line carries the start.
const statusLine = (status, ctx) => {
  if (!status || status.kind === 'starts') return '';
  if (status.kind === 'groups') return `<p>Group stage: ${status.played} of ${status.count} played</p>`;
  if (status.kind === 'ko') {
    if (status.wave === null) return '<p>Knockout stage · Placement</p>';
    return `<p>Knockout stage: ${esc(stageGroupName(roundName(status.wave), bandLabels(ctx, status.wave)))}</p>`;
  }
  if (status.kind === 'finished') return '<p data-status="finished">Finished</p>';
  // winners: the podium is one line, third only when a bronze match decided it;
  // the names carry the weight, Finished dims — the podium stays full
  const names = [status.first, status.second, status.third].filter(Boolean).map(ids => teamLabel(ids, ctx));
  const ranks = ['Champion', 'Runner-up', '3rd'];
  return `<p>${names.map((n, i) => `${ranks[i]} <strong>${esc(n)}</strong>`).join(' · ')}</p>`;
};

// The next wave's courts, compact: several matches start at once across courts
// (a round plays simultaneously), so "next" is a block, not a card. Consecutive
// numbered courts collapse ("Courts 1–5"); anything else just lists.
const fmtCourts = names => {
  const ns = [...new Set(names)];
  if (ns.length === 1) return ns[0];
  const m = ns.map(n => /^(.*?)\s*(\d+)$/.exec(n));
  if (m.every(x => x && x[1] === m[0][1])) {
    const head = m[0][1];
    const nums = m.map(x => +x[2]).sort((a, b) => a - b);
    if (new Set(nums).size === nums.length &&
        nums[nums.length - 1] - nums[0] === nums.length - 1) {
      return `${head}s ${nums[0]}–${nums[nums.length - 1]}`;
    }
  }
  return ns.join(' · ');
};

// The anticipation line: the current playable wave and its courts. "Starts"
// before anything (the opening block is already a wave), "Next:" once a match
// has gone in — both lines jump to the wave's section (group-matches, or the
// knockout column). data-only: scheduled times, never the clock (the page's 30s
// poll keeps it current).
const anticipationLine = (ctx, status, href, day, wave) => {
  if (!status || status.kind === 'finished' || status.kind === 'winners') return '';
  if (!wave.length) {
    // nothing ready yet (e.g. a bracket waiting on its feeders): a bare Starts line, no block to jump to
    if (status.kind === 'starts' && status.time != null) return `<p>Starts ${timeEl(status.time, ctx.tz, day)}</p>`;
    return '';
  }
  const m0 = wave[0];
  const courts = [...new Set(wave.map(m => m.venue ? venueName(ctx, m.venue) : null).filter(Boolean))];
  // fmtCourts is repo data — the same esc contract as every other name on the page
  const where = courts.length ? ` · ${esc(fmtCourts(courts))}` : '';
  const starts = status.kind === 'starts';
  // the jump target is the section the wave lives in: starts derives it from
  // the opening block, groups and ko keep the committed rule
  const section = starts
    ? (m0.pool !== undefined ? 'group-matches' : `ko-${koColumn(m0, ctx)}`)
    : status.kind === 'groups' ? 'group-matches'
    : status.wave !== null ? `ko-${status.wave}` : '';
  const body = `${starts ? 'Starts' : 'Next'}: ${timeEl(schedTime(m0, ctx.tz), ctx.tz, day)}${where}`;
  // the whole line is the link — a full-size tap target, same as the schedule page
  return section ? `<p><a data-jump="${section}" href="${esc(href)}">${body}</a></p>` : `<p>${body}</p>`;
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
  const status = catStatus(ctx);
  // one current-wave predicate drives the card highlight, the Next line, and
  // the editor's next — what's lit is what's playable now, opening block included
  const wave = currentWave(ctx, status);
  const next = m => wave.includes(m);
  const lines = [];
  if (opts.multi) lines.push(`<p>${esc(fmtRange(schedDays(ctx.matches, ctx.tz)))}</p>`);
  if (status) lines.push(statusLine(status, ctx));
  lines.push(anticipationLine(ctx, status, opts.href, opts.multi, wave));
  parts.push(`<section><h2>${esc(ctx.name)}</h2>${lines.join('')}`);
  if (grp.length) {
    parts.push(`<section><h3>Group stage</h3>`);
    // pools belong to the group stage — scoreboard first, cards last; the
    // category subline above carries the status sentence
    if (byPool.size) {
      parts.push('<div class="grid">');
      for (const [pool] of byPool) {
        parts.push(`<div><h4>Pool ${esc(String(pool))}</h4>`);
        const bo1 = poolBo1(ctx, pool); // GD restates W−L in a best-of-1 pool — drop the column, keep PD
        const gdHead = bo1 ? '' : '<th scope="col" class="num">GD</th>';
        parts.push(`<table><thead><tr><th scope="col" class="num">#</th><th scope="col">Team</th><th scope="col" class="num">W</th><th scope="col" class="num">L</th>${gdHead}<th scope="col" class="num">PD</th></tr></thead><tbody>`);
        const std = poolStandings(ctx, pool, true); // pools come from matches, so partial standings always resolve
        // a rank is a fact only once a match decided a record — before that every team ties at zero and a wall of 1s reads as "all ranked first"
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

// Placement cards order by prize (3rd before 5th) then time — rank is
// structural, view-stable; koOrdinal numbers only the championship tree.
const placeOrder = ctx => (a, b) =>
  ((plRange(a, ctx) || {}).lo ?? Infinity) - ((plRange(b, ctx) || {}).lo ?? Infinity) ||
  (schedTime(a, ctx.tz) ?? 0) - (schedTime(b, ctx.tz) ?? 0);

// Brackets merged by depth band: each column holds the round's matches and the
// classification matches at the same edge count from the entry round — the
// bronze under the Final's heading ("Final / 3rd place"), the 5th–8th semis
// under the Semifinals' ("Semifinals / 5th–8th"), deciders one band deeper.
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
  parts.push(`<section><h3>Knockout stage</h3>`);
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
    court: m.venue ? esc(venueName(ctx, m.venue)) : 'TBD',
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
  const top = `<div class="kiosk-top" style="--cols: ${cols.length}">${header}${cols.map(id => `<h2>${esc((ctxs[0] && venueName(ctxs[0], id)) || id)}</h2>`).join('')}</div>`;
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
    const status = kioskStatus(r, now);
    const when = timeEl(r.t, r.ctx.tz);
    const flag = status === 'due' || status === 'overdue' ? status : ''; // the status word is the flag; done and upcoming cards show none
    return matchCard(r.m, r.ctx, { meta: ['catName', 'label'],
      head: [{ html: when }, { html: flag }], status });
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
function possibleCard(stage, ctx, opts) {
  const when = stage.time !== null ? timeEl(stage.time, ctx.tz, opts.day) : '<span class="tbd">TBD</span>';
  const where = stage.court !== null ? esc(venueName(ctx, stage.court)) : '<span class="tbd">TBD</span>';
  const label = esc(stage.label);
  return `<article${opts.id ? ` id="${opts.id}"` : ''} data-status="possible"><div class="head"><span>${when}</span><span>${where}</span></div><div class="meta">${esc(ctx.name)} · ${label}</div>${stage.chip ? `<div class="meta">(${esc(stage.chip)})</div>` : ''}</article>`;
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
    if (!secs) return `${segmentBar(route)}<header><h1>Pick a player</h1></header><p>No players yet.</p>`;
    return `${segmentBar(route)}<header><h1>Pick a player</h1></header>${secs}`;
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
    for (const stage of possibleStages(ctx, pid)) events.push({ t: stage.time ?? Infinity, stage, ctx });
  }
  for (const r of rows) events.push({ t: schedTime(r.m, r.ctx.tz) ?? Infinity, r, ctx: r.ctx });
  // times ascending; a confirmed row wins an exact tie against a possible stage
  events.sort((a, b) => a.t - b.t || (a.r ? 0 : 1) - (b.r ? 0 : 1));
  const statuses = [];
  for (const ctx of ctxs) {
    const s = playerStatus(ctx, pid);
    if (s) statuses.push(`${esc(ctx.name || ctx.id)}: ${esc(s)}`);
  }
  // the "what's next" line names the earliest playable event — a confirmed
  // match, or the earliest possible stage, with its condition said out loud
  const nextEv = events.find(e => e.r ? !isDone(e.r.m) : true);
  let next = null;
  if (nextEv) {
    // the whole "Next:" line is the link — a full-size tap target, and the
    // accent color already reads as clickable, so the affordance and the
    // emphasis agree
    const link = `<a data-jump="next" href="${esc(href(data.t.slug, 'schedule', route))}">`;
    if (nextEv.r) {
      const m = nextEv.r.m, nctx = nextEv.r.ctx;
      const t = schedTime(m, nctx.tz);
      next = `${link}Next: ${t !== null ? timeEl(t, nctx.tz, multi) : 'TBD'}${m.venue ? ` · ${esc(venueName(nctx, m.venue))}` : ' · TBD'}</a>`;
    } else {
      const stage = nextEv.stage, nctx = nextEv.ctx;
      next = `${link}Next: ${esc(stage.label)}${stage.time !== null ? ' · ' + timeEl(stage.time, nctx.tz, multi) : ''}${stage.chip ? ` (${esc(stage.chip)})` : ''}</a>`;
    }
  }
  const parts = [segmentBar(route), `<header><h1>${esc(p.name)}<a href="${esc(href(data.t.slug, 'schedule', { cat: route.cat }))}">Change</a></h1>${statuses.length ? `<p>${statuses.join(' · ')}</p>` : ''}${next ? `<p data-status="next">${next}</p>` : ''}</header>`];
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
      out.push(possibleCard(e.stage, e.ctx, { day: multi, id: isNext ? 'next' : undefined }));
    }
  }
  parts.push(`<section>${events.length ? `<div class="stack">${out.join('')}</div>` : '<p>No matches.</p>'}</section>`);
  return parts.join('');
}

// The index loads once; every tournament view polls while the tab is visible,
// so results land on their own — no reload, no manual refresh.
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
      return `${d.t.name} — Schedule`;
    }
    return d.t.name;
  };
  let route = null;    // current fragment route — the poll reads it each tick
  let data = null;     // last good snapshot — a failed poll keeps the board up
  let lastHtml = '';   // skip re-render when nothing changed — keeps selection/focus on the player page
  let lastKey = '';    // view|cat — what the page shows; a change is new content, start at the top
  let lastFollow = 0;     // last minute-tick re-follow — the kiosk tracks the play even when data never changes
  let pollTimer = null, clockTimer = null;
  let pollOn = false;  // view whose timers should run: 'tournament' | 'schedule' | 'venues'; false on the index

  // Every view but the index auto-refreshes while the tab is visible; a return
  // to the tab fetches immediately, so results land the moment a spectator
  // looks. The kiosk's running clock is a view, not a mode.
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  };
  const startPoll = () => {
    stopPoll();
    pollTimer = setInterval(tick, POLL_MS + Math.random() * 5000); // jitter: no lockstep across a hall of screens
    if (pollOn === 'venues') {
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
    }
  };

  const load = r => {
    loadAll(r).then(d => {
      if (route !== r) return; // superseded by a newer navigation
      if (r.view === 'index') return render(r, d); // the index never 404s the tournament file
      if (d.httpError) {
        // a dead deep link — the file is gone for good; stop the futile poll, and
        // keep a live board up rather than wipe it on a one-off server hiccup
        stopPoll();
        if (!data) app.innerHTML = BAD_LINK;
        return;
      }
      if (!d.tjson) { // transient fetch failure — the poll retries next tick
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
      pollOn = false; stopPoll();
      app.innerHTML = BAD_LINK;
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
  // a hidden tab stops polling entirely; a return fetches immediately, so the
  // fresh data is there the moment the spectator looks
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else if (pollOn) { tick(); startPoll(); }
  });
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for node tests; the browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { parseRoute, loadAll, renderIndex, renderTournament, renderVenue, renderPlayer };
}
