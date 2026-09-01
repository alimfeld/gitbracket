'use strict';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The one display dialect: every human-visible string renders in it, so the
// kiosk and the tests never vary with the viewer's locale.
const LOCALE = 'en-US';

// Shared side identity: sorted '|'-joined ids.
const pairSig = ids => [...ids].sort().join('|');

// Per-category render cache: one bag on the context, so the freshness contract
// (toCats rebuilds contexts every render, discarding the bag) is one boundary
// to know, not six underscore props. Every *_build/Column memo hangs its data here.
const ctxMemo = ctx => ctx._memo || (ctx._memo = {});

// Tournament-level facts (names, venues, tz) per file — toCats builds them
// once and hands them to every category's context; standalone makeCat calls
// (validate, REPL, sim) build a fresh map per call.
function sharedFacts(tjson) {
  const arr = x => Array.isArray(x) ? x : [];
  return {
    names: new Map(arr(tjson && tjson.players).filter(p => p && typeof p === 'object').map(p => [p.id, p.name])),
    tz: (tjson && tjson.timezone) || 'UTC',
    venues: new Map(arr(tjson && tjson.venues).filter(v => v && typeof v === 'object').map(v => [v.id, v.name])),
  };
}

function makeCat(c, tjson, shared) {
  // Never throws on broken shape — the validator calls this while reporting it.
  const matches = (c.matches || []).filter(m => m && typeof m === 'object');
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
    id: (c.meta && c.meta.id) || ''
  };
}

function toCats(tjson) {
  const byCat = (tjson && tjson.matches && typeof tjson.matches === 'object') ? tjson.matches : {};
  const cats = (tjson && Array.isArray(tjson.categories)) ? tjson.categories : [];
  return cats.map(c => makeCat({ meta: c, matches: Array.isArray(byCat[c.id]) ? byCat[c.id] : [] }, tjson, sharedFacts(tjson)));
}

const stageOf = m => m?.pool !== undefined ? 'groups' : 'knockout';

function matchSlotMs(m, ctx) {
  const cfg = (ctx && ctx.slotMinutes) || {};
  return (m?.slotMinutes ?? cfg[stageOf(m)]) * 60 * 1000;
}


// Raw game wins per side, target not applied.
function countWins(games) {
  const w = [0, 0];
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    if (g.a > g.b) w[0]++;
    else if (g.b > g.a) w[1]++;
  }
  return w;
}

const sideIdx = w => w === 'a' ? 0 : 1;
const sideLetter = i => i === 0 ? 'a' : 'b';

function gameDiff(games) {
  let gd = 0, pd = 0;
  if (Array.isArray(games)) for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    gd += (g.a > g.b) - (g.a < g.b);
    pd += g.a - g.b;
  }
  return { gd, pd };
}

function bestOfOf(m, ctx) {
  return m.bestOf ?? ctx.bestOf[stageOf(m)];
}

function winnerIdx(m) {
  // The stored winner IS the outcome; in-play matches have no result -> null.
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

// Competition ranks: a dead-tie cluster shares its first rank (1 1 3 3); the
// flag carries its cluster id so adjacent ties don't merge.
function poolRanks(std) {
  const ranks = [];
  for (let i = 0; i < std.length; i++) {
    ranks.push((!std[i].tie || i === 0 || std[i - 1].tie !== std[i].tie) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

// Rank cells stay blank until a pool has a decided match — before that every
// team ties at zero and a wall of 1s reads as "all ranked first". The site's
// standings and the REPL's desk sheet share the rule via this one predicate.
const poolDecided = std => std.some(r => r.wins || r.losses);

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
    // rec() builds both records on first sight — Map insertion order is the tie display order.
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
  return poolLadder([...recs.values()], ms, ctx);
}

// Head-to-head over the set's mutual matches only (walkovers carry no differential).
function mutualKeys(list, ms, ctx) {
  const h = new Map(list.map(r => [r.sig, { hw: 0, hg: 0, hp: 0 }]));
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue;
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
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

// Ladder: wins, then per wins-block h2h wins/gd/pd, then overall gd/pd. A rung
// that splits a cluster recurses on it; a still-tied block is a dead tie (renders TBD).
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

// Unresolved slot keeps what the slot IS: "Winner of SF1", "2nd in Pool A".
function slotLabel(side, ctx) {
  if (side && side.kind === 'match') {
    const who = side.result === 'winner' ? 'Winner' : 'Loser';
    const ref = ctx.byId.get(side.match);
    if (!ref) return `${who} of match ${side.match}`; // dangling ref — the id is all there is
    const what = matchLabel(ref, ctx); // QF/SF labels carry their bracket ordinal
    return /\d$/.test(what) ? `${who} of ${what}` : `${who} of the ${what}`;
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

// The matches consuming a match's result edges — the seats a player advancing
// from it could land in. Winner and loser edges both count: a loss drops the
// player into the placement tree.
function koConsumers(ctx, id) {
  const out = [];
  for (const X of ctx.matches) {
    if (!X || X.pool !== undefined || !Array.isArray(X.sides)) continue;
    for (const s of X.sides) {
      if (s && s.kind === 'match' && s.match === id) { out.push(X); break; }
    }
  }
  return out;
}

// Knockout-entry facts per pool, from stored sides only — standings never gate
// the pool view. sigs: the pool's side count (every slot rank must be ≤ it);
// slots: rank -> the match consuming that rank.
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

// Ranks of one pool the player could still hold: every rank while any pool
// match is out, the dead-tie cluster once it is decided. A resolved slot is a
// confirmed seat (handled elsewhere) and an unslotted rank is eliminated —
// neither leaves anything possible here, so both return [].
function playerRanks(ctx, pool, pid, roster) {
  const std = poolStandings(ctx, pool);
  if (!std) {
    const out = [];
    for (let r = 1; r <= roster; r++) out.push(r);
    return out;
  }
  const i = std.findIndex(x => x.ids.has(pid));
  if (i < 0 || !isDeadTie(std, i + 1)) return [];
  const out = [];
  let a = i; while (a > 0 && std[a - 1].tie === std[i].tie) a--;
  let b = i; while (b < std.length - 1 && std[b + 1].tie === std[i].tie) b++;
  for (let r = a + 1; r <= b + 1; r++) out.push(r);
  return out;
}

// '3rd–6th' / '2nd, 7th' — collapsed runs of a sorted rank list, in ordinals.
function rankRange(ranks) {
  const runs = [];
  for (const n of [...ranks].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => a === b ? ordinal(a) : `${ordinal(a)}–${ordinal(b)}`).join(', ');
}

// 'the Semifinals' / 'the final' — a stage's name when a chip references it as
// the gate into a deeper stage; placement labels and Round-of-N keep the article.
const chipRef = label => ({ Final: 'the final', Semifinals: 'the Semifinals', Quarterfinals: 'the Quarterfinals' }[label] || `the ${label}`);

const matchEdge = s => s && s.kind === 'match';
const winnerEdge = s => matchEdge(s) && s.result === 'winner'; // the only edge that feeds the final

// Longest winner-edge chain feeding id — 0 when nothing feeds it; koColumn
// walks the other way, so its memo can't serve this. ponytail: O(N²) worst
// case — fine while brackets are tiny; a reverse-edge index is the upgrade if
// they ever grow.
function chainDepth(ctx, id, memo) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, 0);
  let d = 0;
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (winnerEdge(s) && s.match === id) d = Math.max(d, 1 + chainDepth(ctx, m.id, memo));
    }
  }
  memo.set(id, d);
  return d;
}

// Possible stages: one entry per knockout round a player could still reach —
// the certain bits (label, uniform time/court) and the uncertain one (chip:
// the ranks or outcomes that get in). Two seat modes: a confirmed knockout
// seat follows only the branches the outcome leaves open; a group-stage player
// sees their pool's slots at every rank they could still hold — standings
// never narrow a live draw, and a decided pool keeps only the dead-tie ranks.
// One pool per category (the validator pins a pair to one), so the chips below
// never disambiguate two pools.
function possibleStages(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const koRows = rows.filter(r => r.m.pool === undefined);
  const confIds = new Set(koRows.map(r => r.m.id));
  const poolRow = rows.find(r => r.m.pool !== undefined);
  const pool = poolRow === undefined ? null : poolRow.m.pool;
  const facts = (koRows.length || pool === null) ? null : poolFacts(ctx).get(pool);

  // ---- seats and the reachable bracket -------------------------------------
  // Seats are recorded separately from the reach BFS: one match can seat the
  // player via several pool ranks or edges (a QF drawing two of their pool's
  // ranks), and the seen-guard must not drop the second record.
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
    for (const r of playerRanks(ctx, pool, pid, facts.sigs.size)) {
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

  // ---- group reached matches into stages -----------------------------------
  const stages = new Map();
  for (const id of seen) {
    if (confIds.has(id)) continue;
    const m = ctx.byId.get(id);
    if (!m || !Array.isArray(m.sides)) continue;
    const pl = placementLabel(m, ctx);
    const col = pl === null ? koColumn(m, ctx) : null;
    const label = pl || roundName(col);
    let stage = stages.get(label);
    if (!stage) { stage = { label, col, ranks: new Set(), edges: [], times: [], courts: [], ids: [] }; stages.set(label, stage); }
    stage.ids.push(m);
    for (const rank of poolSeatsOf.get(id) || []) stage.ranks.add(rank);
    for (const e of edgeSeatsOf.get(id) || []) stage.edges.push(e);
    const t = schedTime(m, ctx.tz);
    if (t !== null) stage.times.push(t);
    if (typeof m.venue === 'string') stage.courts.push(m.venue);
  }

  // ---- finalize: uniform bits, chips ---------------------------------------
  const present = [];
  for (const stage of stages.values()) {
    present.push({
      label: stage.label, col: stage.col, ranks: stage.ranks, edges: stage.edges,
      times: stage.times, courts: stage.courts, ids: stage.ids,
      ...uniformBits(stage.ids.length, stage.times, stage.courts),
    });
  }
  const merged = mergeTwinStages(present);
  // The chip is the entry gates in one phrase: the direct slot ranks, then
  // the result edges — "as 1st in Pool A or winner of the Quarterfinals" names both ways
  // in, so a rank-1 bye can't read as "everyone gets here". Only a stage every
  // pool rank has a slot in (no gates at all) shortens to "any rank". A
  // merged stage's edges read once, as the seat: "via the Semifinals".
  const chipOf = stage => {
    const chips = [];
    if (facts && stage.ranks.size) {
      const universe = playerRanks(ctx, pool, pid, facts.sigs.size);
      const direct = [...stage.ranks];
      if (direct.length === universe.length && !stage.edges.length) chips.push(`any rank in Pool ${pool}`);
      else chips.push(`as ${rankRange(direct)} in Pool ${pool}`);
    }
    if (stage.edges.length) {
      const parts = new Set();
      for (const e of stage.edges) {
        const parent = ctx.byId.get(e.parent);
        if (!parent || !Array.isArray(parent.sides)) continue;
        const pl = placementLabel(parent, ctx);
        const label = pl || roundName(koColumn(parent, ctx));
        parts.add(stage.merged ? `via ${chipRef(label)}` : `as ${e.kind} of ${chipRef(label)}`);
      }
      for (const p of [...parts].sort()) chips.push(p);
    }
    return chips.join(' or ');
  };
  const out = [];
  for (const stage of present) {
    if (merged.has(stage)) continue; // the pair's originals — the merged entry carries them
    out.push({ label: stage.label, col: stage.col, time: stage.time, court: stage.court, chip: chipOf(stage) });
  }
  // Deepest-first (QF -> SF -> Final); a merged pair keeps its deeper column.
  out.sort((a, b) => (b.col ?? -1) - (a.col ?? -1));
  return out;
}

// A stage's time/court reads uniform only when every card agrees — a mixed
// time or court renders TBD, like any stage whose cards disagree.
const uniformBits = (n, times, courts) => ({
  time: n > 0 && times.length === n && times.every(t => t === times[0]) ? times[0] : null,
  court: n > 0 && courts.length === n && courts.every(c => c === courts[0]) ? courts[0] : null,
});

// Mutually exclusive outcomes of one seat read as one stage: the winner- and
// loser-fed entries of the same feeder matches merge ("Final / 3rd place —
// reached via the Semifinals"). Rank-fed stages and ambiguous gates stay separate —
// two deciders fed by different semis are not one player's alternatives.
function mergeTwinStages(present) {
  const merged = new Set();
  const byGate = new Map();
  for (const stage of present) {
    const parentSig = [...new Set(stage.edges.map(e => e.parent))].sort().join('|');
    if (!parentSig) continue;
    const kind = stage.edges.every(e => e.kind === 'winner') ? 'w' : stage.edges.every(e => e.kind === 'loser') ? 'l' : null;
    if (!kind) continue;
    const key = `${parentSig}|${kind}`;
    if (!byGate.has(key)) byGate.set(key, []);
    byGate.get(key).push(stage);
  }
  const twin = key => byGate.get(key.endsWith('|w') ? key.replace(/\|w$/, '|l') : key.replace(/\|l$/, '|w'));
  for (const [key, list] of byGate) {
    if (key.endsWith('|l') || list.length !== 1) continue;
    const other = twin(key);
    if (!other || other.length !== 1 || merged.has(list[0]) || merged.has(other[0])) continue;
    const [x, y] = [list[0], other[0]];
    const isPlace = l => / (place|semi)$/.test(l);
    const placeL = [x, y].filter(s => isPlace(s.label)).map(s => s.label);
    const roundL = [x, y].filter(s => !isPlace(s.label)).map(s => s.label);
    // "5th / 7th place" joins a decider pair's labels; a round with its
    // placement companion names the band like the bracket headings do.
    const label = roundL.length ? stageGroupName(roundL[0], placeL)
      : placeL.map(l => l.replace(/ place$/, '')).join(' / ') + ' place';
    merged.add(x); merged.add(y);
    const times = [...x.times, ...y.times];
    const courts = [...x.courts, ...y.courts];
    present.push({
      label, col: Math.max(x.col ?? -1, y.col ?? -1), merged: true,
      ranks: new Set([...x.ranks, ...y.ranks]), edges: [...x.edges, ...y.edges],
      times, courts, ids: [...x.ids, ...y.ids],
      ...uniformBits(x.ids.length + y.ids.length, times, courts),
    });
  }
  return merged;
}


const ordRules = new Intl.PluralRules(LOCALE, { type: 'ordinal' });
const ordinal = n => n + ({ one: 'st', two: 'nd', few: 'rd' }[ordRules.select(n)] || 'th');

// Placement label (3rd/5th/7th place, classification semis), null for main-
// bracket matches.
function placementLabel(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.pl) memo.pl = plBuild(ctx);
  const r = memo.pl.get(m.id);
  if (!r) return null;
  return r.win ? `${ordinal(r.lo)} place` : `${ordinal(r.lo)}–${ordinal(r.hi)} semi`;
}

// Possible-rank range of every classification match, exact for bye-thinned
// pools. One rule: a slot reaches the range of whichever match consumes that
// edge (winner edges climb the better ranks, loser edges the worse); an edge
// nothing consumes holds a fixed rank, stepped out from the pool's champion
// in bracket order. So the middle loser of a 5-loser pool reaches [A, A+2],
// not the pool's bottom, because its chain stops there — no nominal round
// ranges, no caps, no odd-size arithmetic.
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
    if (memMemo.has(m.id)) return memMemo.get(m.id);
    memMemo.set(m.id, false);
    let yes = false;
    for (const s of m.sides) {
      if (!s || s.kind !== 'match') continue;
      if (s.result === 'loser') { yes = true; break; }
      const X = byId.get(s.match);
      if (X && member(X)) { yes = true; break; }
    }
    memMemo.set(m.id, yes);
    return yes;
  };
  // Pool champion: a match nothing winner-consumes whose all-winner chain
  // bottoms out at a main-round loser edge. The first loser edge on that chain
  // must be the anchor — a sub-bracket final's chain passes through another
  // classification match first, so only the pool's champion qualifies, and the
  // walk returns the anchor round's winner depth d.
  const champAnchor = (m, seen) => {
    if (seen.has(m.id) || !Array.isArray(m.sides)) return null;
    seen.add(m.id);
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || s.result !== 'loser') continue;
      const X = byId.get(s.match);
      if (X && !member(X)) return wdOf(ctx, X.id); // the anchor: a main-round loser edge
      return null; // a sub-bracket final's chain passes through the classification — not the champion
    }
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || s.result !== 'winner') continue;
      const r = champAnchor(byId.get(s.match), seen);
      if (r !== null) return r;
    }
    return null;
  };
  const pools = []; // [champion, anchor depth]
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides) || winnerParent.has(m.id)) continue;
    if (!m.sides.some(s => s && s.kind === 'match')) continue;
    const d = champAnchor(m, new Set());
    if (d !== null) pools.push([m, d]);
  }
  for (const [champ, d] of pools) {
    const A = 2 ** d + 1; // the pool's best rank
    let next = A + 2;
    // Reachability from the champion over classification matches only — main-
    // bracket neighbors (pools, semifinals) fail member() and stay out. Winner-
    // edge links before loser- links so tied terminals rank in winner order.
    const seen = new Set([champ.id]);
    const queue = [champ];
    const candsOf = (N) => (adj.get(N.id) || [])
      .filter(x => !seen.has(x) && member(byId.get(x)))
      .sort((a, b) => (winnerParent.get(N.id) === byId.get(b)) - (winnerParent.get(N.id) === byId.get(a)));
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
      const out = wv && lv
        ? { lo: Math.min(wv.lo, lv.lo), hi: Math.max(wv.hi, lv.hi), win: !winnerParent.has(id) }
        : null;
      pl.set(id, out);
      return out;
    };
    for (const m of queue) resolve(m.id);
  }
  return pl;
}

// Range of a classification match, null for main-bracket matches. The bronze
// finder (winners) reads lo here — same structure the labels use.
function plRange(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.pl) memo.pl = plBuild(ctx);
  return memo.pl.get(m.id);
}

// Depth band of every classification match: the column one below its anchor's,
// minus further loser-chain edges — a 5th/7th decider (fed by the 5th–8th
// semis) sits one band deeper than its feeder, next to the final. Pairing by
// edge count in and one pass records each band's distinct placement labels for
// the merged headings. Byes can't skew it: the anchor is the main match whose
// loser edge starts the chain, so a bye'd semi still anchors its column.
function plBands(ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.plBand) {
    const col = new Map();    // placement match id -> band column
    const labels = new Map(); // band column -> placement labels
    const bandOf = (m) => {
      const got = col.get(m.id);
      if (got !== undefined) return got;
      col.set(m.id, null);
      let cur = m;
      let hops = 0; // placement-tree edges between the anchor's loser slot and m
      const seen = new Set();
      for (;;) {
        seen.add(cur.id);
        const feed = (cur.sides || []).find(s => s && s.kind === 'match' && ctx.byId.has(s.match));
        if (!feed) { cur = null; break; }
        cur = ctx.byId.get(feed.match);
        if (seen.has(cur.id)) { cur = null; break; }
        if (placementLabel(cur, ctx) === null) break; // the anchor: a main match
        hops++;
      }
      const c = cur === null ? null : Math.max(0, koColumn(cur, ctx) - 1 - hops);
      col.set(m.id, c);
      if (c !== null) {
        if (!labels.has(c)) labels.set(c, new Set());
        labels.get(c).add(placementLabel(m, ctx));
      }
      return c;
    };
    for (const m of ctx.matches) {
      if (!m || m.pool !== undefined || placementLabel(m, ctx) === null) continue;
      bandOf(m);
    }
    memo.plBand = { col, labels };
  }
  return memo.plBand;
}

// The band column a classification match renders in; a main match never
// appears in the band map, so `?? null` covers it.
function placementColumn(m, ctx) {
  return plBands(ctx).col.get(m && m.id) ?? null;
}

// Distinct placement labels of one band — the headings' companion. Order is
// free: stageGroupName dedupes by content.
function bandLabels(ctx, col) {
  return [...(plBands(ctx).labels.get(col) || [])];
}

// "5th–8th semi" -> "5th–8th": the band a placement label names.
const bandShort = l => l.replace(/ semi$/, '');

// Merged heading of a band: the round name plus its placement companions. One
// distinct label names it exactly ("Final / 3rd place", "Semifinals / 5th–8th");
// several fall back to the generic "Final / Placement". A band with no
// placement companion keeps the plain round name.
function stageGroupName(round, labels) {
  const uniq = [...new Set(labels.map(bandShort))];
  return uniq.length === 1 ? `${round} / ${uniq[0]}` : uniq.length > 1 ? `${round} / Placement` : round;
}

// The placement wave: the deepest band with a playable card (both feeders
// decided) — nextKoWave's counterpart for the classification tree. An undecided
// semi never drags the wave to a bronze that can't fill yet.
function placeWave(ctx) {
  let best = null;
  for (const X of ctx.matches) {
    if (!X || X.pool !== undefined || isDone(X) || placementLabel(X, ctx) === null) continue;
    if (!Array.isArray(X.sides) || X.sides.length !== 2) continue;
    if (!resolveSide(X.sides[0], ctx) || !resolveSide(X.sides[1], ctx)) continue;
    const c = placementColumn(X, ctx);
    if (c !== null) best = best === null ? c : Math.min(best, c);
  }
  return best;
}

// Winner-edge distance to the final (0 = the final itself): the round a loser
// edge branches from. Its own memo, not koColumn's — this is read while
// koColumn's build is mid-flight.
function wdOf(ctx, id) {
  const memo = ctxMemo(ctx);
  if (!memo.wd) {
    const wdMap = memo.wd = new Map();
    for (const m of ctx.matches) chainDepth(ctx, m.id, wdMap);
  }
  return memo.wd.get(id);
}

// "+02:00"-style offset for a date, noon-UTC anchor. This parses the
// GMT±HH:MM rendering, so the locale stays pinned even if LOCALE ever changes.
// ponytail: wall times before a same-day clock change (a DST-shift morning) get
// the post-transition offset, off by one hour — exact per-minute offsets only
// if a tournament ever opens on a changeover day.
function tzOffset(tz, date) {
  // Intl throws on a bad timezone — a guarded null keeps a malformed file from
  // crashing a render.
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(date + 'T12:00:00Z'));
  } catch {
    return null;
  }
  const p = parts.find((x) => x.type === 'timeZoneName');
  return p && p.value !== 'GMT' ? p.value.replace('GMT', '') : '+00:00';
}

// Midnight is 00, never 24: hourCycle pins the day to 0-23 under any dialect.
function fmtTime(t, tz) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  } catch { return ''; }
}

// Y-M-D from typed parts, calendar pinned to gregory — a non-Gregorian default
// locale (Buddhist, Hijri) would otherwise key days by a foreign year.
function dayKey(t, tz) {
  let p = null;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, { timeZone: tz, calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  } catch { return null; } // bad tz: no day key — callers' null paths render empty
  return `${p.year}-${p.month}-${p.day}`;
}

// Anchor local wall time to an instant — the single derivation point.
function schedTime(m, tz) {
  const s = (m && m.scheduled) || '';
  if (!ISO_RE.test(s)) return null;
  const off = tzOffset(tz, s.slice(0, 10));
  if (off === null) return null;
  const t = Date.parse(s + off);
  return Number.isNaN(t) ? null : t;
}

const dayShort = (t, tz) => {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(t);
  } catch { return ''; }
};

// A calendar-day label needs no timezone — the weekday/month/day of a Y-M-D key are absolute.
const dayLabel = k => new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(k + 'T00:00:00Z'));

// Distinct scheduled days as sorted ISO date keys — the index's stored form.
function schedDays(ms, tz) {
  const ks = new Set();
  for (const m of ms) {
    const t = schedTime(m, tz);
    if (t !== null) ks.add(dayKey(t, tz));
  }
  return [...ks].sort();
}

// Human span from ISO day keys (null = nothing scheduled).
// en-US month abbreviations for the spread span — pinned to LOCALE like
// dayLabel, but keyed off the ISO digits, never the formatted label's position.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtRange(keys) {
  const ks = (Array.isArray(keys) ? keys : []).filter(k => DATE_RE.test(k));
  if (!ks.length) return null;
  if (ks.length === 1) return dayLabel(ks[0]);
  // epoch day from UTC midnight — exact; tz-local midnight math drifts across DST
  const n = k => Date.parse(k + 'T00:00:00Z') / 864e5;
  const consec = ks.slice(1).every((k, i) => n(k) - n(ks[i]) === 1);
  let out;
  if (!consec) out = ks.map(dayLabel).join(', ');
  else {
    const [, m0, d0] = ks[0].split('-');
    const [, m1, d1] = ks.at(-1).split('-');
    const wd = x => x.slice(0, 3); // the weekday is dayLabel's leading token in this dialect
    out = `${wd(dayLabel(ks[0]))}–${wd(dayLabel(ks.at(-1)))}, ` + (m0 === m1
      ? `${MONTHS[+m0 - 1]} ${+d0}–${+d1}` // same month, month repeated once: "Sat–Sun, Jul 11–12"
      : `${MONTHS[+m0 - 1]} ${+d0} – ${MONTHS[+m1 - 1]} ${+d1}`); // month boundary keeps both: "Wed–Sat, Dec 30 – Jan 2"
  }
  return ks[0].slice(0, 4) !== ks.at(-1).slice(0, 4) ? `${out}, ${ks.at(-1).slice(0, 4)}` : out;
}

function fmtDiff(n) {
  return (n > 0 ? '+' : '') + n;
}

function kioskStatus(r, now) {
  const t = r.t;
  if (isDone(r.m)) return 'done';
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'due';
  return 'upcoming';
}

// The kiosk's scroll anchor: the latest row start that has passed — the slot
// "now" — else the first row. Pure time, never status, so a slot that finished
// early stays centered until the next start. `times` must be ascending.
function currentRowIndex(times, now) {
  let i = times.length;
  while (i > 0 && times[i - 1] > now) i--;
  return i > 0 ? i - 1 : 0;
}

// Round names by distance from the final (2 -> Final, 4 -> Semifinals, ...);
// keyed off koColumn, so a bye'd semi still reads as a semifinal.
function roundName(depthFromEnd) {
  const n = 2 << depthFromEnd;
  return { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals' }[n] || `Round of ${n}`;
}

// Column: 0 is the final, one back per winner edge. Depth-from-leaves can't
// place a bye'd semi. Main-tree columns read ctx._memo.wd (built before this,
// so no interleaved in-progress values); the fallback sizes classification
// rounds and the final anchors 0. The championship final, shared with
// koOrdinal: a knockout match no winner feeds, outside the classification tree.
const mainFinal = (ctx, parented) =>
  ctx.matches.find(X => X.pool === undefined && !parented.has(X.id) && placementLabel(X, ctx) === null);

// Bracket parent-adjacency in one scan: winnerParent (fed id -> parent match),
// kids (parent id -> feeder ids in side order), loserFed (loser-edge fed ids),
// loserParent (fed id -> the match consuming its loser edge — plBuild's ranges).
// Every bracket consumer (koColumn, koOrdinal, winners, mainFinal, plBuild)
// reads this one map — one edge classification, no drift.
function parentsOf(ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.parents) {
    const winnerParent = new Map();
    const kids = new Map();
    const loserFed = new Set();
    const loserParent = new Map();
    for (const X of ctx.matches) {
      if (!Array.isArray(X.sides)) continue; // malformed: report, never throw
      for (const s of X.sides) {
        if (!matchEdge(s)) continue;
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
    memo.parents = { winnerParent, kids, loserFed, loserParent };
  }
  return memo.parents;
}

function koColumn(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.koCol) {
    const koColMap = memo.koCol = new Map();
    const { winnerParent } = parentsOf(ctx);
    const final = mainFinal(ctx, winnerParent);
    const col = (X) => {
      const got = koColMap.get(X.id);
      if (got !== undefined) return got;
      koColMap.set(X.id, -1);
      const p = winnerParent.get(X.id);
      let r;
      if (p && placementLabel(p, ctx) === null) r = wdOf(ctx, X.id);
      else if (X === final) r = 0;
      else {
        const feeders = Array.isArray(X.sides) ? X.sides.filter(s => s && s.kind === 'match' && ctx.byId.has(s.match)).map(s => col(ctx.byId.get(s.match))) : [];
        r = feeders.length ? Math.max(...feeders) - 1 : 0;
      }
      koColMap.set(X.id, r);
      return r;
    };
    for (const X of ctx.matches) col(X);
  }
  return memo.koCol.get(m.id);
}

// Ordinal within round from who each winner feeds — Final 1, its feeders 1–2
// by side, and so on down. Reads bracket structure, never `scheduled`, so
// editing times can't renumber anything; only rewiring the bracket does (and
// then the label should change). 0 = off the championship tree (classification
// rounds — placementLabel names those).
function koOrdinal(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.koOrd) {
    const { kids, winnerParent } = parentsOf(ctx);
    const ord = memo.koOrd = new Map();
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
  }
  return memo.koOrd.get(m.id) || 0;
}

function matchLabel(m, ctx) {
  if (m.pool !== undefined) return `Pool ${m.pool}`;
  const pl = placementLabel(m, ctx);
  if (pl) return pl;
  const full = roundName(koColumn(m, ctx));
  const abbr = full.replace('Semifinals', 'SF').replace('Quarterfinals', 'QF');
  // QF/SF carry their bracket ordinal so slot references name a visible card.
  // ponytail: only QF/SF get numbered — deeper rounds number when one needs cross-refs there
  return abbr === full ? full : abbr + (koOrdinal(m, ctx) || '');
}

// ---- Status derivation: what a category or player's line says ----------------

// The wave in play: the lowest column whose undone matches are playable — a
// scheduled final doesn't claim the status while its semifinals still decide
// it. Falls back to all undone matches on malformed sides.
function nextKoWave(ctx) {
  // Championship-only: a placement (classification) match resolves as a consequence
  // of the bracket above it, so it is never "the wave in play" — excluding it
  // keeps the round label and the kiosk's jump link on the real championship round.
  const undone = ctx.matches.filter(m => m.pool === undefined && !m.result && placementLabel(m, ctx) === null);
  if (!undone.length) return null;
  const playable = undone.filter(m => !Array.isArray(m.sides) || m.sides.every(s => resolveSide(s, ctx)));
  // ponytail: an unsettled dead tie blocks every wave — this falls back to the
  // lowest column ("Final"), which reads wrong; the tie row is already flagged
  // and the organizer settles it, so the mislabel is brief. Gate the fallback on
  // pool resolution if a format ever needs the status accurate through ties.
  return Math.min(...(playable.length ? playable : undone).map(m => koColumn(m, ctx)));
}

// The podium from played results: first/second off the championship final,
// third off the bronze match (the semifinal losers' match), fourth off its
// loser. Null when nothing is decided — a void final or an unresolved side
// leaves no winner to name, and a category without a final has no podium.
// The final and bronze are found structurally, never by rendered label — a
// vocabulary change to "Final"/"3rd place" must not kill the podium.
function winners(ctx) {
  const { winnerParent, loserFed } = parentsOf(ctx);
  const m = mainFinal(ctx, winnerParent); // the one knockout match nothing winner-feeds
  if (!m || !m.result || winnerIdx(m) === null || !Array.isArray(m.sides)) return null;
  const a = resolveSide(m.sides[0], ctx), b = resolveSide(m.sides[1], ctx);
  if (!a || !b) return null;
  const w = winnerIdx(m);
  const out = { first: [...a], second: [...b], third: null, fourth: null };
  if (w === 1) { out.first = [...b]; out.second = [...a]; }
  // the bronze is the terminal match whose possible range starts at 3rd place —
  // loserFed keeps a mid-bracket '3rd–4th semi' (range lo 3, loser edge to a
  // decider) from being read as the decider itself
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

// Category status line: the facts a renderer turns into the subline.
// kind: starts (nothing played) | groups | ko | finished | winners.
function catStatus(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return null;
  if (ms.every(isDone)) {
    const w = winners(ctx);
    return w ? { kind: 'winners', ...w } : { kind: 'finished' };
  }
  if (!ms.some(isDone)) {
    const ts = ms.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
    return { kind: 'starts', time: ts.length ? Math.min(...ts) : null };
  }
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) return { kind: 'groups', played: grp.filter(isDone).length, count: grp.length };
  const col = nextKoWave(ctx);
  // place: the classification wave — the main wave may be spent while a bronze
  // or decider still reads ready; the subline links whichever is deeper.
  return { kind: 'ko', col, place: placeWave(ctx) };
}

const inWord = col => col === 0 ? 'In the final' : `In ${roundName(col)}`;
const elimWord = col => col === 0 ? 'Eliminated in the final' : `Eliminated in ${roundName(col)}`;

// A player's standing in one category, as a plain word — the schedule page
// never links it; the tournament page's wave links are category-level, not
// per-player.
function playerStatus(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  if (!rows.length) return null;
  const undone = rows.filter(r => !isDone(r.m));
  if (undone.length) {
    const koRows = undone.filter(r => r.m.pool === undefined && placementLabel(r.m, ctx) === null);
    if (!koRows.length) {
      // only placement matches left to play (e.g. a bronze not yet scored) — not a championship round
      return undone.some(r => r.m.pool === undefined) ? 'In placement' : 'In groups';
    }
    return inWord(Math.max(...koRows.map(r => koColumn(r.m, ctx))));
  }
  if (ctx.matches.every(isDone)) {
    const w = winners(ctx);
    if (w) {
      if (w.first.includes(pid)) return 'Champion';
      if (w.second.includes(pid)) return 'Runner-up';
      if (w.third && w.third.includes(pid)) return '3rd';
      if (w.fourth && w.fourth.includes(pid)) return '4th';
    }
  }
  const lost = rows.filter(r => { const w = winnerIdx(r.m); return w !== null && w !== r.i; }); // void settles, counts nothing
  const koLost = lost.filter(r => r.m.pool === undefined && placementLabel(r.m, ctx) === null);
  if (koLost.length) return elimWord(Math.max(...koLost.map(r => koColumn(r.m, ctx))));
  const poolsDone = ctx.matches.filter(m => m.pool !== undefined).every(isDone);
  return poolsDone ? 'Out in groups' : 'In groups';
}

if (typeof module !== 'undefined') {
  module.exports = { LOCALE, DATE_RE, ID_RE, ISO_RE, pairSig, makeCat, toCats, matchSlotMs, bestOfOf, countWins, sideIdx, sideLetter, winnerIdx, isDone, isDeadTie, poolStandings, poolRanks, poolDecided, resolveSide, slotLabel, teamLabel, sideLabel, playerMatches, possibleStages, placementLabel, plRange, placementColumn, bandLabels, stageGroupName, fmtTime, dayKey, tzOffset, schedTime, schedDays, fmtRange, dayShort, dayLabel, fmtDiff, kioskStatus, currentRowIndex, roundName, koColumn, koOrdinal, matchLabel, winners, catStatus, playerStatus };
}
