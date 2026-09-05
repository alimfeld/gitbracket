'use strict';
// sim.js — the pure engine. A full play-through of a generated tournament is
// the strongest check: if the random games, the dependency ordering, or the
// wave rule ever broke the model, the real validator (the same gate
// writeEdit and the pre-commit hook run) complains at the end.

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../src/schedule.js');
const { validateRepo } = require('../src/validate.js');
const { applyScore, waveEntries } = require('../src/editor.js');
const { makeCat, isDone, countWins, bestOfOf, schedDays, resolveSide } = require('../site/derive.js');
const { makeGames, xTargets } = require('../src/sim.js');
const { MINI } = require('./helpers.js');

// The play-through scores wave after wave — exactly the set the editor
// highlights and sim's x scores: unplayed matches with resolved sides at each
// category's earliest scheduled time, one pass per wave.
// x's targets are the scoreable wave — narrowed by an active filter to the
// highlighted rows, so sim's x only touches what's on screen.
test('xTargets: a live filter narrows the wave to the highlighted rows', () => {
  const tourney = generate(MINI);
  const wave = waveEntries(tourney);
  assert.ok(wave.length >= 2, 'the opening wave has several matches');
  const keep = wave.slice(0, 1).map(e => ({ r: e, i: 0 }));
  const targets = xTargets(tourney, { query: 'x', filtered: keep });
  assert.deepStrictEqual(targets.map(e => e.m.id), keep.map(e => e.r.m.id), 'only the highlighted wave member is scored');
  assert.equal(xTargets(tourney, null).length, wave.length, 'no view = the whole wave');
  assert.equal(xTargets(tourney, { query: null, filtered: [] }).length, wave.length, 'no query = the whole wave');
  assert.equal(xTargets(tourney, { query: 'zzz', filtered: [] }).length, 0, 'a filter that hides the wave scores nothing');
});

test('a play-through ends complete and validates clean', () => {
  const tourney = generate(MINI);
  const tz = tourney.timezone;
  const ctxOf = cid => makeCat({ meta: tourney.categories.find(c => c.id === cid), matches: tourney.matches[cid] }, tourney);
  const all = Object.values(tourney.matches).flat();
  let rounds = 0;
  while (true) {
    const wave = waveEntries(tourney);
    if (!wave.length) break;
    // every round scores at least one match — a stalled engine hits the bound
    // as a failure, not a hang
    assert.ok(++rounds <= all.length, `the wave must advance every round (stalled at ${rounds})`);
    for (const e of wave) {
      assert.ok(!isDone(e.m) && e.m.sides.every(s => resolveSide(s, e.ctx)),
        `${e.cat} ${e.m.id}: wave members are unplayed with resolved sides`);
      applyScore(tourney.matches[e.cat], e.m.id, makeGames(bestOfOf(e.m, e.ctx)), e.ctx);
    }
  }
  const repo = {
    readErrs: [],
    index: [{ slug: 'mini', name: 'Mini Open', location: 'Zurich', dates: schedDays(all, tz) }],
    tournaments: new Map([['mini', { tjson: tourney }]]),
  };
  const { errs } = validateRepo(repo);
  assert.deepStrictEqual(errs, []);
  assert.ok(all.length > 0, 'the day is not empty');
  // Random best-of-1 pool scores can end a pool in an outright tie; the model
  // renders those slots TBD (dead tie), so a tied bracket legitimately stops.
  // The engine contract: nothing with resolved sides is left unplayed.
  for (const cid of Object.keys(tourney.matches)) {
    const ctx = ctxOf(cid);
    for (const m of tourney.matches[cid]) {
      if (!isDone(m)) {
        const resolved = Array.isArray(m.sides) && m.sides.length === 2 &&
          m.sides.every(s => resolveSide(s, ctx));
        assert.ok(!resolved, `${cid} ${m.id}: a playable match was left unplayed`);
        continue;
      }
      const b = bestOfOf(m, ctx);
      assert.ok(m.games.length >= (b + 1) / 2 && m.games.length <= b, `${cid} ${m.id}: ${m.games.length} games within best of ${b}`);
      assert.ok(Math.max(...countWins(m.games)) === (b + 1) / 2, `${cid} ${m.id}: winner reached the target`);
    }
  }
});