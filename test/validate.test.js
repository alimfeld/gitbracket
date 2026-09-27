'use strict';

// Validator (src/validate.js): every fixture runs through the real loadRepo +
// validateRepo; the V table pins the channel per fixture — syntactic `err` or
// semantic `conflict`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterSlug, validateRepo } = require('../src/validate.js');
const { validateFixture, hasErr, hasConflict, FIX } = require('./helpers.js');
const { loadRepo } = require('../src/tools.js');

// [name, fixture, channel, message] — 'clean' = neither channel.
const V = [
  ['clean fixture validates', 'sample', 'clean', null],
  ['placement bracket validates', 'place', 'clean', null],
  ['fully played bracket validates', 'full', 'clean', null],
  ['non-numeric match id', 'bad-uppercase-id', 'err', /must be a positive integer/],
  ['same player set on both sides', 'bad-same-pair', 'conflict', /same player set/],
  ['slot source consumed twice', 'bad-consumed-twice', 'conflict', /consumed twice/],
  ['one match consuming its slot source twice', 'bad-dup-source', 'conflict', /consumed twice by this match/],
  ['both sides resolving to the same team', 'bad-same-team', 'conflict', /same team/],
  ['slot cycle', 'cycle', 'conflict', /cycle/],
  ['two unfed knockout matches — not a single final', 'bad-two-finals', 'conflict', /exactly one championship final/],
  ['games after a side reached the target', 'bad-games-after-target', 'conflict', /already reached/],
  ['games and a walkover together', 'bad-games-walkover', 'conflict', /mutually exclusive/],
  ['scored match fed by an unfinished pool', 'bad-unfinished-feed', 'conflict', /resolved/],
  ['bracket scheduled before its feeders end', 'bad-feeder-time', 'conflict', /starts before its feeders end/],
  ['even bestOf override', 'bad-even-bestof', 'err', /odd/],
  ['bad scheduled string', 'bad-scheduled', 'err', /ISO-8601/],
  ['venue overlap', 'bad-venue-overlap', 'conflict', /overlap/],
  ['long-slot venue overlap', 'bad-slot-overlap', 'conflict', /60-minute and 60-minute slots/],
  ['pool slot names an unknown pool', 'bad-unknown-pool', 'conflict', /unknown pool/],
  ['bad venue id', 'bad-venue-id', 'err', /must match/],
  ['null match entry', 'bad-null-match', 'err', /must be an object/],
  ['null game entry reported, never a crash', 'bad-null-game', 'err', /non-negative integer scores/],
  ['non-array games reported, never a crash', 'bad-games-not-array', 'err', /must be an array of/],
  ['sides-less pool match reported, never a crash', 'bad-pool-missing-sides', 'err', /exactly two sides required/],
  ['null player entry', 'bad-null-player', 'err', /must be an object/],
  ['player with two partners', 'bad-two-partners', 'conflict', /has two partners/],
  ['same pair in two pools', 'bad-two-pools', 'conflict', /plays in two pools/],
  ['duplicate slug in index', 'bad-duplicate-slug', 'err', /duplicate slug/],
  ['pool slot rank out of range', 'bad-rank-range', 'conflict', /out of range/],
  ['dead-tie pool slot is a render concern, not a gate finding', 'tie', 'clean', null],
  ['3-way dead tie is a render concern too', 'tie3', 'clean', null],
  ['adjacent dead-tie clusters validate clean', 'adjtie', 'clean', null],
  ['tiebreak fixture validates', 'tiebreak', 'clean', null],
  ['cross-category venue overlap', 'bad-cross-overlap', 'conflict', /also schedules/],
  ['cross-category player double-book', 'bad-player-doublebook', 'conflict', /double-booked/],
  ['a slot-fed side double-books like an explicit one', 'bad-resolved-doublebook', 'conflict', /double-booked/],
  ['undeclared category matches file', 'bad-undeclared-cat', 'err', /undeclared category/],
  ['unknown venue reference', 'bad-unknown-venue', 'err', /unknown venue/],
  ['null tournament data', 'bad-null-tjson', 'err', /must be an object/],
  ['scheduled hour 24 rejected', 'bad-scheduled-hour', 'err', /hour/],
  ['impossible calendar date rejected', 'bad-scheduled-date', 'err', /not a real calendar date/],
  ['offset in scheduled rejected — wall time only', 'bad-scheduled-offset', 'err', /no offset or Z/],
  ['even groups bestOf rejected', 'bad-even-groups-bestof', 'err', /groups stage in use/],
  ['duplicate venue id', 'bad-duplicate-venue', 'err', /duplicate venue/],
  ['unknown side kind', 'bad-unknown-kind', 'err', /unknown side kind/],
  ['mixed singles and doubles', 'bad-mixed-sizes', 'conflict', /mixes singles and doubles/],
  ['side id not a registered player', 'bad-unknown-player', 'err', /unknown player/],
  ['string side ids rejected, not char-split', 'bad-string-ids', 'err', /ids must be a non-empty array of strings/],
  ['game with no winner (a equals b)', 'bad-tie-game', 'err', /no winner/],
  ['invalid timezone', 'bad-invalid-tz', 'err', /not a valid IANA timezone/],
  ['invalid timezone with scheduled matches reported, never a crash', 'bad-tz-sched', 'err', /not a valid IANA timezone/],
  ['tournament file missing its name', 'bad-no-name', 'err', /name must be a non-empty string/],
  ['tournament file missing its location', 'bad-no-location', 'err', /location must be a non-empty string/],
  ['location mismatches the index entry', 'bad-location-mismatch', 'err', /does not match the index entry/],
  ['index entry missing its location', 'bad-index-location', 'err', /tournaments\.json.*location must be a non-empty string/],
  ['tournament file name mismatches the index', 'bad-name-mismatch', 'err', /does not match the index/],
  ['index dates mismatch the schedule', 'bad-dates-mismatch', 'err', /does not match the schedule/],
  ['scheduled tournament missing index dates', 'bad-dates-missing', 'err', /dates missing/],
  ['non-array categories reported, not a crash', 'bad-not-array', 'err', /categories must be an array/],
  ['object-shaped categories reported, not a crash', 'bad-categories-object', 'err', /categories must be an array/],
  ['null category entry reported, not a crash', 'bad-null-category', 'err', /entry must be an object/],
  ['8-team classification fixture validates', 'place8', 'clean', null],
  ['a matching dates claim validates — multi-day span', 'multiday', 'clean', null],
  ['all result statuses validate and pool completes', 'result', 'clean', null],
  ['played result mismatches its games', 'bad-result-mismatch', 'conflict', /does not match the games/],
  ['unknown result status', 'bad-result-status', 'err', /one of/],
  ['games reaching the target without a result', 'bad-no-result', 'conflict', /record a result/],
  ['void result with a winner', 'bad-void-winner', 'conflict', /no winner/],
  ['void result carries games', 'bad-void-games', 'conflict', /mutually exclusive/],
  ['malformed match sides reported, not a crash', 'bad-sides', 'err', /exactly two sides required/],
  ['malformed knockout sides reported while placement/scoring run, not a crash', 'bad-sides-knockout', 'err', /exactly two sides required/],
  ['scheduled match with no slot length', 'bad-noslot', 'err', /no slot length/],
  ['replacing a final feeder leaves a repairable conflict, not a refusal', 'unfed-roots', 'conflict', /exactly one championship final/]
];
for (const [name, dir, channel, re] of V) {
  test(name, () => {
    const r = validateFixture(dir);
    if (channel === 'clean') {
      assert(r.errs.length === 0 && r.conflicts.length === 0, `expected clean, got errs=${r.errs.join(' | ')} conflicts=${r.conflicts.join(' | ')}`);
    } else if (channel === 'err') {
      assert(r.errs.length > 0, `expected a syntactic error, got conflicts=${r.conflicts.join(' | ')}`);
      if (re) {
        assert(hasErr(r, re), `expected an error matching /${re}/, got none\n${r.errs.slice(0, 3).join('\n')}`);
        assert(!hasConflict(r, re), 'that message belongs to errs, not conflicts');
      }
    } else {
      assert(r.conflicts.length > 0, `expected a semantic conflict, got errs=${r.errs.join(' | ')}`);
      if (re) {
        assert(hasConflict(r, re), `expected a conflict matching /${re}/, got none\n${r.conflicts.slice(0, 3).join('\n')}`);
        assert(!hasErr(r, re), 'that message belongs to conflicts, not errs');
      }
    }
    assert(![...r.errs, ...r.conflicts].some(e => e.endsWith(': undefined')), 'no message may end in ": undefined" (err(f, m) called with one arg?)');
  });
}

test('two malformed index entries: real shape errors, no bogus undefined-slug duplicate', () => {
  const r = validateFixture('bad-duplicate-slug');
  assert(r.errs.some(e => /must match/.test(e)), 'the shape errors are still reported');
  assert(!r.errs.some(e => e.includes('duplicate slug undefined')), 'two missing slugs are not a duplicate-slug pair');
});

test('even bestOf with games: the config is the cause, never an invented null target', () => {
  const r = validateFixture('bad-even-bestof');
  assert(hasErr(r, /odd/), 'the override error is still reported');
  assert(![...r.errs, ...r.conflicts].some(e => /target of null|reached the best-of target/.test(e)),
    `no null-target messages — the games are not blamed for a config error, got: ${[...r.errs, ...r.conflicts].join(' | ')}`);
});

test('filterSlug: an index-entry error carries its slug — validate <slug> keeps it', () => {
  const info = loadRepo(FIX('sample')).tournaments.get('sample');
  // a valid-slug entry missing its name — the tournament file itself is fine
  const r = validateRepo({ readErrs: [], index: [{ location: 'New York', slug: 'sample' }], tournaments: new Map([['sample', info]]) });
  const idxErr = r.errs.find(e => e.startsWith('tournaments.json'));
  assert(idxErr && idxErr.includes('(sample)'), `index errors name their entry, got: ${idxErr}`);
  assert(filterSlug(r.errs, 'sample').includes(idxErr), "a per-slug run keeps the entry's own errors");
});

test('filterSlug: validate <slug> narrows to that tournament', () => {
  const errs = [
    'site/tournaments/2026-mammut60.json: name does not match the index entry',
    'tournaments.json [0]: duplicate slug 2026-mammut60',
    'site/tournaments/other.json: timezone required',
  ];
  const got = filterSlug(errs, '2026-mammut60');
  assert.equal(got.length, 2, 'keeps the tournament file and its index entry');
  assert(!got.some(e => e.includes('other.json')), 'other tournaments stay out');
});

test('filterSlug: a substring-prefixed slug stays out (tie vs tie3)', () => {
  const errs = [
    'site/tournaments/tie.json: name does not match the index entry',
    'site/tournaments/tie3.json: name does not match the index entry',
    'tournaments.json [0]: duplicate slug tie3',
    'tournaments.json [1]: slug "tie3" must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, got "tie3"',
  ];
  const got = filterSlug(errs, 'tie');
  assert.deepEqual(got, ['site/tournaments/tie.json: name does not match the index entry'],
    'tie3 errors (file, duplicate slug, slug-format) must not leak into validate tie');
});
