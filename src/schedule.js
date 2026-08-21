// GitBracket tournament generator — run via `node gb.js schedule specs/<slug>.json`.
//
// Reads a spec (specs/<slug>.json), writes the full site/tournaments/<slug>.json
// from scratch (skeleton + every scheduled match), and keeps the index in
// sync. The spec is the single source for the schedule — the file is
// regenerated wholesale, so structure is never hand-edited; scores and venue
// moves go through the REPL. Seed/format semantics: README (Specs); the
// worked example is specs/2026-mammut60.json.
//
// Run:  node gb.js schedule specs/<slug>.json   # then the pre-commit hook (or `node gb.js validate`) gates it
//
// Rerun after the registration deadline with the final spec.teams; shuffle
// spec.teams before the final run for a fair draw. Regeneration replaces the
// whole matches map (scores included) — run it before results go in, not after.
'use strict';

const fs = require('fs');
const path = require('path');
const { matchSlotMs, pairSig, dayKey, tzOffset, ID_RE } = require('../site/derive.js');
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
  if (n < 2) return [];
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

// Single elimination, everyone advances. Strength order = pool winners first,
// then interleaved by rank (snake). The top seeds (byes = next power of two
// minus field size) skip round 1; the rest pair best vs worst so the strongest
// meet only late. Winners advance, the final takes fin (the spec's per-category
// "final" override: bestOf / slotMinutes) where present. Placement depth is
// controlled by placements (power of 2, default 4 = 3rd/4th play-off;
// 8 adds 5th-8th classification, etc).
function buildKnockout(pools, names, mid, fin, placements) {
  placements = placements || 4;
  const total = pools.reduce((s, p) => s + p.length, 0);
  let M = 1;
  while (M < total) M *= 2;
  const byes = M - total;

  const seed = [];
  const maxRank = Math.max(...pools.map((p) => p.length));
  for (let r = 1; r <= maxRank; r++) {
    for (let i = 0; i < pools.length; i++) {
      if (pools[i].length >= r) seed.push({ kind: 'pool', pool: names[i], rank: r });
    }
  }
  const byeSides = seed.slice(0, byes);
  const rest = seed.slice(byes);
  const r1Sides = [];
  for (let i = 0; i < rest.length / 2; i++) {
    r1Sides.push(rest[i], rest[rest.length - 1 - i]); // best vs worst
  }
  // ponytail: with 3+ pools the rank-major interleave can pair two same-pool
  // sides in round 1 (4/3/3 -> A3 vs A4). Fine for v1 events; offset the seed
  // interleave per pool if a seeding-quality pass is ever needed.

  const matches = [];
  const rounds = []; // track every round for placement construction
  const ms1 = [];
  for (let i = 0; i < r1Sides.length; i += 2) {
    const m = { id: mid(), sides: [r1Sides[i], r1Sides[i + 1]] };
    ms1.push(m);
    matches.push(m);
  }
  rounds.push(ms1);
  const winners = ms1.map((m) => ({ kind: 'match', match: m.id, result: 'winner' }));
  // Round 2 interleaves byes with round-1 winners, spreading byes out. When byes
  // exceed round-1 matches (5/9/10/11-team fields) two byed seeds must meet —
  // structurally forced, nothing crashes.
  let round = [];
  for (let i = 0; i < Math.max(byeSides.length, winners.length); i++) {
    if (i < byeSides.length) round.push(byeSides[i]);
    if (i < winners.length) round.push(winners[i]);
  }
  // Round-2 pairing order: feeder-free pairings first, feeder pairings last. A
  // match with a round-1 winner can't start until round 1 ends, so it always
  // schedules later; building it last keeps id order in sync with time order.
  // Pair contents are unchanged — only their creation (and schedule) order.
  const feedless = [], fed = [];
  for (let i = 0; i < round.length; i += 2) {
    ((round[i].kind === 'match' || round[i + 1].kind === 'match') ? fed : feedless).push(round[i], round[i + 1]);
  }
  round = feedless.concat(fed);

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

  pools.forEach((pool, p) => {
    for (const [a, b] of roundRobin(pool).flat()) {
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

  const doKo = (pools.length > 1 || cat.knockout === true);
  if (doKo && cat.knockout !== false) {
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
// morning/afternoon grids can't collide.
function scheduleMatches(categories, venues, tz, slotCfgOf, eventDate, blockStart) {
  if (venues.length === 0) throw new Error('spec: venues must be a non-empty id -> name map');
  const offset = tzOffset(tz, eventDate);
  const startOf = (cat) => Date.parse(`${eventDate}T${blockStart[cat]}:00${offset}`);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const courtUse = new Map(); // venue -> [{ start, end }]
  const playerUse = []; // { start, end, players: Set }
  const endOf = new Map(); // match id -> end ms (feeder floor)
  const poolDone = new Map(); // pool -> end ms (pool-slot floor)

  for (const [cat, matches] of categories) {
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
          // crossing midnight by 24h, so the day comes from the instant.
          m.scheduled = `${dayKey(t, tz)}T${fmt.format(new Date(t))}:00`;
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
function assertSchedule(categories, slotCfgOf) {
  const sched = []; // { m, t, players }
  for (const [cat, matches] of categories) {
    const catSlots = slotCfgOf.get(cat);
    for (const m of matches) {
      if (!m.scheduled || !m.venue) throw new Error(`match ${m.id} never got a slot`);
      sched.push({
        m,
        t: Date.parse(m.scheduled),
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
  const { slug, name, timezone, date: eventDate, poolSize, blocks: blockStart, venues, players, categories, teams } = spec;

  // ---- spec surface (fail fast; the gate below would catch most of these too) ----
  if (typeof slug !== 'string' || !ID_RE.test(slug)) throw new Error(`spec: slug ${JSON.stringify(slug)} must match ${ID_RE}`);
  if (!Number.isInteger(poolSize) || poolSize < 2) throw new Error(`spec: poolSize must be an integer >= 2, got ${JSON.stringify(poolSize)}`);
  // A missing/mistyped field used to crash as a raw TypeError (Object.entries
  // on undefined) instead of a named spec error — same gate, named message.
  if (typeof name !== 'string' || !name) throw new Error(`spec: name must be a non-empty string, got ${JSON.stringify(name)}`);
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
  const catsWithMatches = results.map(([cat, , ms]) => [cat, ms]);
  const slotCfgOf = new Map(CATS.map((c) => [c.id, c.slotMinutes]));
  scheduleMatches(catsWithMatches, VENUES.map((v) => v.id), timezone, slotCfgOf, eventDate, blockStart);
  assertSchedule(catsWithMatches, slotCfgOf);

  const out = {};
  for (const [cat, teamList, ms] of results) {
    assertPoolCoverage(teamList, ms, poolSize);
    out[cat] = ms;
    console.log(`${cat}: ${ms.length} matches`);
  }

  return { name, timezone, venues: VENUES, categories: CATS, players: PLAYERS, matches: out };
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
  const entry = { slug: spec.slug, name: spec.name };
  const i = Array.isArray(idx) ? idx.findIndex((t) => t && t.slug === spec.slug) : -1;
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  // keep the index's established one-entry-per-line format — index diffs stay per-tournament
  fs.writeFileSync(idxFile, '[' + idx.map((t) => `\n  ${JSON.stringify(t)}`).join(',') + '\n]\n');

  console.log(`Wrote site/tournaments/${spec.slug}.json — run \`node gb.js validate\` before committing.`);
}

module.exports = { generate, main, buildKnockout };
