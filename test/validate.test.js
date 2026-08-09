'use strict';

// Validator (validate.js): every fixture runs through the real loadRepo +
// validateRepo; the V table pins the error/warn channel per fixture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFixture, hasErr, hasWarn } = require('./helpers.js');

const V = [ // [name, fixture dir, ok, expected message regex]
  ['clean fixture validates', 'sample', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['placement bracket validates', 'place', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['fully played bracket validates', 'full', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['uppercase match id', 'bad-uppercase-id', r => r.errs.length > 0, /must match/],
  ['same player set on both sides', 'bad-same-pair', r => r.errs.length > 0, /same player set/],
  ['slot source consumed twice', 'bad-consumed-twice', r => r.errs.length > 0, /consumed twice/],
  ['slot cycle', 'cycle', r => r.errs.length > 0, /cycle/],
  ['games after a side reached the target', 'bad-games-after-target', r => r.errs.length > 0, /already reached/],
  ['games and forfeit together', 'bad-games-forfeit', r => r.errs.length > 0, /mutually exclusive/],
  ['scored match fed by an unfinished pool', 'bad-unfinished-feed', r => r.errs.length > 0, /resolved/],
  ['even bestOf override', 'bad-even-bestof', r => r.errs.length > 0, /odd/],
  ['bad scheduled string', 'bad-scheduled', r => r.errs.length > 0, /ISO-8601/],
  ['venue overlap', 'bad-venue-overlap', r => r.errs.length > 0, /overlap/],
  ['long-slot venue overlap', 'bad-slot-overlap', r => r.errs.length > 0, /60-minute and 60-minute slots/],
  ['pool slot names an unknown pool', 'bad-unknown-pool', r => r.errs.length > 0, /unknown pool/],
  ['bad venue id', 'bad-venue-id', r => r.errs.length > 0, /must match/],
  ['null match entry', 'bad-null-match', r => r.errs.length > 0, /must be an object/],
  ['null player entry', 'bad-null-player', r => r.errs.length > 0, /must be an object/],
  ['player with two partners', 'bad-two-partners', r => r.errs.length > 0, /has two partners/],
  ['duplicate slug in index', 'bad-duplicate-slug', r => r.errs.length > 0, /duplicate slug/],
  ['pool slot rank out of range', 'bad-rank-range', r => r.errs.length > 0, /out of range/],
  ['dead-tie pool slot warns only', 'tie', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['3-way dead tie warns at rank 1', 'tie3', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['tiebreak fixture validates', 'tiebreak', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['cross-category venue overlap', 'bad-cross-overlap', r => r.errs.length > 0, /also schedules/],
  ['undeclared category matches file', 'bad-undeclared-cat', r => r.errs.length > 0, /undeclared category/],
  ['unknown venue reference', 'bad-unknown-venue', r => r.errs.length > 0, /unknown venue/],
  ['null tournament data', 'bad-null-tjson', r => r.errs.length > 0, /must be an object/],
  ['scheduled hour 24 rejected', 'bad-scheduled-hour', r => r.errs.length > 0, /hour/],
  ['impossible calendar date rejected', 'bad-scheduled-date', r => r.errs.length > 0, /not a real calendar date/],
  ['offset outside ISO-8601 range', 'bad-scheduled-offset', r => r.errs.length > 0, /outside ISO-8601/],
  ['even groups bestOf rejected', 'bad-even-groups-bestof', r => r.errs.length > 0, /groups stage in use/],
  ['duplicate venue id', 'bad-duplicate-venue', r => r.errs.length > 0, /duplicate venue/],
  ['unknown side kind', 'bad-unknown-kind', r => r.errs.length > 0, /unknown side kind/],
  ['mixed singles and doubles', 'bad-mixed-sizes', r => r.errs.length > 0, /mixes singles and doubles/],
  ['side id not a registered player', 'bad-unknown-player', r => r.errs.length > 0, /unknown player/],
  ['game with no winner (a equals b)', 'bad-tie-game', r => r.errs.length > 0, /no winner/],
  ['invalid timezone', 'bad-invalid-tz', r => r.errs.length > 0, /not a valid IANA timezone/],
  ['tournament file missing its name', 'bad-no-name', r => r.errs.length > 0, /name must be a non-empty string/],
  ['tournament file name mismatches the index', 'bad-name-mismatch', r => r.errs.length > 0, /does not match the index/]
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
