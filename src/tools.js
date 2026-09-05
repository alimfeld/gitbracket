'use strict';

// Logic shared by the tools (validator, generator, editor) that the site never
// ships — repo I/O plus tool-only domain predicates. site/ is the shipping
// surface; anything only a tool consumes lives here, so derive.js stays
// exactly the site's domain model. (The "site root" is the directory holding
// tournaments.json — for a real repo that's <repo>/site, for fixtures/ it's
// the fixture directory itself.)

const fs = require('fs');
const path = require('path');
const { ID_RE, makeCat } = require('../site/derive.js');

// Window collision test: shared by the validator's venue-overlap rule and the
// generator's court/player occupancy — one predicate, no drift. (matchSlotMs,
// its sibling that sizes a window, stays in derive.js: the site's kiosk uses it.)
const slotsOverlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// A match's known players as a Set, null when a side is a slot (match/pool) —
// such a side resolves only after results. Shared by the validator's player
// double-book rule and the generator's occupancy scan (same predicate, no drift).
function fixedPlayers(m) {
  return Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every(s => s && s.kind === 'players' && Array.isArray(s.ids))
    ? new Set(m.sides.flatMap(s => s.ids)) : null;
}

// The one category context a tool pass iterates: meta + matches by category
// id — the editor's buffer and the sim's due list used to re-type the
// find+makeCat lookup, so it lives here.
function catCtx(tjson, cid) {
  return makeCat({ meta: (tjson.categories || []).find(c => c.id === cid), matches: (tjson.matches || {})[cid] || [] }, tjson);
}

// The day's running order, one comparator: time, then category id, then match
// id — the editor's buffer and the sim's due list sort with the same rule so
// the two surfaces can never present different orders.
const byMatchOrder = (a, b) => a.t - b.t || a.cat.localeCompare(b.cat) || a.m.id - b.m.id;

// Impossible calendar dates (2025-02-30) roll over in Date.UTC; check the
// round-trip. Used by the validator (scheduled) and the generator (spec date).
function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Repo-root discovery for the CLI entry (gb.js dispatches, this walks): find
// the ancestor directory holding site/tournaments.json, so `node gb.js` works
// from anywhere under the repo.
function findRoot(from) {
  let dir = from || process.cwd();
  while (!fs.existsSync(path.join(dir, 'site', 'tournaments.json')) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return dir;
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
// { index, tournaments: Map<slug, { tjson }>, readErrs }. The file itself is
// the one view of the data — tjson.matches IS the matches, no parallel Map to
// keep identical. validateRepo() runs every check on this structure; tests
// build it from fixtures/.
function loadRepo(siteRoot) {
  const readErrs = [];
  const index = readJson(path.join(siteRoot, 'tournaments.json'), readErrs);
  const tournaments = new Map();
  if (Array.isArray(index)) {
    for (const t of index) {
      if (!t || typeof t.slug !== 'string' || !ID_RE.test(t.slug)) continue;
      const tfile = path.join(siteRoot, 'tournaments', t.slug + '.json');
      tournaments.set(t.slug, { tjson: readJson(tfile, readErrs) });
    }
  }
  return { index, tournaments, readErrs };
}

// The repo's one tournament-file byte format — a contract: every write and
// every no-op comparison must agree, so a commit diff shows only the edit.
function tournamentText(tjson) {
  return JSON.stringify(tjson, null, 2) + '\n';
}

function writeTournament(siteRoot, slug, tjson) {
  fs.writeFileSync(path.join(siteRoot, 'tournaments', `${slug}.json`), tournamentText(tjson));
}

// Write the index in its established one-entry-per-line shape — pretty-printing
// the whole array would reflow every line on each add, blurring per-tournament
// diffs. Sibling of writeTournament: both byte formats are contracts.
function writeTournamentIndex(siteRoot, entries) {
  fs.writeFileSync(path.join(siteRoot, 'tournaments.json'), '[' + entries.map((t) => `\n  ${JSON.stringify(t)}`).join(',') + '\n]\n');
}

module.exports = { loadRepo, writeTournament, writeTournamentIndex, slotsOverlap, fixedPlayers, isRealDate, findRoot, catCtx, byMatchOrder, tournamentText };
