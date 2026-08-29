'use strict';

var ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/; // var, not const: app.js reads it off globalThis in the browser (script-scope consts are not globalThis properties)
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The one display dialect: every human-visible string renders in it, so the
// kiosk and the tests never vary with the viewer's locale. Machine-read
// tokens don't follow it — dayKey assembles ISO from typed parts, tzOffset
// parses the offset name and stays pinned (see its comment).
const LOCALE = 'en-US';

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

// Category contexts (makeCat ready). A category without a matches array renders empty.
function toCats(tjson) {
  const byCat = (tjson && tjson.matches && typeof tjson.matches === 'object') ? tjson.matches : {};
  const cats = (tjson && Array.isArray(tjson.categories)) ? tjson.categories : [];
  return cats.map(c => makeCat({ meta: c, matches: Array.isArray(byCat[c.id]) ? byCat[c.id] : [] }, tjson));
}

const stageOf = m => (m && m.pool !== undefined) ? 'groups' : 'knockout';

function matchSlotMs(m, ctx) {
  const cfg = (ctx && ctx.slotMinutes) || {};
  return ((m && m.slotMinutes) ?? cfg[stageOf(m)]) * 60 * 1000;
}


// Raw game wins per side, target not applied — the played-consistency base.
// Malformed entries are skipped: the gate calls this while reporting them.
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
    if (!g || typeof g !== 'object') continue; // as countWins: report, never throw
    gd += g.a > g.b ? 1 : -1;
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
  const rec = s => {
    if (!(s && s.kind === 'players' && Array.isArray(s.ids))) return null;
    const sig = pairSig(s.ids);
    let r = recs.get(sig);
    if (!r) { r = { sig, ids: new Set(s.ids), wins: 0, losses: 0, gd: 0, pd: 0 }; recs.set(sig, r); }
    return r;
  };
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue; // malformed match: the validator reports it, never a crash
    // rec() creates both side records on first sight (creation order kept), so
    // a single pass builds the roster and the ladder at once.
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
    if (!Array.isArray(m.sides)) continue; // as poolStandings: report, never throw
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const a = pairSig(s0.ids), b = pairSig(s1.ids);
    if (!h.has(a) || !h.has(b)) continue;
    const w = winnerIdx(m);
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
  if (side.kind === 'players') return Array.isArray(side.ids) ? new Set(side.ids) : null; // a string ids would char-split in Set — malformed sides TBD, never a wrong team
  if (side.kind === 'match') {
    const m = ctx.byId.get(side.match);
    if (!m || !Array.isArray(m.sides)) return null; // no sides: malformed -> TBD, never a throw
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
    const st = poolStandings(ctx, side.pool);
    if (!st) return null;
    const rec = st[side.rank - 1];
    if (!rec || isDeadTie(st, side.rank)) return null; // dead tie -> TBD
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

// Open knockout seats from confirmed matches through undecided slots; a decided
// feeder only forwards the branch the player got (confirmed ones render as cards).
// possibleSpan passes its playerMatches rows as starts — same filter, one scan.
function reachableKo(ctx, pid, starts) {
  if (!starts) starts = playerMatches(ctx, pid).filter(r => r.m.pool === undefined);
  const sideOf = new Map(starts.map(r => [r.m.id, r.i]));
  const open = new Set();
  const seen = new Set(sideOf.keys());
  const queue = [...sideOf.keys()];
  while (queue.length) {
    const id = queue.shift();
    const w = winnerIdx(ctx.byId.get(id)); // null until the feeder is decided
    for (const m of ctx.matches) {
      if (m.pool !== undefined || !Array.isArray(m.sides) || seen.has(m.id)) continue;
      for (const s of m.sides) {
        if (!s || s.kind !== 'match' || s.match !== id) continue;
        const pSide = sideOf.get(id); // only starts can be decided — a result forces its feeder chain decided (the validator's resolveSide rule), so candidates stay undecided
        if (w !== null && pSide !== undefined && (s.result === 'winner') !== (pSide === w)) continue;
        seen.add(m.id);
        open.add(m.id);
        queue.push(m.id);
      }
    }
  }
  return open;
}

const matchEdge = s => s && s.kind === 'match';
const winnerEdge = s => matchEdge(s) && s.result === 'winner'; // the only edge that feeds the final

// Longest knockout chain feeding id — 0 when nothing feeds it. The edge filter
// picks the measure: all match-kind edges (possibleSpan, +1 for the slot
// itself: the max a team can still play from there) or winner edges only
// (wdOf: round distance from the final — matchRound can't do it, it walks the
// other way). Shared memo across ids — sibling paths share it, not just one
// chain. ponytail: O(N²) worst case — fine while brackets are tiny; a
// reverse-edge index is the upgrade if they ever grow.
function chainDepth(ctx, id, edge, memo) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, 0); // in-progress = cycle guard; the validator rejects cycles first
  let d = 0;
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue; // malformed: the gate reports it, never a throw
    for (const s of m.sides) {
      if (edge(s) && s.match === id) d = Math.max(d, 1 + chainDepth(ctx, m.id, edge, memo));
    }
  }
  memo.set(id, d);
  return d;
}

// Day-span of this player's open knockout slots (null when none); count = the
// longest single path. ponytail: fallback assumes everyone advances; gate it on
// pool completion if a format with a knockout cutoff ever appears.
function possibleSpan(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const ko = rows.filter(r => r.m.pool === undefined);
  let open = [...reachableKo(ctx, pid, ko)];
  if (!open.length && rows.some(r => r.m.pool !== undefined) && !ko.length) {
    open = ctx.matches.filter(m => m.pool === undefined).map(m => m.id);
  }
  const memo = new Map(); // one memo across open ids — sibling paths share it, not just one chain
  const ts = open.map(id => schedTime(ctx.byId.get(id), ctx.tz)).filter(t => t !== null);
  if (!ts.length) return null;
  return { min: Math.min(...ts), max: Math.max(...ts), count: Math.max(...open.map(id => 1 + chainDepth(ctx, id, matchEdge, memo))) };
}

const ordRules = new Intl.PluralRules(LOCALE, { type: 'ordinal' });
const ordinal = n => n + ({ one: 'st', two: 'nd', few: 'rd' }[ordRules.select(n)] || 'th');

// Placement label (3rd/5th/7th place, classification semis), null for main-
// bracket matches. Memo rides ctx._pl — rebuilt each render, so a polled page
// picks up new results.
function placementLabel(m, ctx) {
  if (!ctx._pl) ctx._pl = plBuild(ctx);
  const r = ctx._pl.get(m.id);
  if (!r) return null;
  return r.win ? `${ordinal(r.lo)} place` : `${ordinal(r.lo)}–${ordinal(r.hi)} semi`;
}

// Possible-rank range of every classification match, exact for bye-thinned
// pools. One rule: a slot reaches the range of whichever match consumes that
// edge (winner edges climb the better ranks, loser edges the worse); an edge
// nothing consumes holds a fixed rank, stepped out from the pool's champion
// in bracket order. So the middle loser of a 5-loser pool reaches [A, A+2],
// not the pool's bottom, because its chain stops there — no nominal round
// ranges, no caps, no odd-size arithmetic. Built once per category; memo
// ctx._pl, discarded each render like _wd/_koCol (toCats makes fresh contexts).
function plBuild(ctx) {
  const pl = new Map(); // id -> { lo, hi, win } (win: winner edge unconsumed)
  const byId = ctx.byId;
  const winParent = new Map(), losParent = new Map(); // id -> the match consuming its winner/loser edge
  const adj = new Map(); // undirected match-edge links for the reachability walk
  const addLink = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || !byId.has(s.match)) continue;
      (s.result === 'winner' ? winParent : losParent).set(s.match, m);
      addLink(m.id, s.match);
      addLink(s.match, m.id);
    }
  }
  // Classification match: a loser edge as a slot (main-bracket matches carry
  // only winner and player sides), or a slot from a classified match.
  const memMemo = new Map();
  const member = (m) => {
    if (memMemo.has(m.id)) return memMemo.get(m.id);
    memMemo.set(m.id, false); // in-progress = cycle guard; the gate rejects cycles first
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
    if (!Array.isArray(m.sides) || winParent.has(m.id)) continue;
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
      .sort((a, b) => winnerLink(byId.get(b), N) - winnerLink(byId.get(a), N));
    const spec = new Map(); // id -> [winner edge, loser edge]: a rank, or the consuming match's id
    for (let qi = 0; qi < queue.length; qi++) {
      const N = queue[qi];
      const pw = winParent.get(N.id), lp = losParent.get(N.id);
      const w = pw ? ['r', pw.id] : N === champ ? ['n', A] : ['n', next++];
      const l = lp ? ['r', lp.id] : N === champ ? ['n', A + 1] : ['n', next++];
      spec.set(N.id, [w, l]);
      for (const x of candsOf(N)) { seen.add(x); queue.push(byId.get(x)); }
    }
    // Ranges resolve on demand: a slot takes the range of the match consuming
    // that edge. Consumers sit on both sides of the discovery order (the
    // champion is early, deeper loser-bracket finals late), so no single pass
    // covers it — the memo just fills whatever order the refs demand.
    const resolve = (id) => {
      if (pl.has(id)) return pl.get(id);
      pl.set(id, null); // in-progress: cycle guard (malformed data — the gate reports it)
      const [w, l] = spec.get(id) || [];
      const val = (x) => x && (x[0] === 'n' ? { lo: x[1], hi: x[1] } : resolve(x[1])) || null;
      const wv = val(w), lv = val(l);
      const out = wv && lv
        ? { lo: Math.min(wv.lo, lv.lo), hi: Math.max(wv.hi, lv.hi), win: !winParent.has(id) }
        : null;
      pl.set(id, out);
      return out;
    };
    for (const m of queue) resolve(m.id);
  }
  return pl;
}

// Winner-edge links first: when a node's consumers tie on the same layer, the
// one whose slot comes from the winner edge ranks higher.
function winnerLink(m, N) {
  if (!Array.isArray(m.sides)) return 0;
  return m.sides.some(s => s && s.kind === 'match' && s.match === N.id && s.result === 'winner') ? 1 : 0;
}

// Range of a classification match, null for main-bracket matches. The bronze
// finder (winners) reads lo here — same structure the labels use.
function plRange(m, ctx) {
  if (!ctx._pl) ctx._pl = plBuild(ctx);
  return ctx._pl.get(m.id);
}

// Winner-edge distance to the final (0 = the final itself): the round a loser
// edge branches from. koColumn's memo can't serve it either: this is read while
// koColumn's build is mid-flight, so it gets its own category memo, fully
// built before any consumer reads it (in-progress values never escape). Same
// discard-per-render contract as _koCol/_pl: toCats rebuilds contexts
// every render.
function wdOf(ctx, id) {
  if (!ctx._wd) {
    const memo = ctx._wd = new Map();
    for (const m of ctx.matches) chainDepth(ctx, m.id, winnerEdge, memo);
  }
  return ctx._wd.get(id);
}

// "+02:00"-style offset for a date, noon-UTC anchor. This parses the
// GMT±HH:MM rendering, so the locale stays pinned even if LOCALE ever changes.
// ponytail: wall times before a same-day clock change (a DST-shift morning) get
// the post-transition offset, off by one hour — exact per-minute offsets only
// if a tournament ever opens on a changeover day.
function tzOffset(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(date + 'T12:00:00Z')).find((x) => x.type === 'timeZoneName');
  return p && p.value !== 'GMT' ? p.value.replace('GMT', '') : '+00:00';
}

// Midnight is 00, never 24: hourCycle pins the day to 0-23 under any dialect.
function fmtTime(t, tz) {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
}

// Y-M-D assembled from typed parts: the ISO shape is stated here, not borrowed
// from a locale whose canonical form happens to match (en-CA's).
function dayKey(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat(undefined, { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Anchor local wall time to an instant — the single derivation point.
function schedTime(m, tz) {
  const s = (m && m.scheduled) || '';
  if (!ISO_RE.test(s)) return null;
  const t = Date.parse(s + tzOffset(tz, s.slice(0, 10)));
  return Number.isNaN(t) ? null : t;
}

const dayShort = (t, tz) => new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(t);

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
    const a = dayLabel(ks[0]), b = dayLabel(ks.at(-1));
    const wd = x => x.slice(0, 3); // dayLabel "Sat, Jul 11" -> "Sat"
    out = `${wd(a)}–${wd(b)}, ` + (a.slice(5, 8) === b.slice(5, 8)
      ? `${a.slice(5)}–${b.slice(9)}` // same month, month repeated once: "Sat–Sun, Jul 11–12"
      : `${a.slice(5)} – ${b.slice(5)}`); // month boundary keeps both: "Wed–Sat, Dec 30 – Jan 2"
  }
  return ks[0].slice(0, 4) !== ks.at(-1).slice(0, 4) ? `${out}, ${ks.at(-1).slice(0, 4)}` : out;
}

// The tournament page's span, derived from the schedule.
function dateRange(ms, tz) {
  return fmtRange(schedDays(ms, tz));
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
// place a bye'd semi. Main-tree columns read ctx._wd (built before this, so no
// interleaved in-progress values); the fallback sizes classification rounds
// and the final anchors 0. Memo rides ctx._koCol — safe because toCats
// discards the context (memo included) every render, so each poll starts a
// fresh bracket. The championship final, shared with koOrdinal: a knockout
// match no winner feeds, outside the classification tree.
const mainFinal = (ctx, parented) =>
  ctx.matches.find(X => X.pool === undefined && !parented.has(X.id) && placementLabel(X, ctx) === null);

// Bracket parent-adjacency in one scan: winnerParent (fed id -> parent match),
// kids (parent id -> feeder ids in side order), loserFed (loser-edge fed ids).
// Every bracket consumer (koColumn, koOrdinal, winners, mainFinal) reads this
// one map — one edge classification, no drift. Memo rides ctx._parents: same
// discard-per-render contract as _koCol/_pl (toCats rebuilds contexts).
function parentsOf(ctx) {
  if (!ctx._parents) {
    const winnerParent = new Map();
    const kids = new Map();
    const loserFed = new Set();
    for (const X of ctx.matches) {
      if (!Array.isArray(X.sides)) continue; // malformed: report, never throw
      for (const s of X.sides) {
        if (!matchEdge(s)) continue;
        if (s.result === 'winner') {
          winnerParent.set(s.match, X);
          if (!kids.has(X.id)) kids.set(X.id, []);
          kids.get(X.id).push(s.match);
        } else loserFed.add(s.match);
      }
    }
    ctx._parents = { winnerParent, kids, loserFed };
  }
  return ctx._parents;
}

function koColumn(m, ctx) {
  if (!ctx._koCol) {
    const memo = ctx._koCol = new Map();
    const { winnerParent } = parentsOf(ctx);
    const final = mainFinal(ctx, winnerParent);
    const col = (X) => {
      const got = memo.get(X.id);
      if (got !== undefined) return got;
      memo.set(X.id, -1); // in-progress = cycle guard
      const p = winnerParent.get(X.id);
      let r;
      if (p && placementLabel(p, ctx) === null) r = wdOf(ctx, X.id);
      else if (X === final) r = 0;
      else {
        const feeders = Array.isArray(X.sides) ? X.sides.filter(s => s && s.kind === 'match' && ctx.byId.has(s.match)).map(s => col(ctx.byId.get(s.match))) : [];
        // feeders empty = no match-kind refs = a leaf; depth from leaves is 0
        r = feeders.length ? Math.max(...feeders) - 1 : 0;
      }
      memo.set(X.id, r);
      return r;
    };
    for (const X of ctx.matches) col(X);
  }
  return ctx._koCol.get(m.id);
}

// Ordinal within round from who each winner feeds — Final 1, its feeders 1–2
// by side, and so on down. Reads bracket structure, never `scheduled`, so
// editing times can't renumber anything; only rewiring the bracket does (and
// then the label should change). 0 = off the championship tree (classification
// rounds — placementLabel names those). Memo rides ctx._koOrd: same discard- per- render contract as _koCol/_pl.
function koOrdinal(m, ctx) {
  if (!ctx._koOrd) {
    const { kids, winnerParent } = parentsOf(ctx);
    const ord = ctx._koOrd = new Map();
    const final = mainFinal(ctx, winnerParent);
    if (final) {
      ord.set(final.id, 1);
      for (const stack = [final.id]; stack.length;) { // visited check keeps a cyclic bracket from hanging
        const p = stack.pop();
        const o = ord.get(p);
        for (const [k, id] of (kids.get(p) || []).entries()) {
          if (!ord.has(id)) { ord.set(id, o * 2 - 1 + k); stack.push(id); }
        }
      }
    }
  }
  return ctx._koOrd.get(m.id) || 0;
}

function matchLabel(m, ctx) {
  if (m.pool !== undefined) return `Pool ${m.pool}`;
  const pl = placementLabel(m, ctx);
  if (pl) return pl;
  // cards abbreviate roundName's names — one vocabulary, two lengths; QF/SF
  // carry their bracket ordinal, so slot references name a visible card
  const full = roundName(koColumn(m, ctx));
  const abbr = full.replace('Semifinals', 'SF').replace('Quarterfinals', 'QF');
  // ponytail: only QF/SF get numbered — deeper rounds number when one needs cross-refs there
  return abbr === full ? full : abbr + (koOrdinal(m, ctx) || '');
}

// ---- Status derivation: what a category or player's line says ----------------

// The wave in play: the lowest column whose undone matches are playable — a
// scheduled final doesn't claim the status while its semifinals still decide
// it. Falls back to all undone matches on malformed sides.
function nextKoWave(ctx) {
  const undone = ctx.matches.filter(m => m.pool === undefined && !m.result);
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
  return { kind: 'ko', col };
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
    const koRows = undone.filter(r => r.m.pool === undefined);
    if (!koRows.length) return 'In groups';
    return inWord(Math.max(...koRows.map(r => koColumn(r.m, ctx))));
  }
  // every match they're in is decided below
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
  const koLost = lost.filter(r => r.m.pool === undefined);
  if (koLost.length) return elimWord(Math.max(...koLost.map(r => koColumn(r.m, ctx))));
  const poolsDone = ctx.matches.filter(m => m.pool !== undefined).every(isDone);
  return poolsDone ? 'Out in groups' : 'In groups';
}

if (typeof module !== 'undefined') {
  module.exports = { LOCALE, DATE_RE, ID_RE, ISO_RE, pairSig, makeCat, toCats, matchSlotMs, bestOfOf, countWins, sideIdx, sideLetter, winnerIdx, isDone, isDeadTie, poolStandings, poolRanks, resolveSide, slotLabel, teamLabel, sideLabel, playerMatches, reachableKo, possibleSpan, placementLabel, fmtTime, dayKey, tzOffset, schedTime, schedDays, fmtRange, dateRange, dayShort, dayLabel, fmtDiff, kioskStatus, currentRowIndex, roundName, koColumn, koOrdinal, matchLabel, winners, catStatus, playerStatus };
}
