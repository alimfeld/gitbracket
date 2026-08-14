'use strict';
// derive.js — pure derive + time logic for GitBracket.
// The one source of the site's domain model: the validator (validate.js), the
// score REPL (repl.js), the match generator (schedule.js), and the renderers
// (app.js) all share these functions, so the integrity gate doesn't depend on
// renderer code and the renderer doesn't reimplement the model. Tool-only
// predicates live in src/tools.js, not here — this file ships to the browser.
// Loaded as a plain script before app.js in the browser (functions land on
// globalThis); in node it's a CommonJS module.

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Canonical side identity: an unordered player set as a sorted '|'-joined string.
// The one convention shared by standings (app), pair checks (validate), and the
// generator's coverage assert (schedule).
const pairSig = ids => [...ids].sort().join('|');

function makeCat(c, tjson) {
  // null/non-object entries: validate.js reports them, renders skip them.
  // Non-array players/venues too — the validator calls this while reporting
  // the broken shape, so it must not throw on it.
  const matches = (c.matches || []).filter(m => m && typeof m === 'object');
  const arr = x => Array.isArray(x) ? x : [];
  return {
    matches,
    byId: new Map(matches.map(m => [m.id, m])),
    bestOf: (c.meta && c.meta.bestOf) || {},
    names: new Map(arr(tjson && tjson.players).filter(p => p && typeof p === 'object').map(p => [p.id, p.name])),
    tz: (tjson && tjson.timezone) || 'UTC',
    slotMinutes: (c.meta && c.meta.slotMinutes) || {},
    venues: new Map(arr(tjson && tjson.venues).filter(v => v && typeof v === 'object').map(v => [v.id, v.name])),
    name: (c.meta && c.meta.name) || '',
    id: (c.meta && c.meta.id) || ''
  };
}

// Effective slot length for a match, ms: match override > per-stage category
// config (groups/knockout — a match is groups iff it has a pool).
// The single resolution point for the kiosk "now" window, the validator's venue
// overlap window, and the generator's slot grid. Every generated tournament and
// fixture with scheduled matches has slotMinutes set, so there's no default.
function matchSlotMs(m, ctx) {
  const stage = m && m.pool !== undefined ? 'groups' : 'knockout';
  const cfg = (ctx && ctx.slotMinutes) || {};
  return ((m && m.slotMinutes) || cfg[stage]) * 60 * 1000;
}


// Raw game wins per side, target not applied — base for winnerIdx (target gate).
function countWins(games) {
  const w = [0, 0];
  for (const g of games) {
    if (g.a > g.b) w[0]++;
    else if (g.b > g.a) w[1]++;
  }
  return w;
}

// Net game differential of a played match from side 0's viewpoint:
// gd = won minus lost games, pd = points for minus points against. Side 1's
// numbers are the negations — standings and head-to-head tally both use it.
function gameDiff(games) {
  let gd = 0, pd = 0;
  for (const g of games) {
    gd += g.a > g.b ? 1 : -1;
    pd += g.a - g.b;
  }
  return { gd, pd };
}

// Effective best-of for a match: match override > per-stage category config.
// Single resolution point, same shape as matchSlotMs.
function bestOfOf(m, ctx) {
  const stage = m.pool !== undefined ? 'groups' : 'knockout';
  return m.bestOf ?? ctx.bestOf[stage];
}

function winnerIdx(m, ctx) {
  if (m.forfeit !== undefined) return m.forfeit === 0 ? 1 : 0;
  const games = m.games;
  if (!Array.isArray(games) || games.length === 0) return null;
  const target = Math.ceil(bestOfOf(m, ctx) / 2);
  const [w0, w1] = countWins(games);
  if (w0 >= target) return 0;
  if (w1 >= target) return 1;
  return null;
}

function isDone(m, ctx) {
  return winnerIdx(m, ctx) !== null;
}

function isDeadTie(st, rank) {
  const rec = st[rank - 1];
  return !!rec && !!rec.tie; // tie flag: the ladder exhausted without separating it
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
      const { gd, pd } = gameDiff(m.games);
      r0.gd += gd; r0.pd += pd;
      r1.gd -= gd; r1.pd -= pd;
    }
  }
  return poolLadder([...recs.values()], ms, ctx);
}

// Head-to-head keys within a set of teams: wins, game diff, point diff over
// exactly the matches where both sides are in the set. Forfeits count as wins
// but carry no differential, matching the overall tally.
function mutualKeys(list, ms, ctx) {
  const h = new Map(list.map(r => [r.sig, { hw: 0, hg: 0, hp: 0 }]));
  for (const m of ms) {
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const a = pairSig(s0.ids), b = pairSig(s1.ids);
    if (!h.has(a) || !h.has(b)) continue;
    const w = winnerIdx(m, ctx);
    if (w === null) continue;
    const ka = h.get(a), kb = h.get(b);
    (w === 0 ? ka : kb).hw++;
    if (m.forfeit === undefined) {
      const { gd, pd } = gameDiff(m.games);
      ka.hg += gd; ka.hp += pd; kb.hg -= gd; kb.hp -= pd;
    }
  }
  return h;
}

// Classification ladder (FIBA / Six Invitational / Esports Wales): wins decide
// first, against the whole pool; within each wins-block the ladder runs head
// to head — wins, game differential, point differential over the block's
// mutual matches only — then overall game/point differential. After a rung
// separates some teams, the rest repeat the ladder restricted to themselves
// (mutual keys recompute over the smaller set — a pair always splits via their
// mutual match); a block still tied on the whole ladder is a dead tie
// (flagged, renders TBD — the organizer arbitrates). Stable sort keeps
// equal-key teams in creation order.
function poolLadder(list, ms, ctx) {
  const out = [];
  const order = (set) => {
    if (set.length <= 1) { out.push(...set); return; }
    const h = mutualKeys(set, ms, ctx);
    const cmp = (a, b) => {
      const ka = [h.get(a.sig).hw, h.get(a.sig).hg, h.get(a.sig).hp, a.gd, a.pd];
      const kb = [h.get(b.sig).hw, h.get(b.sig).hg, h.get(b.sig).hp, b.gd, b.pd];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    };
    set.sort(cmp); // every caller passes a fresh slice
    for (let i = 0; i < set.length;) {
      let j = i + 1;
      while (j < set.length && cmp(set[i], set[j]) === 0) j++;
      const cluster = set.slice(i, j);
      if (cluster.length === 1) out.push(cluster[0]);
      else if (cluster.length === set.length) {
        for (const r of cluster) r.tie = true;
        out.push(...cluster);
      } else order(cluster);
      i = j;
    }
  };
  const top = [...list].sort((a, b) => b.wins - a.wins);
  for (let i = 0; i < top.length;) {
    let j = i + 1;
    while (j < top.length && top[j].wins === top[i].wins) j++;
    order(top.slice(i, j));
    i = j;
  }
  return out;
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
// waiting: "Winner of 7", "Loser of 9", "2nd in Pool A" (dead ties stay
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
// resolves to them. "Winner of 9" slots stay off the schedule until m9 is
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
// play from that point. ponytail: O(N²) per id, memoized — fine while brackets
// are tiny; a reverse-edge index is the upgrade if they ever grow.
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
  const ts = open.map(id => schedTime(ctx.byId.get(id), ctx.tz)).filter(t => t !== null);
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
// semis), null for main-bracket matches. Model: every placement match has a
// rank range — the possible final ranks of its two teams. A loser edge from a
// main-bracket round opens the round's loser range; inside the placement
// bracket a winner edge takes the top half of its feeder's range, a loser edge
// the bottom half. A match whose loser edge feeds nothing decides a rank (the
// top of its range); otherwise it's a classification semi over the range.
function placementLabel(m, ctx) {
  if (!ctx._plMemo) ctx._plMemo = new Map();
  const r = plRange(m, ctx, ctx._plMemo);
  if (!r) return null;
  const terminal = !ctx.matches.some(X => X.sides && X.sides.some(s => s && s.kind === 'match' && s.match === m.id && s.result === 'loser'));
  return terminal ? `${ordinal(r.lo)} place` : `${ordinal(r.lo)}–${ordinal(r.hi)} semi`;
}

// Half of a placement feeder's range: winner edges take the top, loser edges
// the bottom — the rank semantics the bracket assigns, whatever the pairing.
const half = (r, top) => { const w = (r.hi - r.lo + 1) / 2; return top ? { lo: r.lo, hi: r.lo + w - 1 } : { lo: r.lo + w, hi: r.hi }; };

// Loser range of a main-bracket round at winnerDepth d: it can lose ranks
// [2^d + 1, 2^(d+1)] — d=1 (semis) loses 3rd–4th, d=2 (quarters) 5th–8th.
const loserRange = (X, ctx) => { const d = winnerDepth(ctx, X.id); return { lo: 2 ** d + 1, hi: 2 ** (d + 1) }; };

// Possible final ranks of the two teams in a placement match, null for
// main-bracket matches. Memoized per category like koColumn's columns.
function plRange(m, ctx, memo) {
  if (memo.has(m.id)) return memo.get(m.id);
  memo.set(m.id, null); // in-progress guard — validate rejects cycles; this only stops a hang if one slips past the gate
  let lo = Infinity, hi = -Infinity;
  for (const s of m.sides) {
    if (!s || s.kind !== 'match') continue;
    const X = ctx.byId.get(s.match);
    if (!X) continue;
    const inner = plRange(X, ctx, memo);
    const r = inner ? half(inner, s.result === 'winner')
      : s.result === 'loser' ? loserRange(X, ctx) : null;
    if (r) { lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi); }
  }
  const out = hi === -Infinity ? null : { lo, hi };
  memo.set(m.id, out);
  return out;
}

// Winner-edge distance to the final (0 = the final itself): the round a loser
// edge branches from, for placement labels. matchRound can't do this — a bye'd
// semi fed by pool slots has leaf-depth 0 yet sits one round below the final,
// and a wrong d mislabels the bronze match as a classification round.
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

// IANA tz -> "+02:00"-style offset on a calendar date (Europe/Zurich in Sep is
// CEST), noon-UTC so one date lands one stable offset — a DST-switch day picks
// the post-switch offset throughout. Wall-clock scheduled strings resolve via
// this, so the data stays readable local time and stays right if clock rules
// change — no stamped offsets that can go stale. The generator stores local
// time and the tz (already in the file) does the work — shared by tools and
// site from this one place.
function tzOffset(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(date + 'T12:00:00Z')).find((x) => x.type === 'timeZoneName');
  return p && p.value !== 'GMT' ? p.value.replace('GMT', '') : '+00:00';
}

function fmtTime(t, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}

function dayKey(t, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

// A scheduled field is local wall time in the tournament's tz (no offset in
// the data — the tz at the top of the file interprets it). Anchor it to an
// instant here, the single derivation point.
function schedTime(m, tz) {
  const s = m.scheduled || '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const t = Date.parse(s + tzOffset(tz, s.slice(0, 10)));
  return Number.isNaN(t) ? null : t;
}

function gamesText(m) {
  return (m.games || []).map(g => `${g.a}:${g.b}`).join(' · ');
}

function fmtDiff(n) {
  return (n > 0 ? '+' : '') + n;
}

// Card status: overdue = full slot elapsed without a result, live = started
// but inside its slot, else next (> not >=: the boundary instant belongs to live).
function kioskStatus(r, now) {
  const t = r.t;
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'live';
  return 'next';
}

// Knockout round names by distance from the final: each round back doubles
// participants (2 -> Final, 4 -> Semifinals, 8 -> Quarterfinals, ...). With
// byes a first round of 2 matches is still structurally Quarterfinals; names
// key off koColumn, so a bye'd semi (two pool slots) reads as a semifinal, not
// a first-round match.
function roundName(depthFromEnd) {
  const n = 2 << depthFromEnd;
  return { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals' }[n] || `Round of ${n}`;
}

// Bracket column: 0 is the final column, each winner edge one column back.
// Depth-from-leaves (matchRound) can't place a bye'd semi — two pool slots give
// it depth 0, yet its winner feeds the final. Winner edges
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
  module.exports = { ID_RE, pairSig, makeCat, matchSlotMs, bestOfOf, winnerIdx, isDone, isDeadTie, poolStandings, resolveSide, slotLabel, teamLabel, sideLabel, playerMatches, reachableKo, possibleSpan, matchRound, placementLabel, fmtTime, dayKey, tzOffset, schedTime, gamesText, fmtDiff, kioskStatus, roundName, koColumn, matchLabel };
}
