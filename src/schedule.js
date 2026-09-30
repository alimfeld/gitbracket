// Tournament generator — writes the full tournament file wholesale and keeps the index
// in sync. Results and venue moves go through the editor, never this. Specs: README.
'use strict';

const fs = require('fs');
const path = require('path');
const { matchSlotMs, pairSig, dayKey, schedTime, wallHM, ID_RE, MAX_BEST_OF } = require('../site/derive.js');
const { writeTournament, writeTournamentIndex, slotsOverlap, plainObject, fixedPlayers, isRealDate, daysOf } = require('./tools.js');
const { validateRepo } = require('./validate.js');

// Round-robin pairings, circle method: array of rounds, each a list of pairs.
function roundRobin(teams) {
  const list = teams.length % 2 ? teams.concat([null]) : teams.slice();
  const half = list.length / 2;
  const rounds = [];
  for (let r = 0; r < list.length - 1; r++) {
    const pairs = [];
    for (let i = 0; i < half; i++) {
      const a = list[i];
      const b = list[list.length - 1 - i];
      if (a != null && b != null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop()); // rotate, first element fixed
  }
  return rounds;
}

// Snake the strength-ordered list across k pools so the top k land one per pool and
// pool strength is balanced.
function splitPools(teams, poolSize) {
  const k = Math.ceil(teams.length / poolSize);
  const pools = Array.from({ length: k }, () => []);
  teams.forEach((team, i) => {
    const row = Math.floor(i / k), col = i % k;
    pools[row % 2 ? k - 1 - col : col].push(team); // alternate direction each row
  });
  return pools;
}

// Placement bracket for n losers: pair best vs worst recursively, determining every
// rank in range. fin is the spec's "final" override for the bronze only. rounds caps
// how deep the band plays: 1 enters the band without resolving it (its winners and
// losers tie), so every eliminated team gets at most one placement match.
function buildPlacement(losers, mid, fin, rounds = Infinity) {
  const n = losers.length;
  if (n < 2) return []; // single loser: rank is implied by bracket position, no match possible
  if (n === 2) {
    const m = { id: mid(), sides: [losers[0], losers[1]] };
    if (fin.bestOf !== undefined) m.bestOf = fin.bestOf;
    if (fin.slotMinutes !== undefined) m.slotMinutes = fin.slotMinutes;
    return [m];
  }
  // n >= 3: pair best vs worst, then recurse winners (top half) and losers (bottom half)
  const r1 = [];
  const winners = [], losers2 = [];
  const half = n >> 1;
  for (let i = 0; i < half; i++) {
    const m = { id: mid(), sides: [losers[i], losers[n - 1 - i]] };
    r1.push(m);
    winners.push({ kind: 'match', match: m.id, result: 'winner' });
    losers2.push({ kind: 'match', match: m.id, result: 'loser' });
  }
  // odd count: the middle loser waits for the top half's winner — its rank
  // decided on court, not implied
  if (n % 2 === 1) winners.push(losers[half]);
  if (rounds <= 1) return r1; // one round per band: entered, not resolved
  return [...r1, ...buildPlacement(winners, mid, fin, rounds - 1), ...buildPlacement(losers2, mid, fin, rounds - 1)];
}

// S-curve order for seed indices lo..hi: pair each top-half seed with its mirror,
// interleaving the halves so top seeds stay apart.
function sCurve(lo, hi) {
  if (lo === hi) return [lo];
  const half = sCurve(lo, lo + ((hi - lo) >> 1));
  const out = [];
  for (const i of half) out.push(i, lo + hi - i);
  return out;
}

// Single elimination. Strength order: pool winners first, then interleaved by rank;
// the S-curve pairs best vs worst. Byes (next power of two minus field size) skip
// round 1. fin overrides the final; placements sets placement depth.
function buildKnockout(pools, names, mid, fin, placements, placeRounds) {
  placements = placements || 4;
  const total = pools.reduce((s, p) => s + p.length, 0);
  let M = 1;
  while (M < total) M *= 2;

  const seed = [];
  const maxRank = Math.max(...pools.map((p) => p.length));
  for (let r = 1; r <= maxRank; r++) {
    for (let i = 0; i < pools.length; i++) {
      if (pools[i].length >= r) seed.push({ kind: 'pool', pool: names[i], rank: r });
    }
  }
  const order = sCurve(0, M - 1); // seed index per bracket position; >= total is a bye
  // Round-1 pairs are mirror positions; the rank-major interleave can land two
  // same-pool sides on one pair (7 teams 4/3 -> B1 vs B4). Move the side carrying no
  // pool winner to the last cross-pool slot — a winner never moves, so the draw holds.
  const at = (pos) => (order[pos] < total ? seed[order[pos]] : null);
  for (let p = 0; p < M; p += 2) {
    const x = at(p), y = at(p + 1);
    if (!x || !y || x.pool !== y.pool) continue;
    const movedIdx = y.rank !== 1 ? p + 1 : (x.rank !== 1 ? p : -1);
    if (movedIdx < 0) continue; // both sides carry a pool winner: leave as built
    const kept = at(movedIdx === p + 1 ? p : p + 1), moved = at(movedIdx);
    for (let q = M - 1; q >= 0; q--) {
      if (q === p || q === p + 1) continue;
      const c = at(q), d = at(q ^ 1);
      if (c && c.rank === 1) continue;
      if (c && c.pool === kept.pool) continue;
      if (d && moved.pool === d.pool) continue;
      [order[movedIdx], order[q]] = [order[q], order[movedIdx]];
      break;
    }
  }

  const matches = [];
  const rounds = []; // track every round for placement construction
  const ms1 = [];
  const reachOf = new Map(); // match id -> pools that could feed its winner
  const winnerOf = new Map(); // match id -> pools whose rank-1 could feed its winner
  let round = [];
  // Pairs emit in position order, so top seeds stay in opposite halves; each pair is
  // a match or a bye.
  for (let j = 0; j < order.length; j += 2) {
    const a = order[j], b = order[j + 1];
    if (a < total && b < total) {
      const m = { id: mid(), sides: [seed[a], seed[b]] };
      reachOf.set(m.id, new Set([seed[a].pool, seed[b].pool]));
      winnerOf.set(m.id, new Set(m.sides.filter((s) => s.rank === 1).map((s) => s.pool)));
      ms1.push(m);
      matches.push(m);
      round.push({ kind: 'match', match: m.id, result: 'winner' });
    } else {
      round.push(seed[a < total ? a : b]); // bye advances the real seed
    }
  }
  rounds.push(ms1);
  // Round >1: the same repair, run on each round's winners before they are paired.
  const poolsOf = (e) => e && e.kind === 'pool' ? [{ pool: e.pool, rank: e.rank }]
    : [...(reachOf.get(e && e.match) || [])].map((p) => ({ pool: p, rank: -1 }));
  const sharesPool = (x, y) => x.some((a) => y.some((b) => a.pool === b.pool));
  const free = (e) => e && e.kind === 'pool' ? e.rank !== 1 : !winnerOf.get(e && e.match)?.size;
  const splitRound = (arr) => {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      if (!sharesPool(poolsOf(arr[i]), poolsOf(arr[i + 1]))) continue;
      // move whichever side carries no pool winner; the other stays put
      const movedIdx = free(arr[i + 1]) ? i + 1 : (free(arr[i]) ? i : -1);
      if (movedIdx < 0) continue;
      const kept = arr[movedIdx === i + 1 ? i : i + 1], moved = arr[movedIdx];
      for (let j = arr.length - 1; j >= 0; j--) {
        if (j === i || j === i + 1) continue;
        const c = arr[j], d = arr[j ^ 1];
        if (!free(c)) continue;
        if (sharesPool(poolsOf(c), poolsOf(kept))) continue;
        if (sharesPool(poolsOf(moved), poolsOf(d))) continue;
        [arr[movedIdx], arr[j]] = [arr[j], arr[movedIdx]];
        break;
      }
    }
    return arr;
  };
  splitRound(round);
  // Two byed seeds must meet in round 2 when byes exceed round-1 matches — structurally forced.
  while (round.length > 1) {
    const next = [];
    const ms = [];
    for (let i = 0; i < round.length; i += 2) {
      const m = { id: mid(), sides: [round[i], round[i + 1]] };
      const set = new Set();
      const win = new Set();
      for (const e of m.sides) {
        if (e.kind === 'pool') {
          set.add(e.pool);
          if (e.rank === 1) win.add(e.pool);
        } else {
          for (const p of reachOf.get(e.match) || []) set.add(p);
          for (const p of winnerOf.get(e.match) || []) win.add(p);
        }
      }
      reachOf.set(m.id, set);
      winnerOf.set(m.id, win);
      ms.push(m);
      next.push({ kind: 'match', match: m.id, result: 'winner' });
    }
    matches.push(...ms);
    rounds.push(ms);
    round = splitRound(next);
  }

  const finalM = matches[matches.length - 1];
  if (fin.bestOf !== undefined) finalM.bestOf = fin.bestOf;
  if (fin.slotMinutes !== undefined) finalM.slotMinutes = fin.slotMinutes;

  // Placement matches for each round whose loser band fits within placements.
  for (let ri = rounds.length - 2; ri >= 0; ri--) {
    const n = rounds[ri].length; // number of losers from this round
    if (2 ** (rounds.length - ri) <= placements) {
      const losers = rounds[ri].map(m => ({ kind: 'match', match: m.id, result: 'loser' }));
      // Only the bronze bracket (from the round before the final) gets the final override
      const override = (ri === rounds.length - 2 && n === 2) ? fin : {};
      matches.push(...buildPlacement(losers, mid, override, placeRounds));
    }
  }

  return { matches, rounds };
}

function buildCategory(teams, cat, poolSize) {
  const pools = splitPools(teams, poolSize);
  if (pools.some(p => p.length < 2)) {
    // A 1-team pool yields no matches but feeds pool slots to the knockout, so the
    // produced file would fail its own gate — name the split here.
    throw new Error(`spec: category ${cat.id}: ${teams.length} teams at poolSize ${poolSize} split into a lone-team pool — every pool needs at least 2 teams`);
  }
  const names = pools.map((_, i) => String.fromCharCode(65 + i));
  const matches = [];
  let next = 1;
  const mid = () => next++;

  // Round-major feed: all pools play round r together; pool-by-pool feeding let early
  // pools hog the courts.
  const rr = pools.map((pool) => roundRobin(pool));
  const maxRounds = Math.max(...rr.map((rs) => rs.length));
  for (let r = 0; r < maxRounds; r++) {
    rr.forEach((rounds, p) => {
      if (!rounds[r]) return; // pool finished earlier (sizes differ by at most one)
      for (const [a, b] of rounds[r]) {
        matches.push({
          id: mid(),
          pool: names[p],
          sides: [
            { kind: 'players', ids: a },
            { kind: 'players', ids: b },
          ],
        });
      }
    });
  }

  if (cat.knockout !== false && (pools.length > 1 || cat.knockout === true)) {
    const ko = buildKnockout(pools, names, mid, cat.final || {}, cat.placements, cat.placementRounds);
    matches.push(...ko.matches);
    return { matches, rounds: ko.rounds }; // rounds: champion-tree rounds, leaves to the final — scheduling aligns each round
  }
  return { matches, rounds: [] };
}

// ---------- scheduling ----------

// Greedy court+time assignment across all categories. Each step places the candidate
// whose earliest obtainable slot is soonest; same-slot ties go to the least-advanced
// category. A champion-tree round is placed atomically on the first wave where every
// member fits — a round with more members than its allowed courts spills individually.
// Occupancy is
// a start/end window over the effective slot length (matchSlotMs), matching the
// validator's overlap rule. Tuples are [cat, teamList, matches, rounds].
function scheduleMatches(categories, tz, slotCfgOf, courtsOf, eventDate, blockStart) {
  const startOf = (cat) => schedTime({ scheduled: `${eventDate}T${blockStart[cat]}:00` }, tz);
  const courtUse = new Map(); // venue -> [{ start, end }]
  const playerUse = []; // { start, end, players: Set } — global, players span categories
  const endOf = new Map(); // catIdx -> match id -> end ms (feeder floor)
  const poolDone = new Map(); // catIdx -> pool -> end ms (pool-slot floor)
  const roundOf = new Map(); // catIdx -> match id -> its round's matches
  const poolLast = new Map(); // catIdx -> pool -> build index of its last match
  const st = categories.map(([cat, , matches], i) => {
    const catSlots = slotCfgOf.get(cat);
    return { i, matches, idx: 0, total: matches.reduce((s, m) => s + matchSlotMs(m, { slotMinutes: catSlots }), 0), placed: 0, courts: courtsOf.get(cat) };
  }); // merge cursors, each carrying its court-minute workload
  categories.forEach(([, , matches, rounds], c) => {
    endOf.set(c, new Map());
    poolDone.set(c, new Map());
    const ro = new Map();
    // A play-in bracket must not stagger its quarters: every match of a
    // champion-tree round shares the round's latest feeder end.
    rounds.forEach((rs) => { for (const m of rs) ro.set(m.id, rs); });
    roundOf.set(c, ro);
    const pl = new Map();
    matches.forEach((pm, i) => { if (pm.pool !== undefined) pl.set(pm.pool, i); });
    poolLast.set(c, pl);
  });
  // A knockout match's earliest start, as a pick-time predicate: Infinity (not
  // pickable) until every pool it feeds on has placed its last match — a
  // pool's end isn't final until then, and a stale floor would let a bracket
  // start before its own pools finish. Feeder ends only exist after placement,
  // so they gate the same way.
  const floorOf = (catIdx, start) => {
    const m = st[catIdx].matches[st[catIdx].idx];
    const grp = roundOf.get(catIdx).get(m.id) ?? [m];
    let t = start;
    for (const fm of grp) {
      for (const s of fm.sides) {
        if (s.kind === 'match') {
          const e = endOf.get(catIdx).get(s.match);
          if (e === undefined) return Infinity;
          t = Math.max(t, e);
        } else if (s.kind === 'pool') {
          if (poolLast.get(catIdx).get(s.pool) >= st[catIdx].idx) return Infinity;
          t = Math.max(t, poolDone.get(catIdx).get(s.pool) ?? start);
        }
      }
    }
    return t;
  };
  // The first free court at t outside `taken` — round members need distinct
  // courts. Placement matches aren't in roundOf (their feeders are aligned
  // rounds, not their own), so they never sync here; they land aligned
  // through their floors, as before. `courts` is the category's allowed venues
  // (every venue when the spec omits `courts`), in priority order: a match
  // takes the first free one and never another.
  const courtAt = (t, slot, taken, courts) => {
    const free = (v) => (!taken || !taken.has(v)) && !(courtUse.get(v) ?? []).some((w) => slotsOverlap(t, t + slot, w.start, w.end));
    return courts.find(free);
  };
  const grpFit = (grp, t, catSlots, courts) => {
    const taken = new Set();
    for (const gm of grp) {
      const v = courtAt(t, matchSlotMs(gm, { slotMinutes: catSlots }), taken, courts);
      if (!v) return false;
      taken.add(v);
    }
    return true;
  };
  // The first wave at/after the floor where the whole round fits — a round
  // waits rather than splits, so its start is never a partial round, and the
  // wait is bounded by a chain to preserve. A round with more members than
  // its allowed courts can never fit — Infinity, and its members place
  // individually, spilling over later waves instead of other courts.
  const syncWave = (grp, f, catSlots, courts) => {
    if (grp.length > courts.length) return Infinity;
    const step = matchSlotMs(grp[0], { slotMinutes: catSlots }); // all members share one slot length
    let maxEnd = 0;
    for (const ws of courtUse.values()) for (const w of ws) maxEnd = Math.max(maxEnd, w.end);
    for (let t = f; ; t += step) {
      if (t >= maxEnd || grpFit(grp, t, catSlots, courts)) return t; // past every occupancy: all courts free
    }
  };
  // A single match's earliest obtainable slot: a free court and, for known
  // players, no same-window double-book. Always terminates — courts empty out.
  const firstFree = (t, slotMs, players, courts) => {
    for (;;) {
      const venue = courtAt(t, slotMs, undefined, courts);
      const blocked = players && playerUse.some(
        (w) => slotsOverlap(t, t + slotMs, w.start, w.end) && [...players].some((p) => w.players.has(p)));
      if (venue && !blocked) return t;
      t += slotMs;
    }
  };
  while (st.some((s) => s.idx < s.matches.length)) {
    let pick = -1, pt = Infinity, padv = Infinity, unit = null;
    for (const s of st) {
      if (s.idx >= s.matches.length) continue;
      const f = floorOf(s.i, startOf(categories[s.i][0]));
      if (f === Infinity) continue; // feeders still in flight — not pickable
      const catSlots = slotCfgOf.get(categories[s.i][0]);
      const head = s.matches[s.idx];
      // A round is one unit on its sync wave; a plain match takes its
      // earliest slot. Same-t ties: least advanced wins (see the header).
      const grp = roundOf.get(s.i).get(head.id);
      let t, u = null;
      if (grp && grp.length > 1) {
        t = syncWave(grp, f, catSlots, s.courts);
        if (t !== Infinity) u = grp;
      }
      if (!u) t = firstFree(f, matchSlotMs(head, { slotMinutes: catSlots }), fixedPlayers(head), s.courts);
      const adv = s.placed / s.total;
      if (t < pt || (t === pt && adv < padv)) { pick = s.i; pt = t; padv = adv; unit = u; }
    }
    if (pick < 0) throw new Error('schedule: stalled — no pickable match, the feeder-order invariant broke');
    const cat = categories[pick][0];
    const start = startOf(cat);
    const catSlots = slotCfgOf.get(cat);
    // One match on a court: venue, wall clock, occupancy, floors, credit.
    // `taken` keeps synced round members off a shared court; a match with
    // known players books them against double-books. Wall date + time come
    // from the instant — a fixed eventDate prefix would backdate a
    // midnight-crossing slot by 24h.
    const place = (m, t, taken) => {
      const slotMs = matchSlotMs(m, { slotMinutes: catSlots });
      const venue = courtAt(t, slotMs, taken, st[pick].courts);
      m.venue = venue;
      m.scheduled = `${dayKey(t, tz)}T${wallHM(t, tz)}:00`;
      courtUse.set(venue, [...(courtUse.get(venue) ?? []), { start: t, end: t + slotMs }]);
      endOf.get(pick).set(m.id, t + slotMs);
      if (m.pool !== undefined) poolDone.get(pick).set(m.pool, Math.max(poolDone.get(pick).get(m.pool) ?? start, t + slotMs));
      const players = fixedPlayers(m);
      if (players) playerUse.push({ start: t, end: t + slotMs, players });
      st[pick].placed += slotMs;
    };
    if (unit) {
      // Whole round on one wave: every member gets its own court at pt.
      const taken = new Set();
      for (const gm of unit) place(gm, pt, taken);
      st[pick].idx += unit.length;
    } else {
      place(st[pick].matches[st[pick].idx++], pt); // the pick already scanned this earliest slot
    }
  }
}

// The greedy's one invariant validate.js can't see: every match got a slot.
// Double-books surface in generate()'s validateRepo pass.
function assertSchedule(categories) {
  for (const [, , matches] of categories) {
    for (const m of matches) {
      if (!m.scheduled || !m.venue) throw new Error(`match ${m.id} never got a slot`);
    }
  }
}

// Renumber in chronological order with sequential ids, so diffs and slot refs stay
// readable. Instants come from schedTime (scheduled is wall time).
function renumberByTime(ms, tz) {
  const ordered = [...ms].sort((a, b) => schedTime(a, tz) - schedTime(b, tz));
  const remap = new Map();
  ordered.forEach((m, i) => remap.set(m.id, i + 1));
  for (const m of ordered) {
    m.id = remap.get(m.id);
    for (const s of m.sides) if (s && s.kind === 'match') s.match = remap.get(s.match);
  }
  ms.length = 0;
  ms.push(...ordered);
}

// Round robin must cover every pair exactly once — validate.js can't see this.
function assertPoolCoverage(teams, matches, poolSize) {
  splitPools(teams, poolSize).forEach((pool, p) => {
    const pairs = matches
      .filter((m) => m.pool === String.fromCharCode(65 + p))
      .map((m) =>
        m.sides
          .map((s) => pairSig(s.ids))
          .sort()
          .join(' ~ ')
      );
    const want = (pool.length * (pool.length - 1)) / 2;
    if (new Set(pairs).size !== want) {
      throw new Error(`pool ${String.fromCharCode(65 + p)}: ${new Set(pairs).size}/${want} pairings`);
    }
  });
}

// Spec -> the full tournament file body. Pure, so tests run it in memory; main() writes.
function generate(spec) {
  const { slug, name, location, timezone, date: eventDate, poolSize, blocks: blockStart, venues, players, categories, teams } = spec;

  // ---- spec surface (fail fast; the gate below would catch most of these too) ----
  if (typeof slug !== 'string' || !ID_RE.test(slug)) throw new Error(`spec: slug ${JSON.stringify(slug)} must match ${ID_RE}`);
  if (!Number.isInteger(poolSize) || poolSize < 2) throw new Error(`spec: poolSize must be an integer >= 2, got ${JSON.stringify(poolSize)}`);
  // name/location/timezone and bestOf are checked by the validator gate at the end.
  const objMap = (v, field) => {
    if (!plainObject(v)) throw new Error(`spec: ${field} must be an id -> value map, got ${JSON.stringify(v)}`);
  };
  objMap(venues, 'venues');
  objMap(players, 'players');
  objMap(teams, 'teams');
  objMap(blockStart, 'blocks');
  if (!Array.isArray(categories)) throw new Error(`spec: categories must be an array, got ${JSON.stringify(categories)}`);
  // Date.parse rolls impossible calendar dates (2025-02-30 -> Mar 2); catch them like the validator does.
  const [yy, mm, dd] = String(eventDate).split('-').map(Number);
  if (!isRealDate(yy, mm, dd)) {
    throw new Error(`spec: date ${JSON.stringify(eventDate)} is not a real calendar date`);
  }
  // A bad timezone would surface as a "no blocks entry" error — name the real
  // cause here.
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error(`spec: timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`); }
  // A non-object final would drop the override silently and still validate — the one
  // spec failure the gate can't see.
  for (const c of categories) {
    // A missing block start used to leak NaN through the greedy into an
    // unreadable TypeError — name it here instead.
    if (typeof blockStart[c.id] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(blockStart[c.id])) {
      throw new Error(`spec: no blocks entry with a valid HH:MM start for category ${c.id}, got ${JSON.stringify(blockStart[c.id])}`);
    }
    if (schedTime({ scheduled: `${eventDate}T${blockStart[c.id]}:00` }, timezone) === null) {
      throw new Error(`spec: blocks.${c.id} is not a real local time in ${timezone}: ${eventDate}T${blockStart[c.id]}`);
    }
    if (c.final !== undefined && !plainObject(c.final)) {
      throw new Error(`spec: category ${c.id}: final must be an object { bestOf?, slotMinutes? }, got ${JSON.stringify(c.final)}`);
    }
    if (c.final !== undefined) {
      // the override is the one spec failure the output gate can't name usefully — fail fast here
      const { bestOf, slotMinutes } = c.final;
      if (bestOf !== undefined && (!Number.isInteger(bestOf) || bestOf % 2 !== 1 || bestOf < 1 || bestOf > MAX_BEST_OF)) {
        throw new Error(`spec: category ${c.id}: final.bestOf must be an odd number 1–${MAX_BEST_OF}, got ${JSON.stringify(bestOf)}`);
      }
      if (slotMinutes !== undefined && (!Number.isInteger(slotMinutes) || slotMinutes < 1)) {
        throw new Error(`spec: category ${c.id}: final.slotMinutes must be a positive integer, got ${JSON.stringify(slotMinutes)}`);
      }
    }
    if (c.knockout !== undefined && typeof c.knockout !== 'boolean') {
      throw new Error(`spec: category ${c.id}: knockout must be a boolean (true/false), got ${JSON.stringify(c.knockout)}`);
    }
    if (c.placements !== undefined) {
      if (typeof c.placements !== 'number' || c.placements < 2 || (c.placements & (c.placements - 1)) !== 0) {
        throw new Error(`spec: category ${c.id}: placements must be a power of 2 >= 2, got ${JSON.stringify(c.placements)}`);
      }
    }
    if (c.placementRounds !== undefined && (!Number.isInteger(c.placementRounds) || c.placementRounds < 1)) {
      throw new Error(`spec: category ${c.id}: placementRounds must be a positive integer, got ${JSON.stringify(c.placementRounds)}`);
    }
    if (c.courts !== undefined) {
      // A malformed court list would silently place nothing (unknown ids never
      // match; an empty list has no id at all) — name it here.
      if (!Array.isArray(c.courts) || c.courts.some((v) => typeof v !== 'string') || c.courts.length === 0) {
        throw new Error(`spec: category ${c.id}: courts must be an array of venue ids, got ${JSON.stringify(c.courts)}`);
      }
      for (const v of c.courts) {
        if (!(v in venues)) {
          throw new Error(`spec: category ${c.id}: courts venue ${JSON.stringify(v)} is not in spec.venues`);
        }
      }
    }
    // A missing slotMinutes is a validator error once a match is scheduled, but here
    // it NaNs every slot window and piles every match on the first court — fail fast.
    if (!Number.isInteger(c.slotMinutes) || c.slotMinutes < 1) {
      throw new Error(`spec: category ${c.id}: slotMinutes must be a positive integer, got ${JSON.stringify(c.slotMinutes)}`);
    }
  }

  // ---- skeleton ----
  const catById = new Map(categories.map((c) => [c.id, c]));
  const VENUES = Object.entries(venues).map(([id, vn]) => ({ id, name: vn })); // spec order = court-assignment priority
  if (VENUES.length === 0) throw new Error('spec: venues must be a non-empty id -> name map');
  const PLAYERS = Object.entries(players).map(([id, pn]) => ({ id, name: pn })).sort((a, b) => a.id.localeCompare(b.id));
  const CATS = categories.map((c) => ({
    id: c.id,
    name: c.name,
    bestOf: { groups: c.bestOf, knockout: c.bestOf },
    slotMinutes: { groups: c.slotMinutes, knockout: c.slotMinutes },
  }));

  // ---- teams ----
  const known = new Set(Object.keys(players));
  for (const [cat, teamList] of Object.entries(teams)) {
    if (!catById.has(cat)) throw new Error(`spec: teams for undeclared category ${cat}`);
    for (const ids of teamList) for (const id of ids) {
      if (!known.has(id)) throw new Error(`spec: teams.${cat}: player ${id} not in spec.players`);
    }
  }

  // ---- matches ----
  const results = [];
  for (const [cat, teamList] of Object.entries(teams)) {
    if (teamList.length < 2) {
      console.log(`${cat}: skipped (${teamList.length} team)`);
      continue;
    }
    const built = buildCategory(teamList, catById.get(cat), poolSize);
    results.push([cat, teamList, built.matches, built.rounds]);
  }
  const slotCfgOf = new Map(CATS.map((c) => [c.id, c.slotMinutes]));
  const courtsOf = new Map(categories.map((c) => [c.id, c.courts ?? Object.keys(venues)]));
  scheduleMatches(results, timezone, slotCfgOf, courtsOf, eventDate, blockStart);
  assertSchedule(results);

  const out = { name, location, timezone, venues: VENUES, categories: CATS, players: PLAYERS, matches: {} };
  for (const [cat, teamList, ms] of results) {
    assertPoolCoverage(teamList, ms, poolSize);
    renumberByTime(ms, timezone);
    out.matches[cat] = ms;
    console.log(`${cat}: ${ms.length} matches`);
  }

  // Gate the produced file with the real validateRepo before writing anything. The
  // spec guards above stay: slotMinutes, a zero-length window never terminates the greedy.
  const g = validateRepo({
    readErrs: [],
    index: [{ slug, name, location, dates: daysOf(out) }],
    tournaments: new Map([[slug, { tjson: out }]]),
  });
  if (g.errs.length || g.conflicts.length) throw new Error('spec: output fails validation:\n' + [...g.errs, ...g.conflicts].join('\n'));

  return out;
}

// CLI entry: root is the repo root, specPath is cwd-relative.
function main(root, specPath) {
  if (!specPath) {
    console.error('usage: node gb.js schedule <specs/xxx.json>');
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
  } catch (e) {
    console.error(`schedule: can't read ${specPath} as JSON (${e.message})`);
    process.exit(1);
  }
  const tourney = generate(spec);
  const siteRoot = path.join(root, 'site');
  writeTournament(siteRoot, spec.slug, tourney);

  // keep the list page in sync — a tournament the index doesn't know is invisible
  const idxFile = path.join(siteRoot, 'tournaments.json');
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  } catch (e) {
    console.error(`schedule: can't read site/tournaments.json as JSON (${e.message}) — ${spec.slug}.json is written but the index is untouched; fix the index by hand and commit both`);
    process.exit(1);
  }
  const entry = { slug: spec.slug, name: spec.name, location: spec.location, dates: daysOf(tourney) };
  const i = Array.isArray(idx) ? idx.findIndex((t) => t && t.slug === spec.slug) : -1;
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  writeTournamentIndex(siteRoot, idx); // the one-per-line shape — index diffs stay per-tournament

  console.log(`Wrote site/tournaments/${spec.slug}.json — run \`node gb.js validate\` before committing.`);
}

module.exports = { generate, main };
