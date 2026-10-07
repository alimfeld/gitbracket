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
  ['ready-ahead scenario validates', 'ready', 'clean', null],
  ['head-to-head ratio fixture validates', 'h2hratio', 'clean', null],
  ['walkover ratio fixture validates', 'walkover-ratio', 'clean', null],
  ['placement bracket validates', 'place', 'clean', null],
  ['play-in draw validates', 'playin', 'clean', null],
  ['open placement band beside the final validates', 'placewave', 'clean', null],
  ['fully played bracket validates', 'full', 'clean', null],
  ['capped classification band validates', 'capped', 'clean', null],
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
  ['bestOf beyond the render bound rejected', 'bad-huge-bestof', 'err', /odd number 1–9/],
  ['unknown tiebreak rung rejected', 'bad-tiebreak', 'err', /tiebreak rung "h2hWinRatio" is not one of/],
  ['missing tiebreak rejected', 'bad-no-tiebreak', 'err', /tiebreak must be a non-empty array/],
  ['bad scheduled string', 'bad-scheduled', 'err', /ISO-8601/],
  ['venue overlap', 'bad-venue-overlap', 'conflict', /overlap/],
  ['long-slot venue overlap', 'bad-slot-overlap', 'conflict', /60-minute and 60-minute slots/],
  ['pool slot names an unknown pool', 'bad-unknown-pool', 'err', /unknown pool/],
  ['dangling feeder and non-iterable sides in the placement walk report, never crash', 'bad-dangling-ref', 'err', /unknown match slot/],
  ['bad venue id', 'bad-venue-id', 'err', /must match/],
  ['null match entry', 'bad-null-match', 'err', /must be an object/],
  ['null game entry reported, never a crash', 'bad-null-game', 'err', /non-negative integer scores/],
  ['non-array games reported, never a crash', 'bad-games-not-array', 'err', /must be an array of/],
  ['sides-less pool match reported, never a crash', 'bad-pool-missing-sides', 'err', /exactly two sides required/],
  ['null player entry', 'bad-null-player', 'err', /must be an object/],
  ['non-string player name reported, not a crash', 'bad-player-name', 'err', /name must be a non-empty string/],
  ['player with two partners', 'bad-two-partners', 'conflict', /has two partners/],
  ['same pair in two pools', 'bad-two-pools', 'conflict', /plays in two pools/],
  ['duplicate slug in index', 'bad-duplicate-slug', 'err', /duplicate slug/],
  ['pool slot rank out of range', 'bad-rank-range', 'conflict', /out of range/],
  ['dead-tie pool slot is a render concern, not a gate finding', 'tie', 'clean', null],
  ['3-way dead tie is a render concern too', 'tie3', 'clean', null],
  ['adjacent dead-tie clusters validate clean', 'adjtie', 'clean', null],
  ['tiebreak fixture validates', 'tiebreak', 'clean', null],
  ['every rung fixture validates', 'rungs', 'clean', null],
  ['cross-category venue overlap', 'bad-cross-overlap', 'conflict', /also schedules/],
  ['cross-category player double-book', 'bad-player-doublebook', 'conflict', /double-booked/],
  ['venue-less match still double-books a player', 'bad-doublebook-no-venue', 'conflict', /double-booked/],
  ['a slot-fed side double-books like an explicit one', 'bad-resolved-doublebook', 'conflict', /double-booked/],
  ['undeclared category matches file', 'bad-undeclared-cat', 'err', /undeclared category/],
  ['unknown venue reference', 'bad-unknown-venue', 'err', /unknown venue/],
  ['null tournament data', 'bad-null-tjson', 'err', /must be an object/],
  ['scheduled hour 24 rejected', 'bad-scheduled-hour', 'err', /hour/],
  ['impossible calendar date rejected', 'bad-scheduled-date', 'err', /not a real calendar date/],
  ['offset in scheduled rejected — wall time only', 'bad-scheduled-offset', 'err', /no offset or Z/],
  ['even groups bestOf rejected', 'bad-even-groups-bestof', 'err', /groups stage in use/],
  ['scored match with no category bestOf reports, never crashes', 'bad-no-bestof-games', 'err', /bestOf\.groups/],
  ['pool side ids of the wrong shape reports, never crashes the standings', 'bad-pool-ids-shape', 'err', /ids must be a non-empty array of strings/],
  ['duplicate venue id', 'bad-duplicate-venue', 'err', /duplicate venue/],
  ['unknown side kind', 'bad-unknown-kind', 'err', /unknown side kind/],
  ['mixed singles and doubles', 'bad-mixed-sizes', 'conflict', /mixes singles and doubles/],
  ['side id not a registered player', 'bad-unknown-player', 'err', /unknown player/],
  ['string side ids rejected, not char-split', 'bad-string-ids', 'err', /ids must be a non-empty array of strings/],
  ['game with no winner (a equals b)', 'bad-tie-game', 'err', /no winner/],
  ['drawn game inside a decided match', 'bad-drawn-game', 'err', /no winner/],
  ['invalid timezone', 'bad-invalid-tz', 'err', /not a valid IANA timezone/],
  ['invalid timezone with scheduled matches reported, never a crash', 'bad-tz-sched', 'err', /not a valid IANA timezone/],
  ['tournament file missing its name', 'bad-no-name', 'err', /name must be a non-empty string/],
  ['tournament file missing its location', 'bad-no-location', 'err', /location must be a non-empty string/],
  ['location mismatches the index entry', 'bad-location-mismatch', 'err', /does not match the index entry/],
  ['index entry missing its location', 'bad-index-location', 'err', /tournaments\.json.*location must be a non-empty string/],
  ['tournament file name mismatches the index', 'bad-name-mismatch', 'err', /does not match the index/],
  ['index dates mismatch the schedule', 'bad-dates-mismatch', 'err', /does not match the schedule/],
  ['scheduled tournament missing index dates', 'bad-dates-missing', 'err', /dates missing/],
  ['duplicate and missing pool round-robin pairings', 'bad-pool-pairing', 'conflict', /repeats the matchup/],
  ['DST wall-time fixture validates', 'dst-wall-time', 'clean', null],
  ['non-array categories reported, not a crash', 'bad-not-array', 'err', /categories must be an array/],
  ['object-shaped categories reported, not a crash', 'bad-categories-object', 'err', /categories must be an array/],
  ['non-array venues and players reported, not a crash', 'bad-nonarray-lists', 'err', /must be an array/],
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
  ['scheduled match with no slot length and no venue', 'bad-noslot-no-venue', 'err', /no slot length/],
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
    assert(![...r.errs, ...r.conflicts].some(e => String(e).endsWith(': undefined')), 'no message may end in ": undefined" (err(f, m) called with one arg?)');
  });
}

test('pool pairing conflict reports both the duplicate and the omitted opponent', () => {
  const r = validateFixture('bad-pool-pairing');
  assert(r.conflicts.some(c => /repeats the matchup p1 vs p2/.test(c)), 'the repeated fixture is named');
  assert(r.conflicts.some(c => /missing the matchup p2 vs p3/.test(c)), 'the omitted fixture is named');
});

test('two unplaced matches share no court — undefined is not a venue double-book', () => {
  const r = validateFixture('bad-doublebook-no-venue');
  assert(hasConflict(r, /double-booked/), 'the player clash is caught across the venue-less pair');
  assert(!hasConflict(r, /overlap at venue/), 'undefined === undefined must not read as the same court');
});

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

test('conflicts carry the cards they name: match-scoped refs and both double-book ends', () => {
  const one = validateFixture('bad-two-pools').conflicts.find(c => /plays in two pools/.test(c));
  assert.deepEqual(one.refs, [{ cat: 't', matchId: 2 }], 'a match-scoped conflict names its own match');
  assert.equal(String(one), `${one.where}: ${one.message}`, 'the gate line survives the object');

  const dup = validateFixture('bad-consumed-twice').conflicts.find(c => /consumed twice \(also by/.test(c));
  assert.equal(dup.refs.length, 2, 'a shared slot lights both holders');
  assert(dup.refs.some(r => r.matchId === 3), 'the first owner is among them');

  const cross = validateFixture('bad-cross-overlap').conflicts.find(c => /overlap/.test(c));
  assert.equal(cross.refs.length, 2, 'a double-book names both ends');
  assert(cross.refs.some(r => r.cat === 'k1') && cross.refs.some(r => r.cat === 'k2'), 'across categories too');

  const roots = validateFixture('unfed-roots').conflicts.find(c => /unfed knockout/.test(c));
  assert.deepEqual(roots.refs, [{ cat: 't', matchId: 7 }, { cat: 't', matchId: 10 }], 'the one-final rule names every unfed root, so both highlight');

  const cyc = validateFixture('cycle').conflicts.find(c => /cycle/.test(c));
  assert.deepEqual(cyc.refs, [{ cat: 't', matchId: 1 }], 'a cycle lights the match it was detected at');
});

test('filterSlug: validate <slug> narrows to that tournament', () => {
  const errs = [
    'site/tournaments/2026-mammut60.json: name does not match the index entry',
    'tournaments.json [0] (2026-mammut60): duplicate slug 2026-mammut60',
    'site/tournaments/other.json: timezone required',
    // a sibling quoting the slug as a category id must stay out — the where leads the line
    'site/tournaments/other.json matches.other: maps to undeclared category "2026-mammut60" — a key typo would silently render an empty category',
  ];
  const got = filterSlug(errs, '2026-mammut60');
  assert.equal(got.length, 2, 'keeps the tournament file and its index entry');
  assert(!got.some(e => e.includes('other.json')), 'a sibling quoting the slug as an id stays out');
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
