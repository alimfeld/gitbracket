'use strict';

// Logic shared by the tools (validator, generator, REPL) that the site never
// ships — repo I/O plus tool-only domain predicates. site/ is the shipping
// surface; anything only a tool consumes lives here, so derive.js stays
// exactly the site's domain model. (The "site root" is the directory holding
// tournaments.json — for a real repo that's <repo>/site, for fixtures/ it's
// the fixture directory itself.)

const fs = require('fs');
const path = require('path');
const { ID_RE } = require('../site/derive.js');

// Window collision test: shared by the validator's venue-overlap rule and the
// generator's court/player occupancy — one predicate, no drift. (matchSlotMs,
// its sibling that sizes a window, stays in derive.js: the site's kiosk uses it.)
const slotsOverlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// Impossible calendar dates (2025-02-30) roll over in Date.UTC; check the
// round-trip. Used by the validator (scheduled) and the generator (spec date).
function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function readJson(file, errs) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errs.push(`${file}: not readable JSON (${e.message})`);
    return undefined;
  }
}

// Read a site root into memory:
// { index, tournaments: Map<slug, { tjson, matches: Map<catId, cjson> }>, readErrs }.
// validateRepo() runs every check on this structure; tests build it from fixtures/.
function loadRepo(siteRoot) {
  const readErrs = [];
  const index = readJson(path.join(siteRoot, 'tournaments.json'), readErrs);
  const tournaments = new Map();
  if (Array.isArray(index)) {
    for (const t of index) {
      if (!t || typeof t.slug !== 'string' || !ID_RE.test(t.slug)) continue;
      const tfile = path.join(siteRoot, 'tournaments', t.slug + '.json');
      const tjson = readJson(tfile, readErrs);
      const matches = new Map();
      if (tjson && typeof tjson === 'object' && !Array.isArray(tjson) && tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches)) {
        for (const [cid, arr] of Object.entries(tjson.matches)) matches.set(cid, { matches: arr });
      }
      tournaments.set(t.slug, { tjson, matches });
    }
  }
  return { index, tournaments, readErrs };
}

// Write one tournament file with the repo's byte-identical formatting
// (JSON.stringify(..., null, 2) + '\n'), so a commit diff shows only the edit.
function writeTournament(siteRoot, slug, tjson) {
  fs.writeFileSync(path.join(siteRoot, 'tournaments', `${slug}.json`), JSON.stringify(tjson, null, 2) + '\n');
}

module.exports = { loadRepo, writeTournament, slotsOverlap, isRealDate };
