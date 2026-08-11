'use strict';

// Shared repo I/O: read a repo into memory, write tournament files.
// The "site root" is the directory holding tournaments.json — for a real repo
// that's <repo>/site, for fixtures/ it's the fixture directory itself.

const fs = require('fs');
const path = require('path');
const { ID_RE } = require('../site/derive.js');

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

module.exports = { loadRepo, writeTournament };
