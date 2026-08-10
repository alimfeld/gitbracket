'use strict';
// schedule.js — spec-driven generation. A minimal spec must produce a valid
// tournament: the strongest single assertion is running the real validator
// over the generated file in memory (same gate the pre-commit hook runs).

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../schedule.js');
const { validateRepo } = require('../validate.js');

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
      matches: new Map(Object.entries(tourney.matches).map(([cid, ms]) => [cid, { matches: ms }])),
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
});
