#!/usr/bin/env node
// Mammut Open 60+ match generator.
//
// Reads TEAMS (pairs of player ids, registration order) and writes the three
// tournaments/2026-mammut60/matches/*.json files: round-robin pools of up to
// POOL_SIZE, then a single-elimination knockout everyone advances into. Every
// match also gets a venue and start time: md/wd share the morning courts from
// 09:00, xd plays the afternoon from 13:00, in per-category slot-length steps. The
// strongest seeds (pool winners first) take the byes that round the field up
// to a power of two; the rest pair best vs worst across pools in round 1 — for
// two pools of three: A2 vs B3, A3 vs B2, with A1 and B1 byed. Winners
// advance, semifinal losers play for 3rd place. Final and 3rd-place game are
// best-of-3 ("2 Gewinnsätze"), everything else best-of-1, per the event page.
//
// Run:  node schedule.js   # then the pre-commit hook (or `node validate.js`) gates it
//
// Registration is open until 26 Sep 2026 — rerun after the deadline with the
// final TEAMS. Pools are drawn in list order; shuffle TEAMS before the final
// run for a fair draw. Incomplete registrations (partner open) stay out until
// the pair is complete.
'use strict';

const fs = require('fs');
const path = require('path');
const { matchSlotMs, slotsOverlap, pairSig } = require('./app.js'); // per-category/per-match slot lengths live in tournament.json

const SLUG = '2026-mammut60';
const POOL_SIZE = 4; // max teams per pool; leftovers spill into a smaller pool
const EVENT_DATE = '2026-09-27'; // tournament day — set the real date before the final run (registration closes Sat 26 Sep 2026)
const BLOCK_START = { md: '09:00', wd: '09:00', xd: '13:00' }; // morning: md+wd; afternoon: xd
// ponytail: 13 morning matches run 09:00–12:30 in 30-min slots (md final/bronze
// are best-of-3, 60 min), so a morning finalist who also plays xd has a 30-min
// turnaround before xd starts at 13:00. Stretch a lunch break there if needed.

// Player ids must exist in tournaments/<SLUG>/tournament.json.
const TEAMS = {
  md: [
    ['charles', 'beni'],
    ['hase', 'patrick'],
    ['matthias', 'hanspeter'],
    ['koni', 'otto'],
    ['reto', 'charly'],
    ['kurt', 'tom'],
  ],
  wd: [
    ['doris', 'nicole'],
    ['karin', 'eveline'],
  ],
  xd: [
    ['doris', 'matthias'],
    ['karin', 'hase'],
    ['nicole', 'kurt'],
    ['patrick', 'nelly'],
    ['otto', 'elke'],
  ],
};

// Round-robin pairings, circle method: array of rounds, each a list of pairs.
function roundRobin(teams) {
  const list = teams.length % 2 ? teams.concat([null]) : teams.slice(); // null = bye
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
function splitPools(teams) {
  const k = Math.ceil(teams.length / POOL_SIZE);
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

// Single elimination, everyone advances. Strength order = pool winners first,
// then interleaved by rank (snake). The top seeds (byes = next power of two
// minus field size) skip round 1; the rest pair best vs worst so the strongest
// meet only late. Winners advance, semifinal losers play for 3rd place.
function buildKnockout(pools, names, mid) {
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

  // Round 1: best vs worst among the non-byed seeds.
  const matches = [];
  const ms1 = [];
  for (let i = 0; i < r1Sides.length; i += 2) {
    const m = { id: mid(), sides: [r1Sides[i], r1Sides[i + 1]] };
    ms1.push(m);
    matches.push(m);
  }
  const winners = ms1.map((m) => ({ kind: 'match', match: m.id, result: 'winner' }));
  // Round 2 interleaves byes with round-1 winners, spreading byes out. When byes
  // exceed round-1 matches (5/9/10/11-team fields) two byed seeds must meet —
  // structurally forced, nothing crashes.
  let semis = ms1.length === 2 ? ms1 : null; // the round feeding the final, for the bronze match
  let round = [];
  for (let i = 0; i < Math.max(byeSides.length, winners.length); i++) {
    if (i < byeSides.length) round.push(byeSides[i]);
    if (i < winners.length) round.push(winners[i]);
  }

  while (round.length > 1) {
    const next = [];
    const ms = [];
    for (let i = 0; i < round.length; i += 2) {
      const m = { id: mid(), sides: [round[i], round[i + 1]] };
      ms.push(m);
      next.push({ kind: 'match', match: m.id, result: 'winner' });
    }
    matches.push(...ms);
    if (ms.length === 2) semis = ms; // the round feeding the final
    round = next;
  }

  matches[matches.length - 1].bestOf = 3; // final — best-of-3 overrides get an hour-long slot too
  matches[matches.length - 1].slotMinutes = 60;
  matches.push({
    id: mid(),
    bestOf: 3,
    slotMinutes: 60,
    sides: [
      { kind: 'match', match: semis[0].id, result: 'loser' },
      { kind: 'match', match: semis[1].id, result: 'loser' },
    ],
  });

  if (matches.length !== total) {
    throw new Error(`knockout: ${matches.length} matches, expected ${total}`);
  }
  return matches;
}

function buildCategory(teams) {
  const pools = splitPools(teams);
  const names = pools.map((_, i) => String.fromCharCode(65 + i));
  const matches = [];
  let next = 1;
  const mid = () => 'm' + next++;

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

  if (pools.length > 1) matches.push(...buildKnockout(pools, names, mid));
  return matches;
}

// ---------- scheduling ----------

// IANA tz -> "+02:00"-style offset on EVENT_DATE (Europe/Zurich in Sep is CEST).
function tzOffset(tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(EVENT_DATE + 'T12:00:00Z')).find((x) => x.type === 'timeZoneName');
  return p && p.value !== 'GMT' ? p.value.replace('GMT', '') : '+00:00';
}

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
function scheduleMatches(categories, venues, tz, slotCfgOf) {
  if (venues.length === 0) throw new Error('no venues in tournament.json');
  const offset = tzOffset(tz);
  const startOf = (cat) => Date.parse(`${EVENT_DATE}T${BLOCK_START[cat]}:00${offset}`);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const courtUse = new Map(); // venue -> [{ start, end }]
  const playerUse = []; // { start, end, players: Set }
  const endOf = new Map(); // match id -> end ms (feeder floor)
  const poolDone = new Map(); // pool -> end ms (pool-slot floor)

  for (const [cat, matches] of categories) {
    const start = startOf(cat);
    if (Number.isNaN(start)) throw new Error(`no BLOCK_START for category ${cat}`);
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
          // local date + time from the event tz — a fixed EVENT_DATE prefix would
          // backdate a slot crossing midnight by 24h
          m.scheduled = `${dayFmt.format(new Date(t))}T${fmt.format(new Date(t))}:00${offset}`;
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
function assertPoolCoverage(teams, matches, names) {
  splitPools(teams).forEach((pool, p) => {
    const pairs = matches
      .filter((m) => m.pool === names[p])
      .map((m) =>
        m.sides
          .map((s) => pairSig(s.ids))
          .sort()
          .join(' ~ ')
      );
    const want = (pool.length * (pool.length - 1)) / 2;
    if (new Set(pairs).size !== want) {
      throw new Error(`pool ${names[p]}: ${new Set(pairs).size}/${want} pairings`);
    }
  });
}

function main() {
  const tourney = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'tournaments', SLUG, 'tournament.json'), 'utf8')
  );
  const known = new Set(tourney.players.map((p) => p.id));
  for (const [cat, teams] of Object.entries(TEAMS)) {
    for (const ids of teams) for (const id of ids) {
      if (!known.has(id)) throw new Error(`TEAMS.${cat}: player ${id} not in tournaments/${SLUG}/tournament.json`);
    }
  }
  const dir = path.join(__dirname, 'tournaments', SLUG, 'matches');
  fs.mkdirSync(dir, { recursive: true });

  const results = [];
  for (const [cat, teams] of Object.entries(TEAMS)) {
    if (teams.length < 2) {
      console.log(`${cat}: skipped (${teams.length} team)`);
      continue;
    }
    results.push([cat, teams, buildCategory(teams)]);
  }
  const categories = results.map(([cat, , matches]) => [cat, matches]);
  const slotCfgOf = new Map(tourney.categories.map(c => [c.id, c.slotMinutes]));
  scheduleMatches(categories, tourney.venues.map((v) => v.id), tourney.timezone, slotCfgOf);
  assertSchedule(categories, slotCfgOf);

  for (const [cat, teams, matches] of results) {
    assertPoolCoverage(teams, matches, teams.map((_, i) => String.fromCharCode(65 + i)));
    fs.writeFileSync(path.join(dir, cat + '.json'), JSON.stringify({ matches }, null, 2) + '\n');
    console.log(`${cat}: ${matches.length} matches -> ${cat}.json`);
  }
  console.log('Wrote tournaments/' + SLUG + '/matches/*.json — run `node validate.js` before committing.');
}

if (require.main === module) main();
