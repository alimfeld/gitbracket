// GitBracket tournament generator — `node gb.js schedule specs/<slug>.json`.
// Writes the full tournament file wholesale (skeleton + scheduled matches) and
// keeps the index in sync; the file is never hand-edited — scores and venue
// moves go through the REPL. Specs (and the regeneration caveat) live in
// README (Specs); specs/2026-mammut60.json is a working example.
'use strict';

const fs = require('fs');
const path = require('path');
const { matchSlotMs, pairSig, dayKey, tzOffset, schedTime, ID_RE, schedDays } = require('../site/derive.js');
const { writeTournament, slotsOverlap, isRealDate } = require('./tools.js');

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

// Even split into k pools (sizes differ by at most one).
function splitPools(teams, poolSize) {
  const k = Math.ceil(teams.length / poolSize);
  const base = Math.floor(teams.length / k);
  const extra = teams.length % k;
  const pools = [];
  let i = 0;
  for (let p = 0; p < k; p++) {
    const size = base + (p < extra ? 1 : 0);
    pools.push(teams.slice(i, i + size));
    i += size;
  }
  return pools;
}

// Placement sub-bracket for n losers (n teams from one knockout round). Pairs
// best vs worst recursively, producing a full bracket that determines every
// rank in the range. For n=4 QF losers: 2 semis + 5th/6th + 7th/8th = 4 matches.
// fin (bestOf/slotMinutes) is the spec's "final" override; it lands on the
// bronze match only — deeper placement matches use the default knockout config.
function buildPlacement(losers, mid, fin) {
  const n = losers.length;
  if (n === 2) {
    const m = { id: mid(), sides: [losers[0], losers[1]] };
    if (fin.bestOf !== undefined) m.bestOf = fin.bestOf; // fin is always {} or the spec's final object — all callers pass one
    if (fin.slotMinutes !== undefined) m.slotMinutes = fin.slotMinutes;
    return [m];
  }
  // n >= 4: pair best vs worst, then recurse winners (top half) and losers (bottom half)
  const r1 = [];
  const winners = [], losers2 = [];
  for (let i = 0; i < n / 2; i++) {
    const m = { id: mid(), sides: [losers[i], losers[n - 1 - i]] };
    r1.push(m);
    winners.push({ kind: 'match', match: m.id, result: 'winner' });
    losers2.push({ kind: 'match', match: m.id, result: 'loser' });
  }
  return [...r1, ...buildPlacement(winners, mid, fin), ...buildPlacement(losers2, mid, fin)];
}

// Standard S-curve bracket order for seed indices lo..hi (hi-lo+1 a power of
// two): recurse over the top half, pairing each of its seeds against the
// mirror seed (best vs worst) and interleaving the halves. This is the generic
// cross-pairing — it puts seed 1 and seed 2 in opposite halves, 1-4 in
// opposite quarters, and so on, so with k pools the pool winners can only meet
// from round R - ceil(log2 k) + 1 (R = rounds to the final; 2 pools: final
// only, 4 pools: no earlier than the semis).
function sCurve(lo, hi) {
  if (lo === hi) return [lo];
  const half = sCurve(lo, lo + ((hi - lo) >> 1));
  const out = [];
  for (const i of half) out.push(i, lo + hi - i);
  return out;
}

// Single elimination, everyone advances. Strength order = pool winners first,
// then interleaved by rank. The bracket is the standard S-curve draw (see
// sCurve), which pairs best vs worst in round 1 and keeps the top seeds apart
// until late. The top seeds (byes = next power of two minus field size) skip
// round 1. Winners advance, the final takes fin (the spec's per-category
// "final" override: bestOf / slotMinutes) where present. Placement depth is
// controlled by placements (power of 2, default 4 = 3rd/4th play-off;
// 8 adds 5th-8th classification, etc).
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
  // ponytail: with 3+ pools the rank-major interleave can pair two same-pool
  // sides in round 1 (4/3/3 -> A3 vs A4). Fine for v1 events; offset the seed
  // interleave per pool if a seeding-quality pass is ever needed.

  const matches = [];
  const rounds = []; // track every round for placement construction
  const ms1 = [];
  let round = [];
  // Pairs emit in position order, so round 2's adjacent pairing keeps top
  // seeds in opposite halves; the low seed of every pair is real (a low-half
  // index is always < total), so each pair is a match or a top-seed bye.
  for (let j = 0; j < order.length; j += 2) {
    const a = order[j], b = order[j + 1];
    if (b < total) {
      const m = { id: mid(), sides: [seed[a], seed[b]] };
      ms1.push(m);
      matches.push(m);
      round.push({ kind: 'match', match: m.id, result: 'winner' });
    } else {
      round.push(seed[a]); // bye
    }
  }
  rounds.push(ms1);
  // When byes exceed round-1 matches (5/9/10/11-team fields) two byed seeds
  // must meet in round 2 — structurally forced, nothing crashes. Ids come out
  // in chronological order regardless of build order — renumberByTime sorts them.
  while (round.length > 1) {
    const next = [];
    const ms = [];
    for (let i = 0; i < round.length; i += 2) {
      const m = { id: mid(), sides: [round[i], round[i + 1]] };
      ms.push(m);
      next.push({ kind: 'match', match: m.id, result: 'winner' });
    }
    matches.push(...ms);
    rounds.push(ms);
    round = next;
  }

  const finalM = matches[matches.length - 1];
  if (fin.bestOf !== undefined) finalM.bestOf = fin.bestOf;
  if (fin.slotMinutes !== undefined) finalM.slotMinutes = fin.slotMinutes;

  // Build placement matches for each round whose losers' rank range fits within placements.
  // Rounds tracked from first to final: rounds[rounds.length-1] = final (1 match),
  // rounds[rounds.length-2] = semis (2 matches → losers rank 3-4), etc.
  // A round at distance dist from the final has loser range up to 2^(dist+1);
  // only build if that fits within placements (default 4 = bronze only).
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
  const names = pools.map((_, i) => String.fromCharCode(65 + i));
  const matches = [];
  let next = 1;
  const mid = () => next++;

  // Round-major feed: all pools play round r together. Feeding pool-by-pool
  // let early pools hog the courts — idle waves and uneven rest per pool;
  // round-major keeps every team across pools on the same wave grid.
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
// match's floor is its block's start, or the end of its feeders (match slots)
// / its pool's last match (pool slots), so brackets never start before their
// sources. Each match takes the earliest floor-aligned slot with a free court
// and no same-window player double-book (pool matches only — knockout sides
// resolve only after results, so dependency order is the only handle there).
// Occupancy is a start/end window over the match's effective slot length
// (matchSlotMs), matching the validator's overlap rule, so the off-set
// morning/afternoon grids can't collide. Tuples are [cat, teamList, matches] —
// the cat and matches positions only.
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
      const slotMs = matchSlotMs(m, { slotMinutes: catSlots }); // per stage: pools vs knockout
      const players = m.sides.every((s) => s.kind === 'players')
        ? new Set(m.sides.flatMap((s) => s.ids)) : null;
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
          // local wall date + time in the event tz, no offset — the tz in the
          // file interprets it. A fixed eventDate prefix would backdate a slot
          // crossing midnight by 24h, so the day comes from the instant. The
          // wall clock is typed parts with h23, so the ISO_RE contract can't
          // depend on any locale's separator or hour cycle.
          const wall = Object.fromEntries(new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
          m.scheduled = `${dayKey(t, tz)}T${wall.hour}:${wall.minute}:00`;
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

// The greedy's invariants, which validate.js can't see: every match got a slot,
// and no pool match double-books a player. (Knockout sides are unknown until
// results; same-wave knockout matches are structurally disjoint — each feeds
// a different bracket path.)
// results/assertSchedule tuples: [cat, teamList, matches] — only cat and matches used.
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
        players: m.sides.every((s) => s.kind === 'players') ? new Set(m.sides.flatMap((s) => s.ids)) : null,
      });
    }
  }
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j];
      if (a.m.venue === b.m.venue && slotsOverlap(a.t, a.t + a.slotMs, b.t, b.t + b.slotMs)) {
        throw new Error(`${a.m.id} and ${b.m.id} overlap at ${a.m.venue}`);
      }
      if (a.players && b.players && slotsOverlap(a.t, a.t + a.slotMs, b.t, b.t + b.slotMs)) {
        for (const p of a.players) {
          if (b.players.has(p)) throw new Error(`player ${p} double-booked (${a.m.id} ${a.m.scheduled}, ${b.m.id} ${b.m.scheduled})`);
        }
      }
    }
  }
}

// Renumber matches so the file is in chronological order with sequential ids —
// diffs and slot refs stay readable. Instants come from schedTime (the shared
// derivation), never a bare Date.parse — scheduled is wall time, only the
// tournament tz anchors it. Build order is the tie-break for simultaneous
// slots (the same wall time on different courts), free via the stable sort.
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
  // A missing/mistyped field used to crash as a raw TypeError (Object.entries
  // on undefined) instead of a named spec error — same gate, named message.
  if (typeof name !== 'string' || !name) throw new Error(`spec: name must be a non-empty string, got ${JSON.stringify(name)}`);
  if (typeof location !== 'string' || !location.trim()) throw new Error(`spec: location must be a non-empty string, got ${JSON.stringify(location)}`);
  if (typeof timezone !== 'string' || !timezone) throw new Error(`spec: timezone must be a non-empty string, got ${JSON.stringify(timezone)}`);
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
  // The one silent failure the gate can't see: a non-object final (bestOf on a number
  // is undefined) drops the override and still validates. Everything else (bestOf,
  // slotMinutes, final values) lands in the file where validate.js rejects it by name.
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
    // A missing slotMinutes is only a validator warning, yet NaNs every slot
    // window and piles every match on the first court — fail fast instead.
    if (typeof c.bestOf !== 'number' || c.bestOf < 1 || c.bestOf % 2 !== 1) {
      throw new Error(`spec: category ${c.id}: bestOf must be an odd positive integer, got ${JSON.stringify(c.bestOf)}`);
    }
    if (typeof c.slotMinutes !== 'number' || !Number.isInteger(c.slotMinutes) || c.slotMinutes < 1) {
      throw new Error(`spec: category ${c.id}: slotMinutes must be a positive integer, got ${JSON.stringify(c.slotMinutes)}`);
    }
  }

  // ---- skeleton ----
  const catById = new Map(categories.map((c) => [c.id, c]));
  const VENUES = Object.entries(venues).map(([id, vn]) => ({ id, name: vn })); // spec order = court-assignment priority
  const PLAYERS = Object.entries(players).map(([id, pn]) => ({ id, name: pn })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

  const out = {};
  for (const [cat, teamList, ms] of results) {
    assertPoolCoverage(teamList, ms, poolSize);
    renumberByTime(ms, timezone);
    out[cat] = ms;
    console.log(`${cat}: ${ms.length} matches`);
  }

  return { name, location, timezone, venues: VENUES, categories: CATS, players: PLAYERS, matches: out };
}

// CLI entry (dispatched from gb.js): root is the repo root, specPath is
// cwd-relative (run from the repo root: specs/<slug>.json).
function main(root, specPath) {
  if (!specPath) {
    console.error('usage: node gb.js schedule <specs/xxx.json>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
  const tourney = generate(spec);
  const siteRoot = path.join(root, 'site');
  writeTournament(siteRoot, spec.slug, tourney);

  // keep the list page in sync — a tournament the index doesn't know is invisible
  const idxFile = path.join(siteRoot, 'tournaments.json');
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const entry = { slug: spec.slug, name: spec.name, location: spec.location, dates: schedDays(Object.values(tourney.matches).flat(), tourney.timezone) };
  const i = Array.isArray(idx) ? idx.findIndex((t) => t && t.slug === spec.slug) : -1;
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  // keep the index's established one-entry-per-line format — index diffs stay per-tournament
  fs.writeFileSync(idxFile, '[' + idx.map((t) => `\n  ${JSON.stringify(t)}`).join(',') + '\n]\n');

  console.log(`Wrote site/tournaments/${spec.slug}.json — run \`node gb.js validate\` before committing.`);
}

module.exports = { generate, main };
