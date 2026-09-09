'use strict';

// Logic shared by the tools (validator, generator, editor) that the site never
// ships — repo I/O plus tool-only domain predicates. site/ is the shipping
// surface; anything only a tool consumes lives here, so derive.js stays
// exactly the site's domain model. (The "site root" is the directory holding
// tournaments.json — for a real repo that's <repo>/site, for fixtures/ it's
// the fixture directory itself.)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ID_RE, makeCat, schedTime, isDone, matchSlotMs } = require('../site/derive.js');

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

// The outcome rule the tools share: evidence to winner, derived the same way by
// the validator and the editor. The site never runs it — results are stored and
// the renderers read the winner — so per the derive.js tenant rule it lives
// here, not on the site's script. countWins is its private part.
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

// A scheduled match's wall-clock slot window; null when unscheduled or the
// slot length is uncomputable (no slotMinutes anywhere). feederBounds' private
// helper — no site path needs the window itself, only the bounds it sizes.
function schedWindow(m, ctx, tz) {
  const t = schedTime(m, tz);
  if (t === null) return null;
  const ms = matchSlotMs(m, ctx);
  return Number.isNaN(ms) ? null : { start: t, end: t + ms };
}

// Feeder timing bounds on a knockout match's slot start, as wall-clock ms.
// floor: the latest end of the match's own sources — a match-slot feeder's
// slot, plus the feeding pool's last scheduled match (pool matches have no
// slot relations, so the pool's end is its last match's end). ceiling: the
// earliest start of the matches this one feeds — direct consumers only, and
// bounds compose down the chain (M ends ≤ C starts and C ends ≤ Q starts
// imply M ends ≤ Q starts), so a per-match direct ceiling needs no transitive
// walk. A null bound = no scheduled relation constrains that side. Shared by
// the validator gate and the admin daemon's slot preview, so every typed time
// lands behind the same rule — the gate sees the lie too.
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Open a URL in the platform browser — the sim's rehearsal page and the admin
// daemon's start-up both want it; CI skips the launch (no display, a spawn
// would only fail).
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (cmd && !process.env.CI) spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// One static GET under a serving root — MIME by extension, traversal-guarded,
// null when missing. Shared by the sim's served site and the admin daemon page.
function staticFile(root, rel) {
  const file = path.join(root, rel === '' ? 'index.html' : rel);
  if (path.relative(root, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return { body: fs.readFileSync(file), type: MIME[path.extname(file)] || 'application/octet-stream' };
}

// The board's scheduled-unplayed window list — every match that can conflict
// with a placement: {m, t, ctx, players, cat}. noSlot names categories whose
// scheduled matches resolve to no slot length (a warn for the validator, noise
// to a query). Shared by the validator's venue/double-book scan and the admin
// daemon's placement preview — one definition of what is on the board.
function schedEntries(tjson) {
  const entries = [];
  const noSlot = new Set();
  // The raw categories value may be malformed (an object, a null entry) — the
  // validator's shape loop reports those; this scan only skips them, or the
  // gate would crash instead of reporting (never throw).
  for (const cat of Array.isArray(tjson.categories) ? tjson.categories : []) {
    if (!cat || typeof cat !== 'object') continue;
    const ms = tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches) ? tjson.matches[cat.id] : undefined;
    if (!Array.isArray(ms)) continue;
    const ctx = makeCat({ meta: cat, matches: ms }, tjson);
    for (const m of ms) {
      if (!m || typeof m !== 'object' || m.venue === undefined || m.scheduled === undefined) continue;
      if (isDone(m)) continue;
      const t = schedTime(m, tjson.timezone);
      if (t === null) continue;
      if (Number.isNaN(matchSlotMs(m, ctx))) noSlot.add(cat.id);
      entries.push({ m, t, ctx, players: fixedPlayers(m), cat: cat.id });
    }
  }
  return { entries, noSlot };
}

// The slot sources a category's match sides consume, one entry per distinct
// slot keyed to the first match that takes it: pool ranks ("pool:A:1") and
// match edges ("9:winner"). First-wins, so validate's "also by <id>" names
// the earliest owner. Shared by the validator's consumed-twice rule and the
// admin daemon's side-picker legality — one definition of what is taken.
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

// The matches that (transitively) depend on `id` — everything downstream that
// feeds off it. The admin daemon's side picker uses it to keep a feeder choice
// acyclic: pointing `id` at any of its own downstream matches (or at itself)
// would close a cycle. It's a forward scan from `id`'s consumers, so what
// `id` itself points at never skews the set.
// ponytail: O(n²) forward scan over one category — the validator's cycle DFS
// is linear; revisit if a category ever grows past a few hundred matches.
function descendants(matches, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const m of Array.isArray(matches) ? matches : []) {
      if (!m || m.id === id || out.has(m.id)) continue;
      if (Array.isArray(m.sides) && m.sides.some(s => s && s.kind === 'match' && s.match === cur)) {
        out.add(m.id);
        stack.push(m.id);
      }
    }
  }
  return out;
}

// The placement conflicts between two board entries, in the same window:
// venue double-book, else player double-book (venue-blind — a player can't
// be on two courts at once). Empty when the windows don't overlap. The one
// definition of "busy": the validator's scan and the admin daemon's
// placement preview both call it, so a preview can never disagree with the gate.
function pairBusy(a, b) {
  const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
  if (!slotsOverlap(a.t, a.t + aMs, b.t, b.t + bMs)) return [];
  const kinds = [];
  if (a.m.venue === b.m.venue) kinds.push('venue');
  if (a.players && b.players) for (const id of a.players) if (b.players.has(id)) { kinds.push('player'); break; }
  return kinds;
}

module.exports = { loadRepo, writeTournament, writeTournamentIndex, slotsOverlap, fixedPlayers, schedEntries, pairBusy, consumedSlots, descendants, winTarget, reachedWinner, feederBounds, isRealDate, findRoot, catCtx, byMatchOrder, tournamentText, staticFile, openBrowser };
