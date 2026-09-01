'use strict';
// sim.js — the pure engine. A full play-through of a generated tournament is
// the strongest check: if the random games, the dependency ordering, or the
// scorable rule ever broke the model, the real validator (the same gate
// writeEdit and the pre-commit hook run) complains at the end.

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../src/schedule.js');
const { validateRepo } = require('../src/validate.js');
const { applyScore } = require('../src/repl.js');
const { makeCat, isDone, countWins, bestOfOf, schedTime, schedDays, resolveSide } = require('../site/derive.js');
const { makeGames, planScorable, STEP } = require('../src/sim.js');
const { MINI } = require('./helpers.js');

test('the scorable list holds at most one match per venue', () => {
  const tourney = generate(MINI);
  const tz = tourney.timezone;
  const times = Object.values(tourney.matches).flat().map(m => schedTime(m, tz)).filter(Number.isFinite);
  const { list, blocked } = planScorable(tourney, Math.min(...times));
  // the group stage packs two pool matches onto every court at the day's start
  assert.ok(list.length >= 2, `several courts due, got ${list.length}`);
  assert.strictEqual(new Set(list.map(e => e.m.venue)).size, list.length, 'one scorable per venue');
  for (const b of blocked.filter(x => x.first)) {
    assert.ok(b.t >= b.first.t, `${b.cat} ${b.m.id} is behind ${b.first.cat} ${b.first.m.id} on the same venue`);
  }
});

test('a play-through ends complete and validates clean', () => {
  const tourney = generate(MINI);
  const tz = tourney.timezone;
  const ctxOf = cid => makeCat({ meta: tourney.categories.find(c => c.id === cid), matches: tourney.matches[cid] }, tourney);
  const times = Object.values(tourney.matches).flat().map(m => schedTime(m, tz)).filter(Number.isFinite);
  let now = Math.min(...times);
  const end = Math.max(...times);
  while (now <= end) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const e of planScorable(tourney, now).list) {
        applyScore(tourney.matches[e.cat], e.m.id, makeGames(bestOfOf(e.m, e.ctx)), e.ctx);
        progress = true;
      }
    }
    now += STEP;
  }
  const repo = {
    readErrs: [],
    index: [{ slug: 'mini', name: 'Mini Open', location: 'Zurich', dates: schedDays(Object.values(tourney.matches).flat(), tz) }],
    tournaments: new Map([['mini', { tjson: tourney }]]),
  };
  const { errs } = validateRepo(repo);
  assert.deepStrictEqual(errs, []);
  const all = Object.values(tourney.matches).flat();
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