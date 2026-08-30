'use strict';
// schedule.js — spec-driven generation. A minimal spec must produce a valid
// tournament: the strongest single assertion is running the real validator
// over the generated file in memory (same gate the pre-commit hook runs).

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../src/schedule.js');
const { validateRepo } = require('../src/validate.js');
const { matchSlotMs, schedDays } = require('../site/derive.js');
const { MINI } = require('./helpers.js');

function repoOf(tourney) {
  return {
    readErrs: [],
    index: [{ slug: 'mini', name: 'Mini Open', location: tourney.location, dates: schedDays(Object.values(tourney.matches).flat(), tourney.timezone) }],
    tournaments: new Map([['mini', { tjson: tourney }]]),
  };
}

// Consecutive group matches with no rest slot between them, per team — the
// back-to-back burden the group stage must spread evenly.
function backToBacks(tourney, catId) {
  const cat = tourney.categories.find((c) => c.id === catId);
  const groups = tourney.matches[catId].filter((x) => x.pool !== undefined);
  const slotMs = matchSlotMs(groups[0], { slotMinutes: cat.slotMinutes });
  const tt = {};
  for (const m of groups) {
    for (const s of m.sides) for (const id of s.ids) {
      (tt[id] = tt[id] || []).push(Date.parse(m.scheduled));
    }
  }
  const counts = [];
  for (const list of Object.values(tt)) {
    list.sort((a, b) => a - b);
    let b2b = 0;
    for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] === slotMs) b2b++;
    counts.push(b2b);
  }
  return counts;
}

test('a minimal spec generates a valid tournament', () => {
  const tourney = generate(MINI);
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // shape: md = 3+1 pool matches + 5 knockout (incl. bronze) = 9; xd = 1
  assert.equal(tourney.matches.md.length, 9);
  assert.equal(tourney.matches.xd.length, 1);
  assert.ok(tourney.matches.md.every((m) => m.venue && m.scheduled));
  assert.equal(tourney.location, 'Zurich');
});

test('the final override lands on the final and bronze match only', () => {
  const md = generate(MINI).matches.md;
  const finalM = md[md.length - 2], bronze = md[md.length - 1];
  assert.equal(finalM.bestOf, 3);
  assert.equal(finalM.slotMinutes, 60);
  assert.equal(bronze.bestOf, 3);
  assert.equal(bronze.slotMinutes, 60);
  assert.ok(md.slice(0, -2).every((m) => m.bestOf === undefined && m.slotMinutes === undefined));
  // xd has no final override and no knockout — nothing carries overrides
  assert.ok(generate(MINI).matches.xd.every((m) => m.bestOf === undefined && m.slotMinutes === undefined));
});

test('spec guards reject bad input fast', () => {
  assert.throws(() => generate({ ...MINI, poolSize: 1 }), /poolSize/);
  assert.throws(() => generate({ ...MINI, date: '2026-02-30' }), /not a real calendar date/);
  assert.throws(() => generate({ ...MINI, teams: { md: MINI.teams.md, nope: [] } }), /undeclared category/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], final: 3 }] }), /final/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], knockout: 'yes' }] }), /knockout/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], placements: 3 }] }), /placements/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], placements: 0 }] }), /placements/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], placements: -2 }] }), /placements/);
  // a missing slotMinutes used to pile every match on the first court at the
  // block start, and pass the gate on a warning
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], bestOf: 2 }, MINI.categories[1]] }), /bestOf/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], bestOf: undefined }, MINI.categories[1]] }), /bestOf/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], slotMinutes: 0 }] }), /slotMinutes/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], slotMinutes: '30' }] }), /slotMinutes/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], slotMinutes: undefined }] }), /slotMinutes/);
  // missing/mistyped spec surface fails as a named spec error, not a TypeError
  assert.throws(() => generate({ ...MINI, venues: undefined }), /venues must be an id -> value map/);
  assert.throws(() => generate({ ...MINI, players: [] }), /players must be an id -> value map/);
  assert.throws(() => generate({ ...MINI, teams: undefined }), /teams must be an id -> value map/);
  assert.throws(() => generate({ ...MINI, blocks: undefined }), /blocks must be an id -> value map/);
  assert.throws(() => generate({ ...MINI, categories: 'oops' }), /categories must be an array/);
  assert.throws(() => generate({ ...MINI, name: undefined }), /name must be a non-empty string/);
  assert.throws(() => generate({ ...MINI, location: '' }), /location must be a non-empty string/);
  assert.throws(() => generate({ ...MINI, timezone: undefined }), /timezone required/);
});

test('knockout: false skips the knockout phase for a multi-pool category', () => {
  const cats = [{ ...MINI.categories[0], knockout: false }, MINI.categories[1]];
  const tourney = generate({ ...MINI, categories: cats });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // md: 5 teams, 2 pools (3+2) → only pool matches (3+1 = 4), no knockout
  assert.equal(tourney.matches.md.length, 4);
  assert.ok(tourney.matches.md.every((m) => m.pool !== undefined), 'every md match has a pool');
});

test('knockout: true enables knockout for a single-pool category', () => {
  // Use a 4-team single pool — would normally have no knockout
  const cats = [MINI.categories[0], { ...MINI.categories[1], knockout: true }];
  const teams = {
    md: MINI.teams.md, // 5 teams, 2 pools → knockout already on by default
    xd: [['ada', 'ben'], ['cid', 'dan'], ['eve', 'fin'], ['gus', 'huw']], // 4 teams, 1 pool
  };
  const tourney = generate({ ...MINI, categories: cats, teams });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // xd: 4 teams, 1 pool → 6 pool matches + 4 knockout (2 R1 + 1 SF + 1 bronze) = 10
  assert.equal(tourney.matches.xd.length, 10);
  const ko = tourney.matches.xd.filter((m) => m.pool === undefined);
  assert.equal(ko.length, 4);
});

test('knockout: false on single pool is equivalent to omitted', () => {
  const cats = [MINI.categories[0], { ...MINI.categories[1], knockout: false }];
  const tourney = generate({ ...MINI, categories: cats });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // xd: 2 teams, 1 pool, knockout: false → 1 pool match, no knockout
  assert.equal(tourney.matches.xd.length, 1);
});

test('placements: 2 suppresses the bronze match, final only', () => {
  const cats = [{ ...MINI.categories[0], placements: 2 }, MINI.categories[1]];
  const tourney = generate({ ...MINI, categories: cats });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // md: 5 teams → 4 pool + 4 main bracket, no bronze = 8
  assert.equal(tourney.matches.md.length, 8);
  const ko = tourney.matches.md.filter((m) => m.pool === undefined);
  assert.equal(ko.length, 4);
  // no loser-of-semis match (the bronze)
  assert.ok(ko.every((m) => m.sides.every((s) => s.kind !== 'match' || s.result !== 'loser')), 'no match-within-round loser edge in knockout');
});

test('placements: 8 builds 5th-8th classification', () => {
  // 8 distinct pairings for 8 teams
  const mdTeams = [];
  const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  for (let i = 0; i < 8; i++) mdTeams.push([players[i]]);
  const spec = {
    ...MINI,
    players: Object.fromEntries(players.map((p) => [p, p.toUpperCase()])),
    categories: [{ ...MINI.categories[0], placements: 8 }],
    teams: { md: mdTeams },
  };
  const tourney = generate(spec);
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // md: 8 teams, 2 pools of 4 → 12 pool + 7 main bracket + 1 bronze + 4 placement = 24
  assert.equal(tourney.matches.md.length, 24);
  const ko = tourney.matches.md.filter((m) => m.pool === undefined);
  assert.equal(ko.length, 12); // 7 + 1 + 4
  // Should have loser-of-match edges deeper than semis (QF losers)
  const loserEdges = ko.filter((m) => m.sides.some((s) => s.kind === 'match' && s.result === 'loser'));
  assert.ok(loserEdges.length > 1, 'multiple placement matches with loser edges');
});

test('knockout with byes: odd loser pools build no self-matches (R1 losers from a partial round)', () => {
  // Single-pool knockout where total < next power of two: round 1 has byes, so
  // its loser pool is not a power of two (3 teams: 1 loser; 7 teams: 3 losers).
  // Used to recurse forever pairing a lone loser against itself — the bracket
  // must degrade gracefully: rank implied for a single loser, and a proper
  // 2-match classification for three.
  const mk = (n, extra) => ({
    ...MINI,
    poolSize: n,
    players: Object.fromEntries(Array.from({ length: n }, (_, i) => ['t' + (i + 1), 'T' + (i + 1)])),
    teams: { md: Array.from({ length: n }, (_, i) => ['t' + (i + 1)]) },
    categories: [{ ...MINI.categories[0], knockout: true, ...extra }],
  });
  for (const [n, extra, koCount] of [[3, {}, 2], [7, { placements: 8 }, 9]]) {
    const tourney = generate(mk(n, extra));
    const { errs } = validateRepo(repoOf(tourney));
    assert.deepEqual(errs, []);
    const ko = tourney.matches.md.filter((m) => m.pool === undefined);
    assert.equal(ko.length, koCount, `${n} teams: knockout match count`);
    // no match may reference itself as a side — the old self-pair bug
    for (const m of ko) for (const s of m.sides) {
      assert.ok(!(s.kind === 'match' && s.match === m.id), `${m.id} references itself`);
    }
  }
});

test('knockout false + placements silently ignores placements', () => {
  const spec = {
    ...MINI,
    categories: [{ ...MINI.categories[0], knockout: false, placements: 8 }],
    teams: { md: MINI.teams.md }, // no xd — categories only has md
  };
  const tourney = generate(spec);
  const idx = { slug: 'mini', name: 'Mini Open', location: tourney.location, dates: schedDays(Object.values(tourney.matches).flat(), tourney.timezone) };
  const { errs } = validateRepo({
    readErrs: [],
    index: [idx],
    tournaments: new Map([['mini', { tjson: tourney }]]),
  });
  assert.deepEqual(errs, []);
  // No knockout — placements is irrelevant
  assert.equal(tourney.matches.md.length, 4);
});

test('knockout cross-pairs pool winners: they can only meet deep in the bracket', () => {
  // The S-curve draw: with k pools, two pool winners can meet no earlier than
  // round R - ceil(log2 k) + 1 (R = rounds to the final; 2 pools of 4: the
  // final only; 3 pools: no earlier than the semis).
  for (const [pools, size] of [[2, 4], [3, 4], [4, 4]]) {
    const players = {};
    const mdTeams = [];
    for (let p = 0; p < pools; p++) {
      for (let i = 1; i <= size; i++) {
        const id = `${String.fromCharCode(65 + p)}${i}`.toLowerCase();
        players[id] = id.toUpperCase();
        mdTeams.push([id]);
      }
    }
    const tourney = generate({ ...MINI, players, teams: { md: mdTeams } });
    const { errs } = validateRepo(repoOf(tourney));
    assert.deepEqual(errs, []);
    const earliest = Math.ceil(Math.log2(pools * size)) - Math.ceil(Math.log2(pools)) + 1;
    // Walk the bracket from the leaves, tracking which pool winners (rank-1
    // sides) can reach each match and the match's round (1 = first knockout
    // round); assert none meet before `earliest`. Children precede parents in
    // the matches array.
    const reach = new Map();
    const roundOf = new Map();
    for (const m of tourney.matches.md) {
      let round = 1;
      const winners = new Set();
      for (const s of m.sides) {
        if (s.kind === 'pool' && s.rank === 1) winners.add(s.pool);
        else if (s.kind === 'match') {
          for (const p of reach.get(s.match)) winners.add(p);
          round = Math.max(round, roundOf.get(s.match) + 1);
        }
      }
      reach.set(m.id, winners);
      roundOf.set(m.id, round);
      const ws = [...winners].sort();
      for (let i = 0; i < ws.length; i++) {
        for (let j = i + 1; j < ws.length; j++) {
          assert.ok(round >= earliest,
            `${pools}x${size}: pool winners ${ws[i]}1 and ${ws[j]}1 can meet in round ${round}, earliest allowed ${earliest}`);
        }
      }
    }
  }
});

test('knockout round 1 never pairs two teams from the same pool', () => {
  // 11 teams at poolSize 4 split 4/4/3 — the rank-major interleave used to put
  // the big pool's ranks 3 and 4 across a mirror pair (A3 vs A4 in round 1).
  const players = {};
  const md = [];
  for (let i = 1; i <= 11; i++) { players['p' + i] = 'P' + i; md.push(['p' + i]); }
  const tourney = generate({ ...MINI, players, teams: { md } });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // direct-pool matches: true round 1 plus the round-2 match where two byed
  // seeds must meet (11 teams, 3 byes) — every one must be cross-pool
  const r1 = tourney.matches.md.filter((m) => m.pool === undefined && m.sides.every((s) => s && s.kind === 'pool'));
  assert.ok(r1.length >= 3, 'an 11-team bracket has round-1 matches');
  for (const m of r1) assert.notEqual(m.sides[0].pool, m.sides[1].pool, `${m.sides[0].pool}${m.sides[0].rank} meets ${m.sides[1].pool}${m.sides[1].rank} in round 1`);
});

test('group stage: an even pool packs tight and hands every team the same back-to-back burden', () => {
  // a 4-team pool on 2 courts: 6 matches, 2 per round — every team plays at
  // the same consecutive waves; no team can get more or less rest than another
  const players = {}; const teams = [];
  for (let i = 0; i < 4; i++) { players['t' + (i + 1)] = 'T' + (i + 1); teams.push(['t' + (i + 1)]); }
  const tourney = generate({ ...MINI, poolSize: 4, players, teams: { md: teams } });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  const groups = tourney.matches.md.filter((m) => m.pool !== undefined);
  assert.equal(groups.length, 6);
  const slot = matchSlotMs(groups[0], { slotMinutes: MINI.categories[0].slotMinutes });
  // 6 matches on 2 courts pack into exactly 3 tight waves — no idle slot
  assert.equal(Date.parse(groups.at(-1).scheduled) + slot - Date.parse(groups[0].scheduled), 3 * slot);
  const counts = backToBacks(tourney, 'md');
  assert.equal(Math.min(...counts), Math.max(...counts),
    'every team carries the same back-to-back count (no one penalized more)');
  assert.ok(counts[0] > 0, 'tight but every team actually plays back-to-back');
});

test('group stage: multi-pool rounds pack tight and spread back-to-backs evenly', () => {
  // two pools of 7 on 5 courts — the case pool-by-pool feeding got wrong:
  // pool A hogged the early waves, so the pack lost tightness and rest
  // differed per pool. Round-major feeding must stay tight and keep every
  // team's back-to-back count within one of any other's.
  const players = {}; const teams = [];
  for (let i = 0; i < 14; i++) { players['t' + (i + 1)] = 'T' + (i + 1); teams.push(['t' + (i + 1)]); }
  const tourney = generate({
    ...MINI,
    poolSize: 7,
    venues: { 'court-1': 'C1', 'court-2': 'C2', 'court-3': 'C3', 'court-4': 'C4', 'court-5': 'C5' },
    players,
    teams: { md: teams },
  });
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  const groups = tourney.matches.md.filter((m) => m.pool !== undefined);
  assert.equal(groups.length, 42);
  const slot = matchSlotMs(groups[0], { slotMinutes: MINI.categories[0].slotMinutes });
  // 42 matches on 5 courts pack into exactly 9 tight waves — no idle wave
  assert.equal(Date.parse(groups.at(-1).scheduled) + slot - Date.parse(groups[0].scheduled), 9 * slot);
  const counts = backToBacks(tourney, 'md');
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
    `back-to-back counts spread by more than one: ${[...new Set(counts)].sort((a, b) => a - b).join(', ')}`);
});

test('match ids follow chronological order; slot refs stay valid after renumbering', () => {
  const tourney = generate(MINI);
  for (const ms of Object.values(tourney.matches)) {
    for (let i = 1; i < ms.length; i++) {
      assert(Date.parse(ms[i - 1].scheduled) <= Date.parse(ms[i].scheduled),
        `match ${ms[i].id} (${ms[i].scheduled}) scheduled before ${ms[i - 1].id} (${ms[i - 1].scheduled})`);
    }
    assert.equal(ms[0].id, 1);
    assert.equal(new Set(ms.map((m) => m.id)).size, ms.length, 'ids remain unique');
    for (const m of ms) {
      for (const s of m.sides) {
        if (s && s.kind === 'match') {
          assert(ms.some((x) => x.id === s.match), `slot ref ${s.match} resolves to a match in the category`);
        }
      }
    }
  }
});
