'use strict';
// app.js — shared fetch/render/derive for the GitBracket pages. No build step, no deps.
// Derive functions are pure (node-runnable); DOM work happens only in the browser boot.
// `node --test` runs the derive tests against fixtures/ (test/ dir).

const POLL_MS = 30000;
const SLOT_MIN = 45; // default match length, minutes — per-stage category slotMinutes (groups/knockout) and per-match slotMinutes override (match > stage > default)
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Canonical side identity: an unordered player set as a sorted '|'-joined string.
// The one convention shared by standings (app), pair checks (validate), and the
// generator's coverage assert (schedule).
const pairSig = ids => [...ids].sort().join('|');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- derive ----------

function makeCat(c, tjson) {
  // null/non-object entries: validate.js reports them, renders skip them
  const matches = (c.matches || []).filter(m => m && typeof m === 'object');
  return {
    matches,
    byId: new Map(matches.map(m => [m.id, m])),
    bestOf: (c.meta && c.meta.bestOf) || {},
    names: new Map(((tjson && tjson.players) || []).filter(p => p && typeof p === 'object').map(p => [p.id, p.name])),
    tz: (tjson && tjson.timezone) || 'UTC',
    slotMinutes: (c.meta && c.meta.slotMinutes) || {},
    venues: new Map(((tjson && tjson.venues) || []).filter(v => v && typeof v === 'object').map(v => [v.id, v.name])),
    name: (c.meta && c.meta.name) || ''
  };
}

// Effective slot length for a match, ms: match override > per-stage category
// config (groups/knockout — a match is groups iff it has a pool) > default.
// The single resolution point for the kiosk "now" window, the validator's venue
// overlap window, and the generator's slot grid.
function matchSlotMs(m, ctx) {
  const stage = m && m.pool !== undefined ? 'groups' : 'knockout';
  const cfg = (ctx && ctx.slotMinutes) || {};
  return ((m && m.slotMinutes) || cfg[stage] || SLOT_MIN) * 60 * 1000;
}

// Window test for a match's slot: shared by the validator's venue-overlap rule
// and the generator's court/player occupancy — one predicate, no drift.
const slotsOverlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// Raw game wins per side, target not applied — base for winnerIdx (target gate).
function countWins(games) {
  const w = [0, 0];
  for (const g of games) {
    if (g.a > g.b) w[0]++;
    else if (g.b > g.a) w[1]++;
  }
  return w;
}

function winnerIdx(m, ctx) {
  if (m.forfeit !== undefined) return m.forfeit === 0 ? 1 : 0;
  const games = m.games;
  if (!Array.isArray(games) || games.length === 0) return null;
  const stage = m.pool !== undefined ? 'groups' : 'knockout';
  const target = Math.ceil((m.bestOf ?? ctx.bestOf[stage]) / 2);
  const [w0, w1] = countWins(games);
  if (w0 >= target) return 0;
  if (w1 >= target) return 1;
  return null;
}

function isDone(m, ctx) {
  return winnerIdx(m, ctx) !== null;
}

const sameRecord = (a, b) => a.wins === b.wins && a.gd === b.gd && a.pd === b.pd;

function isDeadTie(st, rank) {
  const rec = st[rank - 1], above = st[rank - 2], below = st[rank];
  return !!rec && ((above && sameRecord(rec, above)) || (below && sameRecord(rec, below)));
}

function poolStandings(ctx, pool, partial) {
  // partial=true: skip unfinished matches instead of bailing — live standings table.
  // resolveSide keeps the strict form: a pool slot is TBD until every match counts.
  const ms = ctx.matches.filter(m => m && m.pool === pool);
  if (ms.length === 0) return null;
  const recs = new Map();
  for (const m of ms) {
    for (const s of m.sides) {
      if (s && s.kind === 'players' && Array.isArray(s.ids) && !recs.has(pairSig(s.ids))) {
        recs.set(pairSig(s.ids), { sig: pairSig(s.ids), ids: new Set(s.ids), wins: 0, losses: 0, gd: 0, pd: 0 });
      }
    }
  }
  for (const m of ms) {
    const w = winnerIdx(m, ctx);
    if (w === null) {
      if (!partial) return null; // pool unfinished
      continue;
    }
    const s0 = m.sides[0], s1 = m.sides[1];
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const r0 = recs.get(pairSig(s0.ids)), r1 = recs.get(pairSig(s1.ids));
    if (!r0 || !r1) continue;
    (w === 0 ? r0 : r1).wins++;
    (w === 0 ? r1 : r0).losses++;
    if (m.forfeit === undefined) {
      let gd = 0, pd = 0;
      for (const g of m.games) {
        gd += g.a > g.b ? 1 : -1; // game differential: games won minus lost
        pd += g.a - g.b;          // point differential
      }
      r0.gd += gd; r0.pd += pd;
      r1.gd -= gd; r1.pd -= pd;
    }
  }
  const list = [...recs.values()];
  list.sort((x, y) => y.wins - x.wins || y.gd - x.gd || y.pd - x.pd);
  return list;
}

function resolveSide(side, ctx, memo = new Map()) {
  if (!side || typeof side !== 'object') return null;
  if (side.kind === 'players') return new Set(side.ids);
  if (side.kind === 'match') {
    const m = ctx.byId.get(side.match);
    if (!m) return null;
    if (memo.has(m.id)) return memo.get(m.id) || null; // in-progress (undefined) = cycle — validate rejects these; only stops a hang if one slips past the gate
    memo.set(m.id, undefined);
    const w = winnerIdx(m, ctx);
    if (w === null) return null;
    const child = m.sides[side.result === 'winner' ? w : 1 - w];
    const v = resolveSide(child, ctx, memo);
    memo.set(m.id, v);
    return v;
  }
  if (side.kind === 'pool') {
    const st = poolStandings(ctx, side.pool);
    if (!st) return null;
    const rec = st[side.rank - 1];
    if (!rec || isDeadTie(st, side.rank)) return null; // dead tie -> TBD
    return rec.ids;
  }
  return null;
}

// Unresolved slot -> what the slot IS, so a bracket stays readable while
// waiting: "Winner of m7", "Loser of m9", "2nd in Pool A" (dead ties stay
// descriptive — the slot itself is still what the side says it is).
function slotLabel(side, ctx) {
  if (side && side.kind === 'match') {
    const ref = ctx.byId.get(side.match);
    return `${side.result === 'winner' ? 'Winner' : 'Loser'} of ${ref ? ref.id : side.match}`;
  }
  if (side && side.kind === 'pool') return `${ordinal(side.rank)} in Pool ${side.pool}`;
  return 'TBD';
}

// Player-id set -> display name: "Ada / Ben". The one place names render.
const teamLabel = (ids, ctx) => [...ids].map(id => ctx.names.get(id) || id).join(' / ');

function sideLabel(side, ctx) {
  const ids = resolveSide(side, ctx);
  if (!ids) return slotLabel(side, ctx);
  return teamLabel(ids, ctx);
}

// The player's confirmed matches: only matches where their side actually
// resolves to them. "Winner of m9" slots stay off the schedule until m9 is
// decided — a possibility is not a booking.
function playerMatches(ctx, pid) {
  const rows = [];
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (let i = 0; i < m.sides.length; i++) {
      const team = resolveSide(m.sides[i], ctx);
      if (team && team.has(pid)) {
        rows.push({ m, i, team });
        break;
      }
    }
  }
  return rows;
}

// Knockout matches still open for this player: from their confirmed matches
// through undecided "Winner/Loser of X" slots. A decided feeder only forwards
// the result the player got, so the closed branch drops out; confirmed
// consumers are excluded (they render as cards). Returns match ids.
function reachableKo(ctx, pid) {
  const starts = playerMatches(ctx, pid).filter(r => r.m.pool === undefined);
  const sideOf = new Map(starts.map(r => [r.m.id, r.i]));
  const open = new Set();
  const seen = new Set(sideOf.keys());
  const queue = [...sideOf.keys()];
  while (queue.length) {
    const id = queue.shift();
    const w = winnerIdx(ctx.byId.get(id), ctx); // null until the feeder is decided
    for (const m of ctx.matches) {
      if (m.pool !== undefined || !Array.isArray(m.sides) || seen.has(m.id)) continue;
      for (const s of m.sides) {
        if (!s || s.kind !== 'match' || s.match !== id) continue;
        const pSide = sideOf.get(id); // only start nodes can be decided; candidates are undecided by construction
        if (w !== null && pSide !== undefined && (s.result === 'winner') !== (pSide === w)) continue;
        seen.add(m.id);
        open.add(m.id);
        queue.push(m.id);
      }
    }
  }
  return open;
}

// Longest chain of knockout matches starting at id (the match itself counts):
// winner and loser branches are exclusive, so this is the max a team can still
// play from that point. O(N²) per id but memoized and brackets are tiny.
function chainLen(ctx, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, 0); // cycle guard — validate rejects cycles anyway
  const cs = [];
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (s && s.kind === 'match' && s.match === id) cs.push(m);
    }
  }
  memo.set(id, 1 + (cs.length ? Math.max(...cs.map(c => chainLen(ctx, c.id, memo))) : 0));
  return memo.get(id);
}

// Day-span of knockout slots still open for this player; null when none.
// Pre-knockout (pool team with no knockout seat yet) every bracket path is
// possible — times are pre-scheduled. count = the longest single path (win XOR
// lose, one rank). ponytail: fallback assumes everyone advances; gate it on
// pool completion if a format with a knockout cutoff ever appears.
function possibleSpan(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const ko = rows.filter(r => r.m.pool === undefined);
  let open = [...reachableKo(ctx, pid)];
  if (!open.length && rows.some(r => r.m.pool !== undefined) && !ko.length) {
    open = ctx.matches.filter(m => m.pool === undefined).map(m => m.id);
  }
  const ts = open.map(id => schedTime(ctx.byId.get(id))).filter(t => t !== null);
  if (!ts.length) return null;
  return { min: Math.min(...ts), max: Math.max(...ts), count: Math.max(...open.map(id => chainLen(ctx, id))) };
}

function matchRound(m, ctx, memo = new Map()) {
  if (memo.has(m.id)) return memo.get(m.id);
  memo.set(m.id, 0); // in-progress guard — validate rejects cycles; this only stops a hang if one slips past the gate
  let d = 0;
  for (const s of m.sides) {
    if (s && s.kind === 'match') {
      const ref = ctx.byId.get(s.match);
      if (ref) d = Math.max(d, 1 + matchRound(ref, ctx, memo));
    }
  }
  memo.set(m.id, d);
  return d;
}

const ordRules = new Intl.PluralRules('en', { type: 'ordinal' });
const ordinal = n => n + ({ one: 'st', two: 'nd', few: 'rd' }[ordRules.select(n)] || 'th');

// Classification label for a placement match (3rd/5th/7th place, classification
// semis). Winner-bracket matches (QF/SF/final) return null. The chain walks
// match slots down: loser edges count hops; the origin is the winner-bracket
// round whose losers started the chain, measured as depth from the final.
function placementLabel(m, ctx) {
  if (!ctx._chainMemo) ctx._chainMemo = new Map();
  const memo = ctx._chainMemo;
  const chainOf = (mm) => {
    if (memo.has(mm.id)) return memo.get(mm.id);
    memo.set(mm.id, null); // in-progress guard, same as matchRound
    let best = null;
    for (const s of mm.sides) {
      if (!s || s.kind !== 'match') continue;
      const X = ctx.byId.get(s.match);
      if (!X) continue;
      const c = chainOf(X);
      const here = s.result === 'loser'
        ? (c ? { d: c.d, h: c.h + 1 } : { d: maxDepth(ctx) - matchRound(X, ctx), h: 1 })
        : c; // winner edge from a placement match continues the chain
      if (here && (!best || here.h > best.h)) best = here;
    }
    memo.set(mm.id, best);
    return best;
  };
  const c = chainOf(m);
  if (!c) return null;
  const lastLoser = m.sides.some(s => s && s.kind === 'match' && s.result === 'loser');
  const low = 2 ** c.d + 1; // top rank of the loser range
  if (lastLoser && c.h < c.d) { // intermediate classification round (e.g. 5th–8th semis)
    return `${ordinal(low)}–${ordinal(low + 2 ** (c.d - c.h + 1) - 1)} semi`;
  }
  // last round of the classification bracket: winner edge resolves the top pair,
  // loser edge the bottom pair (3rd place is a single match, so it stays low)
  return `${ordinal(lastLoser && c.d > 1 ? low + 2 : low)} place`;
}

function maxDepth(ctx) {
  if (ctx._maxDepth === undefined) {
    let d = 0;
    for (const m of ctx.matches) d = Math.max(d, matchRound(m, ctx));
    ctx._maxDepth = d;
  }
  return ctx._maxDepth;
}

// ---------- time ----------

function fmtTime(t, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);
}

// Kiosk wall clock, second-granularity, in the tournament's timezone.
function fmtClock(t, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(t);
}

function dayKey(t, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

function schedTime(m) {
  const t = Date.parse(m.scheduled || '');
  return Number.isNaN(t) ? null : t;
}

function gamesText(m) {
  return (m.games || []).map(g => `${g.a}:${g.b}`).join(' · ');
}

function matchState(m, ctx) {
  return m.forfeit !== undefined ? 'forfeit'
    : (!isDone(m, ctx) && (m.games || []).length ? `in play · ${gamesText(m)}` : '');
}

function fmtDiff(n) {
  return (n > 0 ? '+' : '') + n;
}

// Match-day status: null until the first scheduled match is due, then
// { overdue } where overdue = scheduled matches whose full slot has elapsed
// without a result — exactly the complement of the kiosk's "Now" window
// (in-slot play is on schedule), so a non-empty list means the day has slipped.
function scheduleStatus(cats, nowMs) {
  const rows = [];
  for (const ctx of cats) {
    for (const m of ctx.matches) {
      if (!m || typeof m !== 'object') continue;
      const t = schedTime(m);
      if (t === null) continue;
      rows.push({ m, t, ctx });
    }
  }
  if (rows.length === 0 || nowMs < Math.min(...rows.map(r => r.t))) return null;
  return {
    overdue: rows
      .filter(r => !isDone(r.m, r.ctx) && nowMs >= r.t + matchSlotMs(r.m, r.ctx))
      .sort((a, b) => a.t - b.t)
  };
}

// Per-venue backlog (ms) from the match-day status: each venue's delay = how
// far past its slot end its most overdue unfinished match is — a lower bound
// on how late matches queued there run (a forfeit can clear it sooner).
function venueBacklog(cats, nowMs) {
  const byVenue = new Map();
  const status = scheduleStatus(cats, nowMs);
  if (!status) return byVenue;
  for (const r of status.overdue) {
    if (!r.m.venue) continue;
    const d = nowMs - (r.t + matchSlotMs(r.m, r.ctx));
    byVenue.set(r.m.venue, Math.max(byVenue.get(r.m.venue) || 0, d));
  }
  return byVenue;
}

// ---------- data loading ----------

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

// Knockout round names by distance from the final: each round back doubles
// participants (2 -> Final, 4 -> Semifinals, 8 -> Quarterfinals, ...). With
// byes a first round of 2 matches is still structurally Quarterfinals; names
// key off koColumn, so a bye'd semi (XD 2026: m7, two pool slots) reads as a
// semifinal, not a first-round match.
function roundName(depthFromEnd) {
  const n = 2 << depthFromEnd;
  return { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals' }[n] || `Round of ${n}`;
}

// Bracket column: 0 is the final column, each winner edge one column back.
// Depth-from-leaves (matchRound) can't place a bye'd semi — XD 2026's m7 has
// two pool slots, so depth 0, yet its winner feeds the final. Winner edges
// into a placement sub-bracket (5th place fed by the 5th–8th semis) do not
// extend the chain, so it always terminates at the final. Placement matches
// sit one column after the round their feeders branched from (bronze with the
// final, 5th–8th semis with the semis).
function koColumn(m, ctx) {
  if (!ctx._koCol) {
    const memo = ctx._koCol = new Map();
    const winnerParent = new Map();
    for (const X of ctx.matches) {
      for (const s of X.sides) {
        if (s && s.kind === 'match' && s.result === 'winner') winnerParent.set(s.match, X);
      }
    }
    const final = ctx.matches.find(X => X.pool === undefined && !winnerParent.has(X.id) && placementLabel(X, ctx) === null);
    const col = (X) => {
      const got = memo.get(X.id);
      if (got !== undefined) return got;
      memo.set(X.id, -1); // in-progress guard; validate rejects cycles before render
      const p = winnerParent.get(X.id);
      let r;
      if (p && placementLabel(p, ctx) === null) r = 1 + col(p);
      else if (X === final) r = 0;
      else {
        const feeders = X.sides.filter(s => s && s.kind === 'match' && ctx.byId.has(s.match)).map(s => col(ctx.byId.get(s.match)));
        r = feeders.length ? Math.max(...feeders) - 1 : matchRound(X, ctx);
      }
      memo.set(X.id, r);
      return r;
    };
    for (const X of ctx.matches) col(X);
  }
  return ctx._koCol.get(m.id);
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

// What kind of match this is, for the kiosk card: "Pool A" for group games,
// placement labels ("3rd place", "5th–8th semi") for classification matches,
// short round names (Final / SF / QF / R16) for the winner bracket.
function matchLabel(m, ctx) {
  if (m.pool !== undefined) return `Pool ${m.pool}`;
  const pl = placementLabel(m, ctx);
  if (pl) return pl;
  const d = koColumn(m, ctx);
  return { 0: 'Final', 1: 'SF', 2: 'QF', 3: 'R16' }[d] || roundName(d);
}

function kioskCard(r, small) {
  const m = r.m, ctx = r.ctx;
  const state = matchState(m, ctx);
  const meta = [esc(ctx.name), esc(matchLabel(m, ctx)), esc(state), esc(fmtTime(r.t, ctx.tz))].filter(Boolean).join(' · '); // category first, then pool; venue is the group header now
  return `<div class="km${small ? ' small' : ''}">
    ${sideRow(m, ctx, 0)}
    ${sideRow(m, ctx, 1)}
    <div class="kmeta">${meta}</div>
  </div>`;
}

// Status, not the clock, picks the board. Overdue = the full slot has elapsed
// without a result; Now = started, still inside its slot; Next = future starts,
// two max. Only a result removes a match entirely.
function kioskBuckets(rows, now) {
  const open = rows.filter(r => !isDone(r.m, r.ctx));
  return {
    overdue: open.filter(r => now >= r.t + matchSlotMs(r.m, r.ctx)),
    live: open.filter(r => now >= r.t && now < r.t + matchSlotMs(r.m, r.ctx)),
    next: open.filter(r => r.t > now).slice(0, 2) // > not >=: the boundary instant belongs to Now
  };
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
    const bucket = byVenue.get(id);
    const { overdue, live, next } = kioskBuckets(bucket, now);
    if (!overdue.length && !live.length && !next.length) continue;
    any = true;
    const col = [];
    col.push(`<h2 class="k-venue">${esc(venueNames.get(id) || id)}</h2>`);
    if (overdue.length) {
      col.push('<h3 class="k-overdue">Overdue</h3>');
      for (const r of overdue) col.push(kioskCard(r));
    }
    if (live.length) {
      col.push('<h3 class="k-now">Now</h3>');
      for (const r of live) col.push(kioskCard(r));
    }
    if (next.length) {
      col.push('<h3 class="k-next">Next</h3>');
      for (const r of next) col.push(kioskCard(r, true));
    }
    // one column per venue, side by side on the all-venues board
    cols.push(`<div class="k-venue-col">${col.join('')}</div>`);
  }
  parts.push(v ? cols.join('') : `<div class="k-cols">${cols.join('')}</div>`);
  if (!any) parts.push('<p class="k-empty">Nothing scheduled.</p>');
  return parts.join('');
}

// "~X min late · est. H:MM" note for a scheduled match, from the venue's
// accumulated backlog; '' when on schedule.
function delayNote(t, m, ctx, delayByVenue, now) {
  if (t === null || t <= now || !m.venue) return '';
  const d = delayByVenue.get(m.venue) || 0;
  const min = Math.round(d / 60000 / 5) * 5;
  return min >= 5 ? ` · <span class="late">~${min} min late · est. ${fmtTime(t + d, ctx.tz)}</span>` : '';
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
  const tick = () => {
    loadAll(params, page === 'index').then(d => {
      if (page !== 'index' && data && !d.t) return; // index fetch failed — keep the last board
      data = d;
      if (page !== 'index' && !data.t) {
        app.innerHTML = '<p>Tournament not found.</p>';
        return;
      }
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
  }
}

if (typeof document !== 'undefined') boot();

// CommonJS exports for validate.js; browser <script> ignores these.
if (typeof module !== 'undefined') {
  module.exports = { ID_RE, pairSig, matchSlotMs, slotsOverlap, makeCat, winnerIdx, isDone, poolStandings, resolveSide, sameRecord, matchRound, isDeadTie, playerMatches, reachableKo, possibleSpan, slotLabel, sideLabel, schedTime, gamesText, roundName, placementLabel, koColumn, scheduleStatus, venueBacklog, kioskBuckets, matchLabel, fmtTime, dayKey, renderIndex, renderStandings, renderVenue, renderPlayer };
}
