'use strict';

// Validator (src/validate.js): every fixture runs through the real loadRepo +
// validateRepo; the V table pins the error/warn channel per fixture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterErrs } = require('../src/validate.js');
const { validateFixture, hasErr, hasWarn } = require('./helpers.js');

const V = [
  ['clean fixture validates', 'sample', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['placement bracket validates', 'place', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['fully played bracket validates', 'full', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['non-numeric match id', 'bad-uppercase-id', r => r.errs.length > 0, /must be a positive integer/],
  ['same player set on both sides', 'bad-same-pair', r => r.errs.length > 0, /same player set/],
  ['slot source consumed twice', 'bad-consumed-twice', r => r.errs.length > 0, /consumed twice/],
  ['slot cycle', 'cycle', r => r.errs.length > 0, /cycle/],
  ['games after a side reached the target', 'bad-games-after-target', r => r.errs.length > 0, /already reached/],
  ['games and a walkover together', 'bad-games-walkover', r => r.errs.length > 0, /mutually exclusive/],
  ['scored match fed by an unfinished pool', 'bad-unfinished-feed', r => r.errs.length > 0, /resolved/],
  ['even bestOf override', 'bad-even-bestof', r => r.errs.length > 0, /odd/],
  ['bad scheduled string', 'bad-scheduled', r => r.errs.length > 0, /ISO-8601/],
  ['venue overlap', 'bad-venue-overlap', r => r.errs.length > 0, /overlap/],
  ['long-slot venue overlap', 'bad-slot-overlap', r => r.errs.length > 0, /60-minute and 60-minute slots/],
  ['pool slot names an unknown pool', 'bad-unknown-pool', r => r.errs.length > 0, /unknown pool/],
  ['bad venue id', 'bad-venue-id', r => r.errs.length > 0, /must match/],
  ['null match entry', 'bad-null-match', r => r.errs.length > 0, /must be an object/],
  ['null game entry reported, never a crash', 'bad-null-game', r => r.errs.length > 0, /non-negative integer scores/],
  ['non-array games reported, never a crash', 'bad-games-not-array', r => r.errs.length > 0, /must be an array of/],
  ['sides-less pool match reported, never a crash', 'bad-pool-missing-sides', r => r.errs.length > 0, /exactly two sides required/],
  ['null player entry', 'bad-null-player', r => r.errs.length > 0, /must be an object/],
  ['player with two partners', 'bad-two-partners', r => r.errs.length > 0, /has two partners/],
  ['duplicate slug in index', 'bad-duplicate-slug', r => r.errs.length > 0, /duplicate slug/],
  ['pool slot rank out of range', 'bad-rank-range', r => r.errs.length > 0, /out of range/],
  ['dead-tie pool slot warns only', 'tie', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['3-way dead tie warns at rank 1', 'tie3', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['adjacent dead-tie clusters validate clean', 'adjtie', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['tiebreak fixture validates', 'tiebreak', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['cross-category venue overlap', 'bad-cross-overlap', r => r.errs.length > 0, /also schedules/],
  ['undeclared category matches file', 'bad-undeclared-cat', r => r.errs.length > 0, /undeclared category/],
  ['unknown venue reference', 'bad-unknown-venue', r => r.errs.length > 0, /unknown venue/],
  ['null tournament data', 'bad-null-tjson', r => r.errs.length > 0, /must be an object/],
  ['scheduled hour 24 rejected', 'bad-scheduled-hour', r => r.errs.length > 0, /hour/],
  ['impossible calendar date rejected', 'bad-scheduled-date', r => r.errs.length > 0, /not a real calendar date/],
  ['offset in scheduled rejected — wall time only', 'bad-scheduled-offset', r => r.errs.length > 0, /no offset or Z/],
  ['even groups bestOf rejected', 'bad-even-groups-bestof', r => r.errs.length > 0, /groups stage in use/],
  ['duplicate venue id', 'bad-duplicate-venue', r => r.errs.length > 0, /duplicate venue/],
  ['unknown side kind', 'bad-unknown-kind', r => r.errs.length > 0, /unknown side kind/],
  ['mixed singles and doubles', 'bad-mixed-sizes', r => r.errs.length > 0, /mixes singles and doubles/],
  ['side id not a registered player', 'bad-unknown-player', r => r.errs.length > 0, /unknown player/],
  ['game with no winner (a equals b)', 'bad-tie-game', r => r.errs.length > 0, /no winner/],
  ['invalid timezone', 'bad-invalid-tz', r => r.errs.length > 0, /not a valid IANA timezone/],
  ['tournament file missing its name', 'bad-no-name', r => r.errs.length > 0, /name must be a non-empty string/],
  ['tournament file missing its location', 'bad-no-location', r => r.errs.length > 0, /location must be a non-empty string/],
  ['location mismatches the index entry', 'bad-location-mismatch', r => r.errs.length > 0, /does not match the index entry/],
  ['index entry missing its location', 'bad-index-location', r => r.errs.length > 0, /tournaments\.json.*location must be a non-empty string/],
  ['tournament file name mismatches the index', 'bad-name-mismatch', r => r.errs.length > 0, /does not match the index/],
  ['index dates mismatch the schedule', 'bad-dates-mismatch', r => r.errs.length > 0, /does not match the schedule/],
  ['scheduled tournament missing index dates', 'bad-dates-missing', r => r.errs.length > 0, /dates missing/],
  ['non-array categories reported, not a crash', 'bad-not-array', r => r.errs.length > 0, /categories must be an array/],
  ['8-team classification fixture validates', 'place8', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['a matching dates claim validates — multi-day span', 'multiday', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['all result statuses validate and pool completes', 'result', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['played result mismatches its games', 'bad-result-mismatch', r => r.errs.length > 0, /does not match the games/],
  ['unknown result status', 'bad-result-status', r => r.errs.length > 0, /one of/],
  ['games reaching the target without a result', 'bad-no-result', r => r.errs.length > 0, /record a result/],
  ['void result with a winner', 'bad-void-winner', r => r.errs.length > 0, /no winner/],
  ['void result carries games', 'bad-void-games', r => r.errs.length > 0, /mutually exclusive/],
  ['malformed match sides reported, not a crash', 'bad-sides', r => r.errs.length > 0, /exactly two sides required/],
  ['scheduled match with no slot length warns', 'warn-noslot', r => r.errs.length === 0 && r.warns.length > 0, /no slot length/]
];
for (const [name, dir, ok, re] of V) {
  test(name, () => {
    const r = validateFixture(dir);
    assert(ok(r), `unexpected result: errs=${r.errs.length} warns=${r.warns.length}`);
    if (re) {
      // strict channel: the message must be an error for error fixtures, a warning for warn fixtures
      const got = r.errs.length ? hasErr(r, re) : hasWarn(r, re);
      assert(got, `expected a ${r.errs.length ? 'error' : 'warning'} matching /${re}/, got none\n` + [...r.errs, ...r.warns].slice(0, 3).join('\n'));
    }
    assert(!r.errs.some(e => e.endsWith(': undefined')), 'no error message may end in ": undefined" (err(f, m) called with one arg?)');
  });
}

test('two malformed index entries: real shape errors, no bogus undefined-slug duplicate', () => {
  const r = validateFixture('bad-duplicate-slug');
  assert(r.errs.some(e => /must match/.test(e)), 'the shape errors are still reported');
  assert(!r.errs.some(e => e.includes('duplicate slug undefined')), 'two missing slugs are not a duplicate-slug pair');
});

test('filterErrs: validate <slug> narrows to that tournament', () => {
  const errs = [
    'site/tournaments/2026-mammut60.json: name does not match the index entry',
    'tournaments.json [0]: duplicate slug 2026-mammut60',
    'site/tournaments/other.json: timezone required',
  ];
  const got = filterErrs(errs, '2026-mammut60');
  assert.equal(got.length, 2, 'keeps the tournament file and its index entry');
  assert(!got.some(e => e.includes('other.json')), 'other tournaments stay out');
});

test('filterErrs: a substring-prefixed slug stays out (tie vs tie3)', () => {
  const errs = [
    'site/tournaments/tie.json: name does not match the index entry',
    'site/tournaments/tie3.json: name does not match the index entry',
    'tournaments.json [0]: duplicate slug tie3',
    'tournaments.json [1]: slug "tie3" must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, got "tie3"',
  ];
  const got = filterErrs(errs, 'tie');
  assert.deepEqual(got, ['site/tournaments/tie.json: name does not match the index entry'],
    'tie3 errors (file, duplicate slug, slug-format) must not leak into validate tie');
});
