// Tournament generator — `node gb.js schedule specs/<slug>.json`: writes the
// full tournament file wholesale and keeps the index in sync. The file is
// never hand-edited — scores and venue moves go through the editor. Specs live
// in README (Specs); specs/2026-mammut60.json is a working example.
'use strict';

const fs = require('fs');
const path = require('path');
const { matchSlotMs, pairSig, dayKey, tzOffset, schedTime, fmtTime, ID_RE, schedDays, LOCALE } = require('../site/derive.js');
const { writeTournament, writeTournamentIndex, slotsOverlap, fixedPlayers, isRealDate } = require('./tools.js');
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

// Snake the strength-ordered list across k pools (sizes differ by at most one)
// so every pool gets a seed spread and the top k land one per pool, in order —
// keeps "winner in pool order = top seed" while balancing pool strength.
function splitPools(teams, poolSize) {
  const k = Math.ceil(teams.length / poolSize);
  const pools = Array.from({ length: k }, () => []);
  teams.forEach((t, i) => pools[Math.floor(i / k) % 2 ? k - 1 - (i % k) : i % k].push(t));
  return pools;
}

// Placement bracket for n losers from one knockout round: pair best vs worst
// recursively, determining every rank in range (n=4 QF losers → 2 semis +
// 5th/6th + 7th/8th). fin is the spec's "final" override — bronze only; deeper
// placement matches use the default config.
function buildPlacement(losers, mid, fin) {
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
  return [...r1, ...buildPlacement(winners, mid, fin), ...buildPlacement(losers2, mid, fin)];
}

// S-curve order for seed indices lo..hi (power-of-two span): pair each top-half
// seed with its mirror (best vs worst), interleaving the halves — seed 1 and 2
// land in opposite halves, 1-4 in opposite quarters, and so on, so with k pools
// the pool winners can only meet from round R - ceil(log2 k) + 1 (2 pools: final
// only, 4: no earlier than the semis).
function sCurve(lo, hi) {
  if (lo === hi) return [lo];
  const half = sCurve(lo, lo + ((hi - lo) >> 1));
  const out = [];
  for (const i of half) out.push(i, lo + hi - i);
  return out;
}

// Single elimination, everyone advances. Strength order: pool winners first,
// then interleaved by rank; the S-curve draw pairs best vs worst in round 1
// and keeps top seeds apart. Top seeds (byes = next power of two minus field
// size) skip round 1. The final takes fin (the spec's "final" override);
// placement depth follows placements (power of 2, default 4 = bronze only).
function buildKnockout(pools, names, mid, fin, placements) {
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
  const order = sCurve(0, M - 1); // seed indices in bracket position order
  // Round-1 pairs are mirror positions (p, M-1-p); the rank-major interleave
  // can land two same-pool sides on one pair (4/3/3 -> A3 vs A4). Swap the
  // second side with the last seed that keeps both pairs split; a pool holding
  // more than half the field can't be split at all (5/2) — those stay as built.
  for (let j = 0; j < order.length; j += 2) {
    const a = order[j], b = order[j + 1];
    if (b >= total || seed[a].pool !== seed[b].pool) continue;
    for (let x = total - 1; x >= 0; x--) {
      if (x === b) continue;
      const y = M - 1 - x;
      if (seed[x].pool === seed[a].pool) continue;
      if (y < total && seed[b].pool === seed[y].pool) continue;
      [seed[b], seed[x]] = [seed[x], seed[b]];
      break;
    }
  }

  const matches = [];
  const rounds = []; // track every round for placement construction
  const ms1 = [];
  const reachOf = new Map(); // match id -> pools that could feed its winner
  let round = [];
  // Pairs emit in position order, keeping top seeds in opposite halves; the
  // low seed of every pair is real (a low-half index is always < total), so
  // each pair is a match or a bye.
  for (let j = 0; j < order.length; j += 2) {
    const a = order[j], b = order[j + 1];
    if (b < total) {
      const m = { id: mid(), sides: [seed[a], seed[b]] };
      reachOf.set(m.id, new Set([seed[a].pool, seed[b].pool]));
      ms1.push(m);
      matches.push(m);
      round.push({ kind: 'match', match: m.id, result: 'winner' });
    } else {
      round.push(seed[a]); // bye
    }
  }
  rounds.push(ms1);
  // Same-pool separation beyond round 1: the swap above guards only the first
  // round, so two byed seeds of one pool can still sit adjacent in a mid round
  // (9/10/17-team fields -> C1 vs C2 in the QF). Split every round's array
  // before pairing: move the second side to a slot that keeps both its
  // outgoing and incoming pairs cross-pool, without early winner-vs-winner.
  // Entries are pool slots or winner edges (reachOf). A field with more pool
  // slots than cross-pool partners can't be split — those stay as built.
  const poolsOf = e => e && e.kind === 'pool' ? [{ pool: e.pool, rank: e.rank }]
    : [...(reachOf.get(e && e.match) || [])].map(p => ({ pool: p, rank: -1 }));
  const splitRound = (arr) => {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const a = poolsOf(arr[i]), b = poolsOf(arr[i + 1]);
      if (!a.some(x => b.some(y => x.pool === y.pool))) continue;
      for (let j = arr.length - 1; j >= 0; j--) {
        if (j === i || j === i + 1) continue; // a stays; b may move either way
        const c = poolsOf(arr[j]);
        if (c.some(x => a.some(y => x.pool === y.pool))) continue; // c must be cross-pool with a
        if (a.some(x => x.rank === 1) && c.some(x => x.rank === 1)) continue; // no early winner-vs-winner
        const partner = poolsOf(arr[j % 2 ? j - 1 : j + 1]);
        if (b.some(x => x.rank === 1) && partner.some(x => x.rank === 1)) continue;
        if (b.some(x => partner.some(y => x.pool === y.pool))) continue; // b must be cross-pool at its new slot
        [arr[i + 1], arr[j]] = [arr[j], arr[i + 1]];
        break;
      }
    }
    return arr;
  };
  splitRound(round);
  // When byes exceed round-1 matches (5/9/10/11-team fields) two byed seeds
  // must meet in round 2 — structurally forced, nothing crashes.
  while (round.length > 1) {
    const next = [];
    const ms = [];
    for (let i = 0; i < round.length; i += 2) {
      const m = { id: mid(), sides: [round[i], round[i + 1]] };
      const set = new Set();
      for (const e of m.sides) {
        if (e.kind === 'pool') set.add(e.pool);
        else for (const p of reachOf.get(e.match) || []) set.add(p);
      }
      reachOf.set(m.id, set);
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

  // Placement matches for each round whose loser band fits within placements
  // (rounds[length-1] is the final; a round dist from it has losers up to
  // 2^(dist+1) — default 4 = bronze only).
  for (let ri = rounds.length - 2; ri >= 0; ri--) {
    const n = rounds[ri].length; // number of losers from this round
    if (2 ** (rounds.length - ri) <= placements) {
      const losers = rounds[ri].map(m => ({ kind: 'match', match: m.id, result: 'loser' }));
      // Only the bronze bracket (from the round before the final) gets the final override
      const override = (ri === rounds.length - 2 && n === 2) ? fin : {};
      matches.push(...buildPlacement(losers, mid, override));
    }
  }

  return matches;
}

function buildCategory(teams, cat, poolSize) {
  const pools = splitPools(teams, poolSize);
  if (pools.some(p => p.length < 2)) {
    // A 1-team pool yields no matches but feeds pool slots to the knockout, so
    // the produced file would fail its own gate — name the split here.
    throw new Error(`spec: category ${cat.id}: ${teams.length} teams at poolSize ${poolSize} split into a lone-team pool — every pool needs at least 2 teams`);
  }
  const names = pools.map((_, i) => String.fromCharCode(65 + i));
  const matches = [];
  let next = 1;
  const mid = () => next++;

  // Round-major feed: all pools play round r together. Pool-by-pool feeding
  // let early pools hog the courts — idle waves and uneven rest.
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
    matches.push(...buildKnockout(pools, names, mid, cat.final || {}, cat.placements));
  }
  return matches;
}

// ---------- scheduling ----------

// Greedy court + time assignment across all categories. Matches run in build
// order — pools first (players known), then knockout in dependency order. A
// match's floor is its block's start, or the end of its feeders / its pool's
// last match, so brackets never start before their sources. Each match takes
// the earliest floor-aligned slot with a free court and no same-window player
// double-book (pool matches only — knockout sides resolve only after results).
// Occupancy is a start/end window over the effective slot length (matchSlotMs),
// matching the validator's overlap rule. Tuples are [cat, teamList, matches].
function scheduleMatches(categories, venues, tz, slotCfgOf, eventDate, blockStart) {
  if (venues.length === 0) throw new Error('spec: venues must be a non-empty id -> name map');
  const offset = tzOffset(tz, eventDate);
  const startOf = (cat) => Date.parse(`${eventDate}T${blockStart[cat]}:00${offset}`);
  const courtUse = new Map(); // venue -> [{ start, end }]
  const playerUse = []; // { start, end, players: Set }
  const endOf = new Map(); // match id -> end ms (feeder floor)
  const poolDone = new Map(); // pool -> end ms (pool-slot floor)

  for (const [cat, , matches] of categories) {
    const start = startOf(cat);
    if (Number.isNaN(start)) throw new Error(`spec: no blocks entry for category ${cat}`);
    const catSlots = slotCfgOf.get(cat);
    for (const m of matches) {
      const slotMs = matchSlotMs(m, { slotMinutes: catSlots });
      const players = fixedPlayers(m);
      let t = start;
      for (const s of m.sides) {
        if (s.kind === 'match') t = Math.max(t, endOf.get(s.match) ?? start);
        else if (s.kind === 'pool') t = Math.max(t, poolDone.get(s.pool) ?? start);
      }
      for (;;) {
        const free = (v) => !(courtUse.get(v) ?? []).some((w) => slotsOverlap(t, t + slotMs, w.start, w.end));
        const venue = venues.find(free);
        const blocked = players && playerUse.some(
          (w) => slotsOverlap(t, t + slotMs, w.start, w.end) && [...players].some((p) => w.players.has(p)));
        if (venue && !blocked) {
          m.venue = venue;
          // Local wall date + time in the event tz, no offset. A fixed
          // eventDate prefix would backdate a midnight-crossing slot by 24h,
          // so the day comes from the instant.
          m.scheduled = `${dayKey(t, tz)}T${fmtTime(t, tz)}:00`;
          courtUse.set(venue, [...(courtUse.get(venue) ?? []), { start: t, end: t + slotMs }]);
          endOf.set(m.id, t + slotMs);
          if (m.pool !== undefined) poolDone.set(m.pool, Math.max(poolDone.get(m.pool) ?? start, t + slotMs));
          if (players) playerUse.push({ start: t, end: t + slotMs, players });
          break;
        }
        t += slotMs;
      }
    }
  }
}

// The greedy's invariants, which validate.js can't see: every match got a slot
// and no pool match double-books a player. (Knockout sides are unknown until
// results; same-wave knockout matches are structurally disjoint.)
function assertSchedule(categories, slotCfgOf, tz) {
  const sched = []; // { m, t, players }
  for (const [cat, , matches] of categories) {
    const catSlots = slotCfgOf.get(cat);
    for (const m of matches) {
      if (!m.scheduled || !m.venue) throw new Error(`match ${m.id} never got a slot`);
      sched.push({
        m,
        t: schedTime(m, tz),
        slotMs: matchSlotMs(m, { slotMinutes: catSlots }),
        players: fixedPlayers(m),
      });
    }
  }
  // venue overlap needs no check here — generate() ends by running validateRepo
  // on this same output, whose venue rule uses the same slotsOverlap predicate
  // ponytail: O(n²) double-book scan — schedules are one day; index by time
  // window per player if a spec ever grows past ~50 matches per category.
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j];
      if (a.players && b.players && slotsOverlap(a.t, a.t + a.slotMs, b.t, b.t + b.slotMs)) {
        for (const p of a.players) {
          if (b.players.has(p)) throw new Error(`player ${p} double-booked (${a.m.id} ${a.m.scheduled}, ${b.m.id} ${b.m.scheduled})`);
        }
      }
    }
  }
}

// Renumber matches in chronological order with sequential ids — diffs and slot
// refs stay readable. Instants come from schedTime, never bare Date.parse —
// scheduled is wall time, only the tournament tz anchors it. Build order
// breaks simultaneous-slot ties via the stable sort.
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

// Spec -> the full tournament file body (skeleton + scheduled matches). Pure:
// no I/O, so tests can run it against a spec in memory. main() does the writes.
function generate(spec) {
  const { slug, name, location, timezone, date: eventDate, poolSize, blocks: blockStart, venues, players, categories, teams } = spec;

  // ---- spec surface (fail fast; the gate below would catch most of these too) ----
  if (typeof slug !== 'string' || !ID_RE.test(slug)) throw new Error(`spec: slug ${JSON.stringify(slug)} must match ${ID_RE}`);
  if (!Number.isInteger(poolSize) || poolSize < 2) throw new Error(`spec: poolSize must be an integer >= 2, got ${JSON.stringify(poolSize)}`);
  // name/location/timezone and bestOf are checked by the validator gate at the
  // end — one source for those messages.
  const objMap = (v, field) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`spec: ${field} must be an id -> value map, got ${JSON.stringify(v)}`);
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
  try { new Intl.DateTimeFormat(LOCALE, { timeZone: timezone }); }
  catch { throw new Error(`spec: timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`); }
  // A non-object final would drop the override silently and still validate —
  // the one spec failure the gate can't see. Everything else lands in the file
  // where validate.js rejects it by name.
  for (const c of categories) {
    if (c.final !== undefined && (typeof c.final !== 'object' || Array.isArray(c.final))) {
      throw new Error(`spec: category ${c.id}: final must be an object { bestOf?, slotMinutes? }, got ${JSON.stringify(c.final)}`);
    }
    if (c.knockout !== undefined && typeof c.knockout !== 'boolean') {
      throw new Error(`spec: category ${c.id}: knockout must be a boolean (true/false), got ${JSON.stringify(c.knockout)}`);
    }
    if (c.placements !== undefined) {
      if (typeof c.placements !== 'number' || c.placements < 2 || (c.placements & (c.placements - 1)) !== 0) {
        throw new Error(`spec: category ${c.id}: placements must be a power of 2 >= 2, got ${JSON.stringify(c.placements)}`);
      }
    }
    // A missing slotMinutes is only a validator warning, yet it NaNs every slot
    // window and piles every match on the first court — fail fast instead.
    if (typeof c.slotMinutes !== 'number' || !Number.isInteger(c.slotMinutes) || c.slotMinutes < 1) {
      throw new Error(`spec: category ${c.id}: slotMinutes must be a positive integer, got ${JSON.stringify(c.slotMinutes)}`);
    }
  }

  // ---- skeleton ----
  const catById = new Map(categories.map((c) => [c.id, c]));
  const VENUES = Object.entries(venues).map(([id, vn]) => ({ id, name: vn })); // spec order = court-assignment priority
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
    results.push([cat, teamList, buildCategory(teamList, catById.get(cat), poolSize)]);
  }
  const slotCfgOf = new Map(CATS.map((c) => [c.id, c.slotMinutes]));
  scheduleMatches(results, VENUES.map((v) => v.id), timezone, slotCfgOf, eventDate, blockStart);
  assertSchedule(results, slotCfgOf, timezone);

  const out = { name, location, timezone, venues: VENUES, categories: CATS, players: PLAYERS, matches: {} };
  for (const [cat, teamList, ms] of results) {
    assertPoolCoverage(teamList, ms, poolSize);
    renumberByTime(ms, timezone);
    out.matches[cat] = ms;
    console.log(`${cat}: ${ms.length} matches`);
  }

  // Gate the produced file with the real validateRepo before writing anything —
  // schedule.main never emits a file the gate would reject. The spec-only
  // guards above stay: poolSize, placements, knockout, final, the id->value
  // maps; slotMinutes stays a spec guard because a zero-length window never
  // terminates the greedy.
  const g = validateRepo({
    readErrs: [],
    index: [{ slug, name, location, dates: schedDays(Object.values(out.matches).flat(), timezone) }],
    tournaments: new Map([[slug, { tjson: out }]]),
  });
  if (g.errs.length) throw new Error('spec: output fails validation:\n' + g.errs.join('\n'));

  return out;
}

// CLI entry (dispatched from gb.js): root is the repo root, specPath is
// cwd-relative (run from the repo root: specs/<slug>.json).
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
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const entry = { slug: spec.slug, name: spec.name, location: spec.location, dates: schedDays(Object.values(tourney.matches).flat(), tourney.timezone) };
  const i = Array.isArray(idx) ? idx.findIndex((t) => t && t.slug === spec.slug) : -1;
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  writeTournamentIndex(siteRoot, idx); // the one-per-line shape — index diffs stay per-tournament

  console.log(`Wrote site/tournaments/${spec.slug}.json — run \`node gb.js validate\` before committing.`);
}

module.exports = { generate, main };
