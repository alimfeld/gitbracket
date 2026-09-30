'use strict';

// Tool-only logic: repo I/O plus domain predicates the site never ships. (The
// site root holds tournaments.json: <repo>/site or a fixtures/ dir.)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ID_RE, makeCat, matchesOf, schedTime, isDone, matchSlotMs, resolveSide, schedDays } = require('../site/derive.js');

// Window collision, shared by the validator and the generator.
const slotsOverlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// Resolved-side equality; null is unresolved, so two TBD sides are equal too.
const sameSet = (a, b) => a === null || b === null ? a === b : a.size === b.size && [...a].every(x => b.has(x));

// A non-null, non-array object.
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Explicit players as a Set, null when either side is a slot.
function fixedPlayers(m) {
  return Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every(s => s && s.kind === 'players' && Array.isArray(s.ids))
    ? new Set(m.sides.flatMap(s => s.ids)) : null;
}

// Players a match resolves to — explicit sides at once, pool/edge sides once their
// source is decided. Null when no side resolves yet.
function resolvedPlayers(m, ctx) {
  if (!Array.isArray(m.sides) || m.sides.length !== 2) return null;
  const ids = new Set();
  for (const s of m.sides) {
    const r = resolveSide(s, ctx);
    if (r) for (const id of r) ids.add(id);
  }
  return ids.size ? ids : null;
}

// The category context a tool pass iterates (find + makeCat).
function catCtx(tjson, cid) {
  // A non-array categories/matches entry renders as absent (toCats' guard) — never throws.
  const cats = Array.isArray(tjson.categories) ? tjson.categories : [];
  const ms = matchesOf(tjson)?.[cid];
  return makeCat({ meta: cats.find(c => plainObject(c) && c.id === cid), matches: Array.isArray(ms) ? ms : [] }, tjson);
}

// Evidence to winner; shared by validator and editor (the site reads the stored winner).
function countWins(games) {
  const w = [0, 0];
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    if (g.a > g.b) w[0]++;
    else if (g.b > g.a) w[1]++;
  }
  return w;
}

// The games needed to decide, or null when the stage has no valid bestOf.
const winTarget = b => (typeof b === 'number' && b % 2 === 1) ? (b + 1) / 2 : null;

// The side ('a'|'b') the games at target decide, null while undecided.
function reachedWinner(games, target) {
  if (target === null) return null;
  const [w0, w1] = countWins(games);
  return w0 >= target ? 'a' : w1 >= target ? 'b' : null;
}

// A scheduled match's wall-clock slot window (feederBounds' helper).
function schedWindow(m, ctx, tz) {
  const t = schedTime(m, tz);
  if (t === null) return null;
  const ms = matchSlotMs(m, ctx);
  return Number.isNaN(ms) ? null : { start: t, end: t + ms };
}

// Feeder timing bounds: floor = latest source end, ceiling = earliest consumer start
// (direct only, since bounds compose). Null = unconstrained.
function feederBounds(m, ctx, tz) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.sides)) return null;
  let floor = null, ceiling = null;
  for (const s of m.sides) {
    if (!s || typeof s !== 'object') continue;
    if (s.kind === 'match') {
      const f = ctx.byId.get(s.match);
      if (f && f !== m) {
        const fw = schedWindow(f, ctx, tz);
        if (fw) floor = Math.max(floor ?? fw.end, fw.end);
      }
    } else if (s.kind === 'pool' && s.pool !== undefined) {
      let pend = null;
      for (const pm of ctx.matches) {
        if (!pm || pm.pool !== s.pool) continue;
        const pw = schedWindow(pm, ctx, tz);
        if (pw) pend = Math.max(pend ?? pw.end, pw.end);
      }
      if (pend !== null) floor = Math.max(floor ?? pend, pend);
    }
  }
  for (const d of ctx.matches) {
    if (!d || d === m || !Array.isArray(d.sides) || d.scheduled === undefined) continue;
    if (!d.sides.some(s => s && s.kind === 'match' && s.match === m.id)) continue;
    const dw = schedWindow(d, ctx, tz);
    if (dw) ceiling = ceiling === null ? dw.start : Math.min(ceiling, dw.start);
  }
  return { floor, ceiling };
}

// Impossible dates roll over in Date.UTC; check the round-trip.
function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Walk up to the ancestor holding site/tournaments.json, so `node gb.js` works
// from anywhere under the repo.
function findRoot(from) {
  let dir = from || process.cwd();
  while (!fs.existsSync(path.join(dir, 'site', 'tournaments.json')) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return dir;
}

// site/CNAME trimmed, null when missing.
function cnameOf(root) {
  try { return fs.readFileSync(path.join(root, 'site', 'CNAME'), 'utf8').trim(); }
  catch { return null; }
}

// Current branch ('', detached HEAD).
function branchOf(root) {
  const r = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return r.code === 0 ? r.out.trim() : '';
}

// Sim branches never merge.
const isSimBranch = b => /^sim\//.test(b);

// No tracked edits in progress; untracked files survive reset and checkout, so they
// don't block undo.
function cleanTree(root) {
  const s = git(root, ['status', '--porcelain', '--untracked-files=no']);
  return s.code === 0 && s.out.trim() === '';
}

// A hook commit exports GIT_INDEX_FILE/GIT_DIR pointing at the live repo (an
// absolute temp index for a pathspec commit); a scratch repo's git would then
// read/write the live one. Scrub them before every spawn.
const GIT_ENV_TARGETS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
function gitEnv(base = process.env) {
  const env = { ...base };
  for (const k of GIT_ENV_TARGETS) delete env[k];
  return env;
}

// spawnSync, not execSync — execSync has no argv array, so args would be baked
// into the shell string, breaking ids with spaces or quotes.
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv() });
  return { code: r.status === 0 ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };
}

// The daemon's default: the last index entry with a readable file.
function defaultSlug(repo) {
  if (!repo.index.length) return null;
  const last = repo.index[repo.index.length - 1];
  const info = last && repo.tournaments.get(last.slug);
  return info && info.tjson ? last.slug : null;
}

function readJson(file, errs) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errs.push(`${file}: not readable JSON (${e.message})`);
    return undefined;
  }
}

// Read a site root into memory: { index, tournaments: Map<slug, { tjson }>, readErrs }.
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

// Every scheduled day of a tournament file, as sorted ISO keys.
const daysOf = tjson => schedDays(Object.values((tjson && tjson.matches) || {}).flat(), (tjson && tjson.timezone) || 'UTC');

// The one tournament-file byte format; writes and no-op comparisons must agree.
function tournamentText(tjson) {
  return JSON.stringify(tjson, null, 2) + '\n';
}

// Atomic write: tmp + rename, so an overlapping reader never sees a partial file.
function writeFileAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function writeTournament(siteRoot, slug, tjson) {
  writeFileAtomic(path.join(siteRoot, 'tournaments', `${slug}.json`), tournamentText(tjson));
}

// One entry per line, so adding a tournament doesn't reflow the whole index.
function writeTournamentIndex(siteRoot, entries) {
  writeFileAtomic(path.join(siteRoot, 'tournaments.json'), '[' + entries.map((t) => `\n  ${JSON.stringify(t)}`).join(',') + '\n]\n');
}

// Scheduled-unplayed windows: {m, t, ctx, players, cat}; noSlot names categories
// with no resolvable slot length. players is the resolved set, so a slot-fed side
// double-books exactly like an explicit one.
function schedEntries(tjson) {
  const entries = [];
  const noSlot = new Set();
  // Skip malformed categories — the validator's shape loop reports them (never throw).
  for (const cat of Array.isArray(tjson.categories) ? tjson.categories : []) {
    if (!cat || typeof cat !== 'object') continue;
    const ms = matchesOf(tjson)?.[cat.id];
    if (!Array.isArray(ms)) continue;
    const ctx = makeCat({ meta: cat, matches: ms }, tjson);
    for (const m of ms) {
      // Scheduled, not necessarily placed: a venue-less match still occupies its players'
      // wall time, so it feeds the double-book scan and the no-slot check like any other.
      if (!m || typeof m !== 'object' || m.scheduled === undefined) continue;
      if (isDone(m)) continue;
      const t = schedTime(m, tjson.timezone);
      if (t === null) continue;
      if (Number.isNaN(matchSlotMs(m, ctx))) noSlot.add(cat.id);
      entries.push({ m, t, ctx, players: resolvedPlayers(m, ctx), cat: cat.id });
    }
  }
  return { entries, noSlot };
}

// Slot sources a category's sides consume, keyed to the first owner:
// pool ranks ("pool:A:1") and match edges ("9:winner").
function consumedSlots(matches) {
  const pool = new Map(), edge = new Map();
  for (const m of Array.isArray(matches) ? matches : []) {
    if (!m || !Array.isArray(m.sides) || m.sides.length !== 2) continue;
    m.sides.forEach((side) => {
      if (!side || typeof side !== 'object') return;
      if (side.kind === 'match') {
        const key = `${side.match}:${side.result}`;
        if (!edge.has(key)) edge.set(key, m.id);
      } else if (side.kind === 'pool') {
        const key = `pool:${side.pool}:${side.rank}`;
        if (!pool.has(key)) pool.set(key, m.id);
      }
    });
  }
  return { pool, edge };
}

// Conflicts between two entries in the same window: venue double-book, else player
// double-book. The one definition of "busy".
function pairBusy(a, b) {
  const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
  if (!slotsOverlap(a.t, a.t + aMs, b.t, b.t + bMs)) return [];
  const kinds = [];
  if (a.m.venue !== undefined && a.m.venue === b.m.venue) kinds.push('venue'); // two unplaced matches share no court
  if (a.players && b.players) for (const id of a.players) if (b.players.has(id)) { kinds.push('player'); break; }
  return kinds;
}

module.exports = { loadRepo, writeTournament, writeTournamentIndex, slotsOverlap, plainObject, fixedPlayers, schedEntries, pairBusy, consumedSlots, winTarget, reachedWinner, feederBounds, isRealDate, findRoot, catCtx, tournamentText, cnameOf, branchOf, isSimBranch, cleanTree, git, gitEnv, defaultSlug, sameSet, daysOf };
