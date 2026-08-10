'use strict';
// derive.js — pure derive + time logic for GitBracket.
// The one source of the domain model: the validator (validate.js), the score
// CLI (cli.js), the match generator (schedule.js), and the renderers (app.js)
// all share these functions, so the integrity gate doesn't depend on renderer
// code and the renderer doesn't reimplement the model. Loaded as a plain
// script before app.js in the browser (functions land on globalThis); in node
// it's a CommonJS module.

const SLOT_MIN = 45; // default match length, minutes
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Canonical side identity: an unordered player set as a sorted '|'-joined string.
// The one convention shared by standings (app), pair checks (validate), and the
// generator's coverage assert (schedule).
const pairSig = ids => [...ids].sort().join('|');

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
        gd += g.a > g.b ? 1 : -1; // game differential: won minus lost
        pd += g.a - g.b;
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
        ? (c ? { d: c.d, h: c.h + 1 } : { d: winnerDepth(ctx, X.id), h: 1 })
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

// Winner-edge distance to the final (0 = the final itself): the round a loser
// edge branches from, for placement labels. matchRound can't do this — a bye'd
// semi fed by pool slots has depth 0 from the leaves yet sits one round below
// the final (XD 2026 m6), and a wrong d mislabels the bronze match as a
// classification round.
function winnerDepth(ctx, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, -1); // in-progress guard, same as matchRound
  for (const m of ctx.matches) {
    for (const s of m.sides) {
      if (s && s.kind === 'match' && s.result === 'winner' && s.match === id) {
        memo.set(id, 1 + winnerDepth(ctx, m.id, memo));
        return memo.get(id);
      }
    }
  }
  memo.set(id, 0);
  return 0;
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

// Card badge status: overdue = full slot elapsed without a result, live = started
// but inside its slot, else next (> not >=: the boundary instant belongs to live).
function kioskStatus(r, now) {
  const t = r.t;
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'live';
  return 'next';
}

// Backlog note for a match card: '~X min late · est. H:MM' while it hasn't
// started (future OR still queued behind an unscored predecessor), 'started
// ~X min late' once it's in play; '' when on schedule, finished, or the
// backlog source itself (the match the venue's delay is measured from).
function delayNote(t, m, ctx, delayByVenue, now) {
  if (t === null || !m.venue) return '';
  const d = delayByVenue.get(m.venue) || 0;
  const min = Math.round(d / 60000 / 5) * 5;
  if (min < 5 || isDone(m, ctx)) return '';
  // queued: the backlog-adjusted start is still ahead of or at now. The source
  // (t + d < now) gets no note — for it, d is minutes past its own slot end,
  // not its start delay. Back-to-back slots put the queued est. exactly at now
  // while the predecessor is unscored, hence >= not >.
  const queued = t + d >= now;
  // in play: it started behind the backlog — checked first so a playing match
  // never reads as still upcoming.
  if ((m.games || []).length) return queued ? `started ~${min} min late` : '';
  if (queued) return `~${min} min late · est. ${fmtTime(t + d, ctx.tz)}`;
  return ''; // the backlog source itself — no estimate the model can give
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

function matchLabel(m, ctx) {
  if (m.pool !== undefined) return `Pool ${m.pool}`;
  const pl = placementLabel(m, ctx);
  if (pl) return pl;
  const d = koColumn(m, ctx);
  return { 0: 'Final', 1: 'SF', 2: 'QF', 3: 'R16' }[d] || roundName(d);
}

if (typeof module !== 'undefined') {
  module.exports = { SLOT_MIN, ID_RE, pairSig, makeCat, matchSlotMs, slotsOverlap, countWins, winnerIdx, isDone, sameRecord, isDeadTie, poolStandings, resolveSide, slotLabel, teamLabel, sideLabel, playerMatches, reachableKo, chainLen, possibleSpan, matchRound, ordinal, placementLabel, winnerDepth, fmtTime, fmtClock, dayKey, schedTime, gamesText, matchState, fmtDiff, scheduleStatus, venueBacklog, kioskStatus, delayNote, roundName, koColumn, matchLabel };
}
