'use strict';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A score row renders one placeholder per possible game; the gate rejects larger overrides.
const MAX_BEST_OF = 9;

// A stage's best-of: an odd number 1..MAX_BEST_OF. The one rule the gate, the
// generator, and the scorer share, so they can never disagree.
const validBestOf = b => Number.isInteger(b) && b % 2 === 1 && b >= 1 && b <= MAX_BEST_OF;

const pairSig = ids => [...ids].sort().join('|');

// One per-render lazy field: built at most once; toCats rebuilds contexts every
// render, so a memo can't outlive it.
const memoField = (ctx, key, build) => {
  const memo = ctx._memo || (ctx._memo = {});
  if (memo[key] === undefined) memo[key] = build();
  return memo[key];
};

// id -> display name; a malformed entry renders absent, never throws.
const nameMap = x => new Map((Array.isArray(x) ? x : []).filter(e => e && typeof e === 'object').map(e => [e.id, e.name]));

// Built once per render by toCats; standalone makeCat calls make a fresh map.
function sharedFacts(tjson) {
  return {
    names: nameMap(tjson && tjson.players),
    tz: (tjson && tjson.timezone) || 'UTC',
    venues: nameMap(tjson && tjson.venues),
  };
}

function makeCat(c, tjson, shared, order = 0) {
  // Never throws on broken shape — the validator calls this while reporting it.
  const matches = (Array.isArray(c.matches) ? c.matches : []).filter(m => m && typeof m === 'object');
  const s = shared || sharedFacts(tjson);
  return {
    matches,
    byId: new Map(matches.map(m => [m.id, m])),
    bestOf: (c.meta && c.meta.bestOf) || {},
    names: s.names,
    tz: s.tz,
    slotMinutes: (c.meta && c.meta.slotMinutes) || {},
    venues: s.venues,
    name: (c.meta && c.meta.name) || '',
    id: (c.meta && c.meta.id) || '',
    order
  };
}

// The one matches-map shape guard; null when malformed.
const matchesOf = tjson => (tjson && tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches)) ? tjson.matches : null;

function toCats(tjson) {
  const byCat = matchesOf(tjson) || {};
  const cats = (tjson && Array.isArray(tjson.categories)) ? tjson.categories : [];
  const shared = sharedFacts(tjson); // once per render — every category shares the one map
  // A non-object entry renders as absent — the gate reports it, the page never throws.
  return cats.filter(c => c && typeof c === 'object').map((c, i) => makeCat({ meta: c, matches: Array.isArray(byCat[c.id]) ? byCat[c.id] : [] }, tjson, shared, i));
}

const stageOf = m => m?.pool !== undefined ? 'groups' : 'knockout';

function matchSlotMs(m, ctx) {
  const cfg = (ctx && ctx.slotMinutes) || {};
  return (m?.slotMinutes ?? cfg[stageOf(m)]) * 60 * 1000;
}

const sideIdx = w => w === 'a' ? 0 : 1;

function gameDiff(games) {
  let gd = 0, pd = 0;
  if (Array.isArray(games)) for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    gd += Math.sign(g.a - g.b);
    pd += g.a - g.b;
  }
  return { gd, pd };
}

function bestOfOf(m, ctx) {
  return m.bestOf ?? (ctx?.bestOf || {})[stageOf(m)]; // a raw validate ctx may carry no bestOf
}

// A best-of-1 pool's GD just restates W−L; one match overridden to best-of-3 brings it back.
function poolBo1(ctx, pool) {
  return ctx.matches.filter(m => m && m.pool === pool).every(m => bestOfOf(m, ctx) === 1);
}

function winnerIdx(m) {
  return m && m.result && m.result.winner !== undefined ? sideIdx(m.result.winner) : null;
}

function isDone(m) {
  // Any result settles the match — void included (settled, never overdue).
  return !!m && m.result !== undefined;
}

function isDeadTie(std, rank) {
  const rec = std[rank - 1];
  return !!rec && !!rec.tie; // tie cluster id: the ladder exhausted without separating it
}

// A dead-tie cluster shares its first rank (1 1 3 3); the cluster id keeps adjacent ties from merging.
function poolRanks(std) {
  const ranks = [];
  for (let i = 0; i < std.length; i++) {
    ranks.push((!std[i].tie || i === 0 || std[i - 1].tie !== std[i].tie) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

// Rank cells stay blank until a pool has a decided match.
const poolDecided = std => !!std && std.some(r => r.wins || r.losses);

function poolStandings(ctx, pool, partial) {
  // partial=true: skip unfinished matches — live standings; strict form TBDs.
  const ms = ctx.matches.filter(m => m && m.pool === pool);
  if (ms.length === 0) return null;
  const recs = new Map();
  const rec = s => {
    if (!(s && s.kind === 'players' && Array.isArray(s.ids))) return null;
    const sig = pairSig(s.ids);
    let r = recs.get(sig);
    if (!r) { r = { sig, ids: new Set(s.ids), wins: 0, losses: 0, gd: 0, pd: 0 }; recs.set(sig, r); }
    return r;
  };
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue;
    // Map insertion order is the tie display order.
    const s0 = m.sides[0], s1 = m.sides[1];
    const r0 = rec(s0), r1 = rec(s1);
    if (!r0 || !r1) continue;
    const w = winnerIdx(m);
    if (w === null) {
      if (m.result !== undefined) continue; // void: settled, counts nothing
      if (!partial) return null;
      continue;
    }
    (w === 0 ? r0 : r1).wins++;
    (w === 0 ? r1 : r0).losses++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      r0.gd += gd; r0.pd += pd;
      r1.gd -= gd; r1.pd -= pd;
    }
  }
  return poolLadder([...recs.values()], ms);
}

// Head-to-head over the set's mutual matches only (walkovers carry no differential).
function mutualKeys(list, ms) {
  const h = new Map(list.map(r => [r.sig, { hw: 0, hg: 0, hp: 0 }]));
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue;
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    if (!Array.isArray(s0.ids) || !Array.isArray(s1.ids)) continue; // rec() guarded these; the ladder re-reads every pool match
    const a = pairSig(s0.ids), b = pairSig(s1.ids);
    if (!h.has(a) || !h.has(b)) continue;
    const w = winnerIdx(m);
    if (w === null) continue;
    const ka = h.get(a), kb = h.get(b);
    (w === 0 ? ka : kb).hw++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      ka.hg += gd; ka.hp += pd; kb.hg -= gd; kb.hp -= pd;
    }
  }
  return h;
}

// Ladder: wins, then per wins-block h2h wins/gd/pd, then overall gd/pd. A rung that
// splits a cluster recurses; a still-tied block is a dead tie (renders TBD).
function poolLadder(list, ms) {
  const out = [];
  let tieCluster = 0; // one id per dead-tie cluster — poolRanks shares a rank only within it
  const order = (set) => {
    if (set.length <= 1) { out.push(...set); return; }
    const h = mutualKeys(set, ms);
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
  if (side.kind === 'players') return Array.isArray(side.ids) ? new Set(side.ids) : null; // a string ids would char-split in a Set
  if (side.kind === 'match') {
    const m = ctx.byId.get(side.match);
    if (!m || !Array.isArray(m.sides)) return null;
    if (memo.has(m.id)) return memo.get(m.id) || null; // in-progress = cycle guard
    memo.set(m.id, undefined);
    const w = winnerIdx(m);
    if (w === null) return null;
    const child = m.sides[side.result === 'winner' ? w : 1 - w];
    const v = resolveSide(child, ctx, memo);
    memo.set(m.id, v);
    return v;
  }
  if (side.kind === 'pool') {
    const std = poolStandings(ctx, side.pool);
    if (!std) return null;
    const rec = std[side.rank - 1];
    if (!rec || isDeadTie(std, side.rank)) return null; // dead tie -> TBD
    return rec.ids;
  }
  return null;
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

// Both result edges count — a loss drops the player into the placement tree. Reads parentsOf, never a scan.
function koConsumers(ctx, id) {
  const { winnerParent, loserParent } = parentsOf(ctx);
  const out = [winnerParent.get(id), loserParent.get(id)].filter(X => X && X.pool === undefined);
  return [...new Set(out)]; // one match may consume both edges of id
}

// Per pool: sigs (side count) and slots (rank -> consuming match), from stored sides only.
function poolFacts(ctx) {
  const out = new Map();
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    if (m.pool !== undefined) {
      for (const s of m.sides) {
        if (s && s.kind === 'players' && Array.isArray(s.ids)) {
          if (!out.has(m.pool)) out.set(m.pool, { sigs: new Set(), slots: new Map() });
          out.get(m.pool).sigs.add(pairSig(s.ids));
        }
      }
    } else {
      for (const s of m.sides) {
        if (s && s.kind === 'pool' && typeof s.rank === 'number' && s.rank >= 1) {
          if (!out.has(s.pool)) out.set(s.pool, { sigs: new Set(), slots: new Map() });
          out.get(s.pool).slots.set(s.rank, m);
        }
      }
    }
  }
  return out;
}

// Ranks a player could still hold: every rank while any pool match is out, else the dead-tie cluster.
function playerRanks(ctx, pool, pid, roster) {
  const std = poolStandings(ctx, pool);
  if (!std) return Array.from({ length: roster }, (_, i) => i + 1);
  const i = std.findIndex(x => x.ids.has(pid));
  if (i < 0 || !isDeadTie(std, i + 1)) return [];
  const out = [];
  let a = i; while (a > 0 && std[a - 1].tie === std[i].tie) a--;
  let b = i; while (b < std.length - 1 && std[b + 1].tie === std[i].tie) b++;
  for (let r = a + 1; r <= b + 1; r++) out.push(r);
  return out;
}

// Reachable knockout stages for a player: the matches they could still reach,
// grouped structurally, with the rank seats and result edges that gate each.
// Facts only — the browser names and merges them. Confirmed seats are excluded.
function possibleStageFacts(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const koRows = rows.filter(r => r.m.pool === undefined);
  const confIds = new Set(koRows.map(r => r.m.id));
  const poolRow = rows.find(r => r.m.pool !== undefined);
  const pool = poolRow === undefined ? null : poolRow.m.pool;
  const facts = (koRows.length || pool === null) ? null : poolFacts(ctx).get(pool);
  const seats = facts ? playerRanks(ctx, pool, pid, facts.sigs.size) : [];

  // Seats recorded separately from the reach BFS — one match can seat the
  // player via several ranks or edges, and the seen-guard must not drop the
  // second record.
  const poolSeatsOf = new Map(); // match id -> [rank]
  const edgeSeatsOf = new Map(); // match id -> [{ kind, parent }]
  const gate = new Map();        // confirmed seat id -> opened result edges
  const seen = new Set();
  const queue = [];
  const add = m => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    queue.push(m.id);
  };
  if (koRows.length) {
    // A decided seat opens only the branch the player finished on; an undone
    // (or void) one keeps both — the player could still win or lose.
    for (const r of koRows) {
      const w = winnerIdx(r.m);
      gate.set(r.m.id, w === null ? 'either' : w === r.i ? 'winner' : 'loser');
      add(r.m); // confirmed seats render as cards — no stage entry
    }
  } else if (facts) {
    for (const r of seats) {
      const m = facts.slots.get(r);
      if (!m) continue;
      if (!poolSeatsOf.has(m.id)) poolSeatsOf.set(m.id, []);
      poolSeatsOf.get(m.id).push(r);
      add(m);
    }
  }
  while (queue.length) {
    const id = queue.shift();
    const g = gate.get(id);
    for (const X of koConsumers(ctx, id)) {
      for (const s of X.sides) {
        if (!s || s.kind !== 'match' || s.match !== id) continue;
        if (g === 'winner' && s.result !== 'winner') continue;
        if (g === 'loser' && s.result !== 'loser') continue;
        if (!edgeSeatsOf.has(X.id)) edgeSeatsOf.set(X.id, []);
        edgeSeatsOf.get(X.id).push({ kind: s.result, parent: id });
        add(X);
      }
    }
  }

  // Group reached matches into structural stages: identity is the placement range
  // or bracket column, never a rendered label, so grouping survives any locale.
  const stages = new Map();
  for (const id of seen) {
    if (confIds.has(id)) continue;
    const m = ctx.byId.get(id);
    if (!m || !Array.isArray(m.sides)) continue;
    const pr = plRange(m, ctx);
    const col = pr === null ? koColumn(m, ctx) : null;
    const key = pr ? `pl:${pr.lo}-${pr.hi}-${pr.win}` : `r:${col}`;
    let stage = stages.get(key);
    if (!stage) { stage = { col, pl: pr, ranks: new Set(), edges: [], times: [], courts: [], n: 0 }; stages.set(key, stage); }
    stage.n++; // only the count is read (slotSet); the match objects aren't kept
    for (const rank of poolSeatsOf.get(id) || []) stage.ranks.add(rank);
    for (const e of edgeSeatsOf.get(id) || []) stage.edges.push(e);
    const ts = schedTime(m, ctx.tz);
    if (ts !== null) stage.times.push(ts);
    if (typeof m.venue === 'string') stage.courts.push(m.venue);
  }
  return { stages: [...stages.values()], pool, seats, hasPoolFacts: !!facts };
}

// rankRange collapses runs, so a band must arrive as every rank it spans — [5, 8] would render "5th, 8th".
const rangeRanks = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// Possible-rank range of every classification match: a slot reaches the range of
// whichever match consumes that edge (winner edges climb, loser edges drop); an
// edge nothing consumes holds a fixed rank stepped out from the pool champion.
function plBuild(ctx) {
  const pl = new Map(); // id -> { lo, hi, win } (win: winner edge unconsumed)
  const byId = ctx.byId;
  const { winnerParent, loserParent } = parentsOf(ctx); // same edge classification the bracket consumers read — no drift
  const adj = new Map(); // undirected match-edge links for the reachability walk
  const addLink = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || !byId.has(s.match)) continue; // dangling refs stay off the walk
      addLink(m.id, s.match);
      addLink(s.match, m.id);
    }
  }
  // Classification match: a loser edge as a slot (main-bracket matches carry
  // only winner and player sides), or a slot from a classified match.
  const memMemo = new Map();
  const member = (m) => {
    if (!m || !Array.isArray(m.sides)) return false; // dangling ref or malformed sides — the gate reports it, the walk skips it
    if (memMemo.has(m.id)) return memMemo.get(m.id);
    memMemo.set(m.id, false);
    // A loser side makes it a classification match; a non-loser side inherits
    // from the match it consumes. A dangling target is not a member.
    const yes = m.sides.some(s => s && s.kind === 'match' &&
      (s.result === 'loser' || member(byId.get(s.match))));
    memMemo.set(m.id, yes);
    return yes;
  };
  // Pool champion: a match nothing winner-consumes whose all-winner chain bottoms
  // out at a main-round loser edge. Returns the anchor round's winner depth d.
  const champAnchor = (m, seen) => {
    if (!m || !Array.isArray(m.sides) || seen.has(m.id)) return null; // a dangling feeder is the gate's finding, never a throw
    seen.add(m.id);
    const lost = m.sides.find(s => s && s.kind === 'match' && s.result === 'loser');
    if (lost) {
      const X = byId.get(lost.match);
      // A main-round loser edge anchors the band; a chain through the
      // classification is a sub-bracket final — not the champion.
      return X && !member(X) ? wdOf(ctx, X.id) : null;
    }
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || s.result !== 'winner') continue;
      const r = champAnchor(byId.get(s.match), seen);
      if (r !== null) return r;
    }
    return null;
  };
  // One pass: each pool champion and its own rank A, plus how many pools share
  // that A. A band whose deciders were never played holds several terminal
  // matches at the same A — that shared lo is the signal the band is entered,
  // not resolved.
  const pools = []; // [champion, A]
  const termCount = new Map(); // A -> terminal count
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides) || winnerParent.has(m.id)) continue;
    if (!m.sides.some(s => s && s.kind === 'match')) continue;
    const d = champAnchor(m, new Set());
    if (d === null) continue;
    const A = 2 ** d + 1;
    pools.push([m, A]);
    termCount.set(A, (termCount.get(A) ?? 0) + 1);
  }
  for (const [champ, A] of pools) {
    const k = termCount.get(A); // >1: the band played its entry round only
    let next = A + 2;
    // Reachability from the champion over classification matches only — main-
    // bracket neighbors fail member() and stay out; winner-edge links before
    // loser- links so tied terminals rank in winner order.
    const seen = new Set([champ.id]);
    const queue = [champ];
    const candsOf = (N) => {
      const wp = winnerParent.get(N.id); // the winner-parent neighbor sorts first
      return (adj.get(N.id) || [])
        .filter(x => !seen.has(x) && member(byId.get(x)))
        .sort((a, b) => (byId.get(b) === wp) - (byId.get(a) === wp));
    };
    const spec = new Map(); // id -> [winner edge, loser edge]: a rank, or the consuming match's id
    for (let qi = 0; qi < queue.length; qi++) {
      const N = queue[qi];
      const pw = winnerParent.get(N.id), lp = loserParent.get(N.id);
      const w = pw ? ['r', pw.id] : N === champ ? ['n', A] : ['n', next++];
      const l = lp ? ['r', lp.id] : N === champ ? ['n', A + 1] : ['n', next++];
      spec.set(N.id, [w, l]);
      for (const x of candsOf(N)) { seen.add(x); queue.push(byId.get(x)); }
    }
    const resolve = (id) => {
      if (pl.has(id)) return pl.get(id);
      pl.set(id, null);
      const [w, l] = spec.get(id) || [];
      const val = (x) => x && (x[0] === 'n' ? { lo: x[1], hi: x[1] } : resolve(x[1])) || null;
      const wv = val(w), lv = val(l);
      let out = wv && lv
        ? { lo: Math.min(wv.lo, lv.lo), hi: Math.max(wv.hi, lv.hi), win: !winnerParent.has(id) }
        : null;
      // an entered-but-unresolved band spans its full range and ties (5 5 7 7),
      // never stepping through 5 6 7 8
      if (out && k > 1 && id === champ.id) out = { lo: A, hi: A + 2 * k - 1, win: false };
      pl.set(id, out);
      return out;
    };
    for (const m of queue) resolve(m.id);
  }
  return pl;
}

// Range of a classification match; null for main-bracket matches. winners reads lo.
function plRange(m, ctx) {
  return memoField(ctx, 'pl', () => plBuild(ctx)).get(m.id) ?? null;
}

// Band-local ordinal of a classification semi: the pairing's first side is the
// better seed, so the semi holding the best loser reads 1. Structural — a
// reschedule never renumbers a card.
function plOrdinal(m, ctx) {
  return memoField(ctx, 'plOrd', () => {
    // Keyed by full span: a band of 8 (9-16) and its sub-band (9-12) share lo,
    // so keying by lo alone would number the 9-16 entries 3-6.
    const bands = new Map(); // band span -> [{ id, key }]
    for (const X of ctx.matches) {
      const r = X && X.pool === undefined ? plRange(X, ctx) : null;
      if (!r || r.win) continue; // band semis only; deciders are already unique
      const first = Array.isArray(X.sides) ? X.sides[0] : null;
      const anchor = first && first.kind === 'match' ? ctx.byId.get(first.match) : null;
      const span = `${r.lo}-${r.hi}`;
      if (!bands.has(span)) bands.set(span, []);
      bands.get(span).push({ id: X.id, key: anchor ? koOrdinal(anchor, ctx) : Infinity });
    }
    const ord = new Map();
    for (const list of bands.values()) {
      list.sort((a, b) => a.key - b.key); // stable: ties keep build order
      list.forEach((e, i) => ord.set(e.id, i + 1));
    }
    return ord;
  }).get(m && m.id) || 0;
}

// Winner-edge distance to the final (0 = the final). Its own memo, not koColumn's
// — this can be read while koColumn's build is mid-flight.
function wdOf(ctx, id) {
  const map = memoField(ctx, 'wd', () => {
    const { winnerParent } = parentsOf(ctx);
    const wdMap = new Map();
    const d = (X) => {
      if (wdMap.has(X.id)) return wdMap.get(X.id);
      wdMap.set(X.id, 0); // in-progress: a malformed cycle reads 0, never recurses
      const p = winnerParent.get(X.id);
      const r = p ? 1 + d(p) : 0;
      wdMap.set(X.id, r);
      return r;
    };
    for (const m of ctx.matches) d(m);
    return wdMap;
  });
  return map.get(id);
}

const zoneFormatters = new Map();
const wallOffsets = new Map();

function zonedParts(tz, instant) {
  try {
    let fmt = zoneFormatters.get(tz);
    if (!fmt) zoneFormatters.set(tz, fmt = new Intl.DateTimeFormat('en', {
      timeZone: tz, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }));
    const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(k => Number(p[k]));
  } catch { return null; }
}

const wallMillis = ([y, mo, d, h, mi, s]) => {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
};

function offsetAt(tz, instant) {
  const parts = zonedParts(tz, instant);
  return parts ? wallMillis(parts) - instant : null;
}

// Offsets on either side of a wall date expose both sides of a DST fold/gap.
// The cache is per date because every scheduled match on that day shares it.
function offsetsFor(tz, date, localMs) {
  const key = `${tz}|${date}`;
  if (!wallOffsets.has(key)) {
    const offsets = new Set();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      const offset = offsetAt(tz, localMs + hours * 3600000);
      if (offset !== null) offsets.add(offset);
    }
    wallOffsets.set(key, [...offsets]);
  }
  return wallOffsets.get(key);
}

// Y-M-D from typed parts, calendar pinned to gregory/Latn — a non-Gregorian or
// native-digit locale would key days by a foreign year or digits.
function dayKey(t, tz) {
  let p = null;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: tz, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  } catch { return null; } // bad tz: no day key — callers' null paths render empty
  return `${p.year}-${p.month}-${p.day}`;
}

// Anchor local wall time to an instant — the single derivation point.
function schedTime(m, tz) {
  const s = (m && m.scheduled) || '';
  if (!ISO_RE.test(s)) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s).slice(1).map(Number);
  const localMs = wallMillis(parts);
  const matches = [];
  for (const offset of offsetsFor(tz, s.slice(0, 10), localMs)) {
    const instant = localMs - offset;
    const actual = zonedParts(tz, instant);
    if (actual && actual.every((part, i) => part === parts[i])) matches.push(instant);
  }
  // A skipped clock time has no candidates; a repeated time chooses its first occurrence.
  return matches.length ? Math.min(...matches) : null;
}

// Wall-clock minutes since midnight in the tournament zone — layout math reads a
// number, never a localized format string.
const wallMin = (t, tz) => {
  const p = zonedParts(tz, t);
  return p ? p[3] * 60 + p[4] : null;
};

// Distinct scheduled days as sorted ISO date keys — the index's stored form.
function schedDays(ms, tz) {
  const ks = new Set();
  for (const m of ms) {
    const t = schedTime(m, tz);
    if (t !== null) ks.add(dayKey(t, tz));
  }
  return [...ks].sort();
}

// The championship final, shared with koOrdinal: a knockout match no winner
// feeds, outside the classification tree.
const mainFinal = (ctx, parented) =>
  ctx.matches.find(X => X.pool === undefined && !parented.has(X.id) && plRange(X, ctx) === null);

// Bracket parent-adjacency in one scan: winnerParent (fed id -> parent), kids
// (parent -> feeder ids, side order), loserFed, loserParent. Every bracket
// consumer reads this one map.
function parentsOf(ctx) {
  return memoField(ctx, 'parents', () => {
    const winnerParent = new Map();
    const kids = new Map();
    const loserFed = new Set();
    const loserParent = new Map();
    for (const X of ctx.matches) {
      if (!Array.isArray(X.sides)) continue; // malformed: report, never throw
      for (const s of X.sides) {
        if (!s || s.kind !== 'match') continue;
        if (s.result === 'winner') {
          winnerParent.set(s.match, X);
          if (!kids.has(X.id)) kids.set(X.id, []);
          kids.get(X.id).push(s.match);
        } else {
          loserFed.add(s.match);
          loserParent.set(s.match, X);
        }
      }
    }
    return { winnerParent, kids, loserFed, loserParent };
  });
}

// Column: 0 is the final, one back per winner edge; depth-from-leaves can't place
// a bye'd semi. Main-tree columns read wd (built before this).
function koColumn(m, ctx) {
  const map = memoField(ctx, 'koCol', () => {
    const koColMap = new Map();
    const { winnerParent } = parentsOf(ctx);
    const final = mainFinal(ctx, winnerParent);
    const col = (X) => {
      const got = koColMap.get(X.id);
      if (got !== undefined) return got;
      koColMap.set(X.id, -1);
      const p = winnerParent.get(X.id);
      let r;
      if (p && plRange(p, ctx) === null) r = wdOf(ctx, X.id);
      else if (X === final) r = 0;
      else {
        const feeders = Array.isArray(X.sides) ? X.sides.filter(s => s && s.kind === 'match' && ctx.byId.has(s.match)).map(s => col(ctx.byId.get(s.match))) : [];
        r = feeders.length ? Math.max(...feeders) - 1 : 0;
      }
      koColMap.set(X.id, r);
      return r;
    };
    for (const X of ctx.matches) col(X);
    return koColMap;
  });
  return map.get(m.id);
}

// Ordinal within a round, from who each winner feeds. Reads bracket structure,
// never `scheduled`, so editing times can't renumber anything. 0 = off the tree.
function koOrdinal(m, ctx) {
  return memoField(ctx, 'koOrd', () => {
    const { kids, winnerParent } = parentsOf(ctx);
    const ord = new Map();
    const final = mainFinal(ctx, winnerParent);
    if (final) {
      ord.set(final.id, 1);
      for (const stack = [final.id]; stack.length;) {
        const p = stack.pop();
        const o = ord.get(p);
        for (const [k, id] of (kids.get(p) || []).entries()) {
          if (!ord.has(id)) { ord.set(id, o * 2 - 1 + k); stack.push(id); }
        }
      }
    }
    return ord;
  }).get(m.id) || 0;
}

// found structurally, never by rendered label.
function winners(ctx) {
  const { winnerParent, loserFed } = parentsOf(ctx);
  const m = mainFinal(ctx, winnerParent); // the one knockout match nothing winner-feeds
  if (!m || !m.result || winnerIdx(m) === null || !Array.isArray(m.sides)) return null;
  const a = resolveSide(m.sides[0], ctx), b = resolveSide(m.sides[1], ctx);
  if (!a || !b) return null;
  const w = winnerIdx(m);
  const out = { first: [...a], second: [...b], third: null, fourth: null };
  if (w === 1) { out.first = [...b]; out.second = [...a]; }
  // the bronze is the terminal match whose possible range starts at 3rd —
  // loserFed keeps a mid-bracket '3rd–4th semi' from being read as the decider itself
  let bronze = null;
  for (const X of ctx.matches) {
    if (!X || X.pool !== undefined || loserFed.has(X.id)) continue;
    const r = plRange(X, ctx);
    if (r && r.lo === 3) { bronze = X; break; }
  }
  if (bronze && bronze.result && winnerIdx(bronze) !== null && Array.isArray(bronze.sides)) {
    const x = resolveSide(bronze.sides[winnerIdx(bronze)], ctx), y = resolveSide(bronze.sides[1 - winnerIdx(bronze)], ctx);
    if (x) out.third = [...x];
    if (y) out.fourth = [...y];
  }
  return out;
}

// KO entries: consumed pool ranks + direct players — byes are absent matches, never 2^depth.
function koField(ctx) {
  let slots = 0;
  const players = new Set();
  for (const m of ctx.matches) {
    if (!m || m.pool !== undefined || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (!s) continue;
      if (s.kind === 'pool' && typeof s.rank === 'number') slots++;
      else if (s.kind === 'players' && Array.isArray(s.ids)) for (const id of s.ids) players.add(id);
    }
  }
  return slots + players.size;
}

// ---- Status and placement facts: what a category, a wave, or a finish is ----

// Depth band of every classification match, one below its anchor's column minus
// further loser-chain edges. A main match (plRange null) is the anchor.
function plBands(ctx) {
  return memoField(ctx, 'plBand', () => {
    const col = new Map(); // placement match id -> band column
    const bandOf = (m) => {
      const got = col.get(m.id);
      if (got !== undefined) return got;
      col.set(m.id, null);
      let cur = m;
      let hops = 0; // placement-tree edges between the anchor's loser slot and m
      const seen = new Set();
      for (;;) {
        seen.add(cur.id);
        const feed = (Array.isArray(cur.sides) ? cur.sides : []).find(s => s && s.kind === 'match' && ctx.byId.has(s.match));
        if (!feed) { cur = null; break; }
        cur = ctx.byId.get(feed.match);
        if (seen.has(cur.id)) { cur = null; break; }
        if (plRange(cur, ctx) === null) break; // the anchor: a main match
        hops++;
      }
      const c = cur === null ? null : Math.max(0, koColumn(cur, ctx) - 1 - hops);
      col.set(m.id, c);
      return c;
    };
    for (const m of ctx.matches) {
      if (!m || m.pool !== undefined || plRange(m, ctx) === null) continue;
      bandOf(m);
    }
    return col;
  });
}

// Band column of a classification match; null elsewhere.
function placementColumn(m, ctx) {
  return plBands(ctx).get(m && m.id) ?? null;
}

// Board status token: done | overdue | now | upcoming.
function kioskStatus(r, now) {
  const t = r.t;
  if (isDone(r.m)) return 'done';
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'now';
  return 'upcoming';
}

// Both sides of a card resolve; a malformed side counts (the gate reports it,
// the status must never throw on it).
const isPlayable = (m, ctx) => !Array.isArray(m.sides) || m.sides.every(s => resolveSide(s, ctx));

// The wave in play: the highest column — the earliest unfinished round, main
// bracket or classification band — whose undone matches are playable, so the
// front round owns the status (both trees share a column numbering).
function waveColumn(ctx) {
  const undone = ctx.matches.filter(m => m.pool === undefined && !m.result);
  if (!undone.length) return null;
  const cols = undone.filter(m => isPlayable(m, ctx))
    .map(m => plRange(m, ctx) === null ? koColumn(m, ctx) : placementColumn(m, ctx))
    .filter(Number.isInteger);
  return cols.length ? Math.max(...cols) : null;
}

// Category status facts: kind groups | ko | finished | winners.
function catStatus(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return null;
  if (ms.every(isDone)) {
    const w = winners(ctx);
    return w ? { kind: 'winners', ...w } : { kind: 'finished' };
  }
  // Nothing played is not a state of its own: it is the first stage at zero
  // progress — groups at 0/N, or the front KO wave.
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) return { kind: 'groups', played: grp.filter(isDone).length, count: grp.length };
  const wave = waveColumn(ctx);
  const main = ms.filter(m => m && m.pool === undefined && !m.result && plRange(m, ctx) === null);
  // A pending main card no playable one can fill is a dead tie, not a round.
  if (main.length && !main.some(m => isPlayable(m, ctx))) return { kind: 'blocked' };
  return { kind: 'ko', wave };
}

// Unplayed matches with both sides resolved, at the earliest scheduled time —
// starts included.
function currentWave(ctx, status) {
  if (!status || status.kind === 'finished' || status.kind === 'winners' || status.kind === 'blocked') return [];
  const ready = ctx.matches.filter(m => !isDone(m) &&
    Array.isArray(m.sides) && m.sides.length === 2 &&
    !!resolveSide(m.sides[0], ctx) && !!resolveSide(m.sides[1], ctx));
  const ts = ready.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
  if (!ts.length) return [];
  const t = Math.min(...ts);
  return ready.filter(m => schedTime(m, ctx.tz) === t);
}

// A finish band: the tightest placement range, a decided two-rank decider's exact
// place (winner lo, loser hi), else the deepest KO loss (a bye'd round clamps the top).
function playerBand(ctx, rows) {
  let best = null, bestR = null;
  for (const r of rows) {
    if (r.m.pool !== undefined) continue;
    const pr = plRange(r.m, ctx);
    if (pr && (!best || pr.hi - pr.lo < best.hi - best.lo)) { best = pr; bestR = r; }
  }
  if (best) {
    const w = best.win && best.hi === best.lo + 1 ? winnerIdx(bestR.m) : null;
    return w !== null ? [bestR.i === w ? best.lo : best.hi] : rangeRanks(best.lo, best.hi);
  }
  const koLost = rows.filter(r => {
    const w = winnerIdx(r.m);
    return w !== null && w !== r.i && r.m.pool === undefined && plRange(r.m, ctx) === null;
  });
  if (!koLost.length) return null;
  const d = Math.max(...koLost.map(r => koColumn(r.m, ctx)));
  const lo = 2 ** d + 1, hi = Math.min(2 ** (d + 1), koField(ctx));
  return lo <= hi ? rangeRanks(lo, hi) : null;
}

if (typeof module !== 'undefined') {
  module.exports = { DATE_RE, ID_RE, ISO_RE, MAX_BEST_OF, validBestOf, pairSig, makeCat, matchesOf, toCats, matchSlotMs, sideIdx, bestOfOf, poolBo1, winnerIdx, isDone, isDeadTie, poolStandings, poolRanks, poolDecided, resolveSide, playerMatches, possibleStageFacts, plRange, plOrdinal, placementColumn, kioskStatus, catStatus, currentWave, playerBand, parentsOf, koColumn, koOrdinal, winners, dayKey, wallMin, schedTime, schedDays };
}
