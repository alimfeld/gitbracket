'use strict';
// schedule.js — spec-driven generation. A minimal spec must produce a valid
// tournament: the strongest single assertion is running the real validator
// over the generated file in memory (same gate the pre-commit hook runs).

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../src/schedule.js');
const { validateRepo } = require('../src/validate.js');

const MINI = {
  slug: 'mini',
  name: 'Mini Open',
  timezone: 'Europe/Zurich',
  date: '2026-05-02',
  poolSize: 4,
  blocks: { md: '09:00', xd: '13:00' },
  venues: { 'court-1': 'Court 1', 'court-2': 'Court 2' },
  players: { ada: 'Ada', ben: 'Ben', cid: 'Cid', dan: 'Dan', eve: 'Eve', fin: 'Fin', gus: 'Gus', huw: 'Huw', ida: 'Ida', jan: 'Jan', kim: 'Kim' },
  categories: [
    { id: 'md', name: 'Men', bestOf: 1, slotMinutes: 30, final: { bestOf: 3, slotMinutes: 60 } },
    { id: 'xd', name: 'Mixed', bestOf: 1, slotMinutes: 30 },
  ],
  // md: 5 teams -> 2 pools (3+2), knockout + bronze. xd: 2 teams -> 1 pool, no knockout.
  teams: {
    md: [['ada', 'ben'], ['cid', 'dan'], ['eve', 'fin'], ['gus', 'huw'], ['ida', 'jan']],
    xd: [['ada', 'cid'], ['ben', 'eve']],
  },
};

function repoOf(tourney) {
  return {
    readErrs: [],
    index: [{ slug: 'mini', name: 'Mini Open' }],
    tournaments: new Map([['mini', {
      tjson: tourney,
      matches: new Map(Object.entries(tourney.matches)),
    }]]),
  };
}

test('a minimal spec generates a valid tournament', () => {
  const tourney = generate(MINI);
  const { errs } = validateRepo(repoOf(tourney));
  assert.deepEqual(errs, []);
  // shape: md = 3+1 pool matches + 5 knockout (incl. bronze) = 9; xd = 1
  assert.equal(tourney.matches.md.length, 9);
  assert.equal(tourney.matches.xd.length, 1);
  assert.ok(tourney.matches.md.every((m) => m.venue && m.scheduled));
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
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], bestOf: 2 }] }), /bestOf/);
  assert.throws(() => generate({ ...MINI, categories: [{ ...MINI.categories[0], bestOf: undefined }] }), /bestOf/);
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
  assert.throws(() => generate({ ...MINI, timezone: undefined }), /timezone must be a non-empty string/);
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

test('knockout false + placements silently ignores placements', () => {
  const spec = {
    ...MINI,
    categories: [{ ...MINI.categories[0], knockout: false, placements: 8 }],
    teams: { md: MINI.teams.md }, // no xd — categories only has md
  };
  const tourney = generate(spec);
  const idx = { slug: 'mini', name: 'Mini Open' };
  const { errs } = validateRepo({
    readErrs: [],
    index: [idx],
    tournaments: new Map([['mini', { tjson: tourney, matches: new Map([['md', tourney.matches.md]]) }]]),
  });
  assert.deepEqual(errs, []);
  // No knockout — placements is irrelevant
  assert.equal(tourney.matches.md.length, 4);
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
