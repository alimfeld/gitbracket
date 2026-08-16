'use strict';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// Shared side identity: sorted '|'-joined ids.
const pairSig = ids => [...ids].sort().join('|');

function makeCat(c, tjson) {
  // Never throws on broken shape — the validator calls this while reporting it.
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

// Effective slot length, ms: match override > per-stage category config
// (groups/knockout — a match is groups iff it has a pool).
function matchSlotMs(m, ctx) {
  const stage = m && m.pool !== undefined ? 'groups' : 'knockout';
  const cfg = (ctx && ctx.slotMinutes) || {};
  return ((m && m.slotMinutes) ?? cfg[stage]) * 60 * 1000;
}


// Raw game wins per side, target not applied — the played-consistency base.
function countWins(games) {
  const w = [0, 0];
  for (const g of games) {
    if (g.a > g.b) w[0]++;
    else if (g.b > g.a) w[1]++;
  }
  return w;
}

// Sides are 'a'/'b' like game scores — the one letter<->index translation.
const sideIdx = w => w === 'a' ? 0 : 1;
const sideLetter = i => i === 0 ? 'a' : 'b';

// Net game/point differential from side 0's viewpoint; side 1's are the negations.
function gameDiff(games) {
  let gd = 0, pd = 0;
  for (const g of games) {
    gd += g.a > g.b ? 1 : -1;
    pd += g.a - g.b;
  }
  return { gd, pd };
}

// Effective best-of: match override > per-stage category config.
function bestOfOf(m, ctx) {
  const stage = m.pool !== undefined ? 'groups' : 'knockout';
  return m.bestOf ?? ctx.bestOf[stage];
}

function winnerIdx(m, ctx) {
  // The stored winner IS the outcome; in-play matches have no result -> null.
  return m && m.result && m.result.winner !== undefined ? sideIdx(m.result.winner) : null;
}

function isDone(m, ctx) {
  // Any result settles the match — void included (settled, never overdue).
  return !!m && m.result !== undefined;
}

function isDeadTie(st, rank) {
  const rec = st[rank - 1];
  return !!rec && !!rec.tie; // tie cluster id: the ladder exhausted without separating it
}

// Competition ranks: a dead-tie cluster shares its first rank (1 1 3 3); the
// flag carries its cluster id so adjacent ties don't merge.
function poolRanks(st) {
  const ranks = [];
  for (let i = 0; i < st.length; i++) {
    ranks.push((!st[i].tie || i === 0 || st[i - 1].tie !== st[i].tie) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

function poolStandings(ctx, pool, partial) {
  // partial=true: skip unfinished matches — live standings; strict form TBDs.
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
      if (m.result !== undefined) continue; // void: settled, counts nothing
      if (!partial) return null;
      continue;
    }
    const s0 = m.sides[0], s1 = m.sides[1];
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const r0 = recs.get(pairSig(s0.ids)), r1 = recs.get(pairSig(s1.ids));
    if (!r0 || !r1) continue;
    (w === 0 ? r0 : r1).wins++;
    (w === 0 ? r1 : r0).losses++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      r0.gd += gd; r0.pd += pd;
      r1.gd -= gd; r1.pd -= pd;
    }
  }
  return poolLadder([...recs.values()], ms, ctx);
}

// Head-to-head over the set's mutual matches only (walkovers carry no differential).
function mutualKeys(list, ms, ctx) {
  const h = new Map(list.map(r => [r.sig, { hw: 0, hg: 0, hp: 0 }]));
  for (const m of ms) {
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const a = pairSig(s0.ids), b = pairSig(s1.ids);
    if (!h.has(a) || !h.has(b)) continue;
    const w = winnerIdx(m, ctx);
    if (w === null) continue; // void contributes nothing, pending stalls nothing here
    const ka = h.get(a), kb = h.get(b);
    (w === 0 ? ka : kb).hw++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      ka.hg += gd; ka.hp += pd; kb.hg -= gd; kb.hp -= pd;
    }
  }
  return h;
}

// Ladder: wins, then per wins-block h2h wins/gd/pd, then overall
// gd/pd. A rung that splits a cluster recurses on it; a still-tied block is a
// dead tie (renders TBD). Stable sort keeps equal keys in creation order.
function poolLadder(list, ms, ctx) {
  const out = [];
  let tieCluster = 0; // one id per dead-tie cluster — poolRanks shares a rank only within it
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
        tieCluster++;
        for (const r of cluster) r.tie = tieCluster; // truthy so isDeadTie keeps working
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
    if (memo.has(m.id)) return memo.get(m.id) || null; // in-progress = cycle guard
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

// Unresolved slot keeps what the slot IS: "Winner of 7", "2nd in Pool A".
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

// Confirmed only: a side must resolve to the player — undecided slots stay off.
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

// Open knockout seats from confirmed matches through undecided slots; a decided
// feeder only forwards the branch the player got (confirmed ones render as cards).
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
// play from that point. ponytail: O(N²) worst case with a shared memo (see
// possibleSpan) — fine while brackets are tiny; a reverse-edge index is the
// upgrade if they ever grow.
function chainLen(ctx, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, 0); // in-progress = cycle guard
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

// Day-span of this player's open knockout slots (null when none). Pre-knockout
// every path is possible — times are pre-scheduled. count = the longest single
// path. ponytail: fallback assumes everyone advances; gate it on pool
// completion if a format with a knockout cutoff ever appears.
function possibleSpan(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const ko = rows.filter(r => r.m.pool === undefined);
  let open = [...reachableKo(ctx, pid)];
  if (!open.length && rows.some(r => r.m.pool !== undefined) && !ko.length) {
    open = ctx.matches.filter(m => m.pool === undefined).map(m => m.id);
  }
  const memo = new Map(); // one memo across open ids — sibling paths share it, not just one chain
  const ts = open.map(id => schedTime(ctx.byId.get(id), ctx.tz)).filter(t => t !== null);
  if (!ts.length) return null;
  return { min: Math.min(...ts), max: Math.max(...ts), count: Math.max(...open.map(id => chainLen(ctx, id, memo))) };
}

function matchRound(m, ctx, memo = new Map()) {
  if (memo.has(m.id)) return memo.get(m.id);
  memo.set(m.id, 0); // in-progress = cycle guard
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

// Placement label (3rd/5th/7th place, classification semis), null for main-
// bracket matches. Possible final ranks form a range: loser edges open their
// feeder round's loser range; winner/loser edges inside take the top/bottom
// half. Terminal = a place match, else a semi. Memo rides ctx._plMemo —
// rebuilt each render, so a polled page picks up new results.
function placementLabel(m, ctx) {
  if (!ctx._plMemo) ctx._plMemo = new Map();
  const r = plRange(m, ctx, ctx._plMemo);
  if (!r) return null;
  const terminal = !ctx.matches.some(X => X.sides && X.sides.some(s => s && s.kind === 'match' && s.match === m.id && s.result === 'loser'));
  return terminal ? `${ordinal(r.lo)} place` : `${ordinal(r.lo)}–${ordinal(r.hi)} semi`;
}

// Half of a feeder's range: winner edges take the top, loser edges the bottom.
const half = (r, top) => { const w = (r.hi - r.lo + 1) / 2; return top ? { lo: r.lo, hi: r.lo + w - 1 } : { lo: r.lo + w, hi: r.hi }; };

// Loser range of a main-bracket round at winnerDepth d: [2^d + 1, 2^(d+1)].
const loserRange = (X, ctx) => { const d = winnerDepth(ctx, X.id); return { lo: 2 ** d + 1, hi: 2 ** (d + 1) }; };

// Possible rank range; null for main-bracket matches. Memoized per category.
function plRange(m, ctx, memo) {
  if (memo.has(m.id)) return memo.get(m.id);
  memo.set(m.id, null); // in-progress = cycle guard
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
// edge branches from. matchRound can't do it — a bye'd semi has leaf-depth 0
// yet sits one round below the final. koColumn can't be reused here either:
// plRange is called during koColumn's final-detection while its memo is
// mid-build — its in-progress -1 guard would corrupt the ranges.
function winnerDepth(ctx, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, -1); // in-progress = cycle guard
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

// "+02:00"-style offset for a date, noon-UTC anchor.
// ponytail: wall times before a same-day clock change (a DST-shift morning) get
// the post-transition offset, off by one hour — exact per-minute offsets only
// if a tournament ever opens on a changeover day.
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

// Anchor local wall time to an instant — the single derivation point.
function schedTime(m, tz) {
  const s = m.scheduled || '';
  if (!ISO_RE.test(s)) return null;
  const t = Date.parse(s + tzOffset(tz, s.slice(0, 10)));
  return Number.isNaN(t) ? null : t;
}

function gamesText(m) {
  return (m.games || []).map(g => `${g.a}:${g.b}`).join(' · ');
}

function fmtDiff(n) {
  return (n > 0 ? '+' : '') + n;
}

// overdue = slot fully elapsed, live = inside it, else next (now === t is live).
function kioskStatus(r, now) {
  const t = r.t;
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'live';
  return 'next';
}

// Round names by distance from the final (2 -> Final, 4 -> Semifinals, ...);
// keyed off koColumn, so a bye'd semi still reads as a semifinal.
function roundName(depthFromEnd) {
  const n = 2 << depthFromEnd;
  return { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals' }[n] || `Round of ${n}`;
}

// Column: 0 is the final, one back per winner edge. Depth-from-leaves can't
// place a bye'd semi; placement winners don't extend the chain. Memo rides
// ctx._koCol — rebuilt each render, so a polled page picks up new results.
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
      memo.set(X.id, -1); // in-progress = cycle guard
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
  module.exports = { ID_RE, ISO_RE, pairSig, makeCat, matchSlotMs, bestOfOf, countWins, sideIdx, sideLetter, winnerIdx, isDone, isDeadTie, poolStandings, poolRanks, resolveSide, slotLabel, teamLabel, sideLabel, playerMatches, reachableKo, possibleSpan, matchRound, placementLabel, fmtTime, dayKey, tzOffset, schedTime, gamesText, fmtDiff, kioskStatus, roundName, koColumn, matchLabel };
}
