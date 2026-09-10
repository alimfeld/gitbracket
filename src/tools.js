'use strict';

// Tool-only logic — repo I/O plus domain predicates the site never ships, so
// derive.js stays exactly the site's model. (The "site root" is the directory
// holding tournaments.json: <repo>/site, or a fixtures/ dir.)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ID_RE, makeCat, schedTime, isDone, matchSlotMs } = require('../site/derive.js');

// Window collision: shared by the validator's venue rule and the generator's
// occupancy — one predicate, no drift.
const slotsOverlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// A match's known players as a Set, null when a side is a slot (match/pool) —
// such sides resolve only after results. Shared by the validator and generator.
function fixedPlayers(m) {
  return Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every(s => s && s.kind === 'players' && Array.isArray(s.ids))
    ? new Set(m.sides.flatMap(s => s.ids)) : null;
}

// The one category context a tool pass iterates — editor and admin both build
// it, so the find+makeCat lookup lives here.
function catCtx(tjson, cid) {
  return makeCat({ meta: (tjson.categories || []).find(c => c.id === cid), matches: (tjson.matches || {})[cid] || [] }, tjson);
}

// Evidence to winner, derived the same way by validator and editor. The site
// never runs it — renderers read the stored winner — so it lives here, not on
// the site's script.
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

// Random games for a rehearsal score: the winner takes the target games, the
// loser's wins leading so neither side reaches the target before the last
// game (the validator's rule); deuce games a fifth of the time.
function makeGames(bestOf) {
  const target = (bestOf + 1) / 2;
  const n = target + Math.floor(Math.random() * (bestOf - target + 1));
  const winnerIsA = Math.random() < 0.5;
  const games = [];
  for (let i = 0; i < n; i++) {
    const aWins = i < n - target ? !winnerIsA : winnerIsA;
    const deuce = Math.random() < 0.2;
    const ws = deuce ? 12 + Math.floor(Math.random() * 5) : 11;
    const ls = deuce ? ws - 2 : Math.floor(Math.random() * 10);
    games.push(aWins ? { a: ws, b: ls } : { a: ls, b: ws });
  }
  return games;
}

// The side ('a'|'b') the games at target decide, null while undecided.
function reachedWinner(games, target) {
  if (target === null) return null;
  const [w0, w1] = countWins(games);
  return w0 >= target ? 'a' : w1 >= target ? 'b' : null;
}

// A scheduled match's wall-clock slot window; null when unscheduled or the
// slot length is uncomputable. feederBounds' private helper.
function schedWindow(m, ctx, tz) {
  const t = schedTime(m, tz);
  if (t === null) return null;
  const ms = matchSlotMs(m, ctx);
  return Number.isNaN(ms) ? null : { start: t, end: t + ms };
}

// Feeder timing bounds on a knockout match's slot start. floor: the latest end
// of the match's sources (its match-slot feeder, plus the pool's last
// scheduled match). ceiling: the earliest start of what it feeds — direct
// consumers only, since bounds compose down the chain. Null = unconstrained.
// Shared by the validator and the admin slot preview.
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

// Walk up to the ancestor holding site/tournaments.json, so `node gb.js` works
// from anywhere under the repo.
function findRoot(from) {
  let dir = from || process.cwd();
  while (!fs.existsSync(path.join(dir, 'site', 'tournaments.json')) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return dir;
}

// site/CNAME as text (trimmed), null when missing — publish's deploy role and
// sim's teardown gate on the same read; one source, the two can't disagree.
function cnameOf(root) {
  try { return fs.readFileSync(path.join(root, 'site', 'CNAME'), 'utf8').trim(); }
  catch { return null; }
}

// The current branch name ('' on a detached HEAD) — what publish, admin, and
// sim gate on.
function branchOf(root) {
  const r = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return r.code === 0 ? r.out.trim() : '';
}

// Rehearsal branches never merge — one predicate, so admin's score-wave gate
// and sim's teardown agree on what a rehearsal is.
const isRehearsalBranch = b => /^rehearsal\//.test(b);

// A pristine tree — no staged, unstaged, or untracked changes. The admin's
// undo/redo resets and sim's teardown both require it; one predicate, so the
// two mirrors can't drift on what "clean" means.
function cleanTree(root) {
  const s = git(root, ['status', '--porcelain']);
  return s.code === 0 && s.out.trim() === '';
}

// spawnSync, not execSync — execSync has no argv array, so args would be baked
// into the shell string, breaking ids with spaces or quotes.
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { code: r.status === 0 ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };
}

// The daemon's default tournament — the last index entry it can actually read
// (a null file would crash every command).
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

// Read a site root into memory: { index, tournaments: Map<slug, { tjson }>,
// readErrs }. The file is the one view of the data — no parallel Map to keep
// identical.
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

// One entry per line — pretty-printing the whole array would reflow every line
// on each add, blurring per-tournament diffs.
function writeTournamentIndex(siteRoot, entries) {
  fs.writeFileSync(path.join(siteRoot, 'tournaments.json'), '[' + entries.map((t) => `\n  ${JSON.stringify(t)}`).join(',') + '\n]\n');
}

// The board's scheduled-unplayed windows: {m, t, ctx, players, cat}. noSlot
// names categories with no resolvable slot length (a warn for the validator).
// Shared by the validator's scan and the admin placement preview.
function schedEntries(tjson) {
  const entries = [];
  const noSlot = new Set();
  // Skip malformed categories — the validator's shape loop reports them (never throw).
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

// The slot sources a category's sides consume, keyed to the first match that
// takes each: pool ranks ("pool:A:1") and match edges ("9:winner"), first-wins
// so the validator's "also by <id>" names the earliest owner. Shared by the
// validator and the admin side picker.
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

// Everything (transitively) downstream of `id` — the admin side picker uses it
// to keep a feeder choice acyclic: pointing `id` at its own downstream would
// close a cycle. A forward scan from id's consumers, so what id points at
// never skews the set.
// ponytail: O(n²) forward scan — revisit if a category ever grows past a few
// hundred matches (the validator's cycle DFS is linear).
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

// Placement conflicts between two board entries in the same window: venue
// double-book, else player double-book (a player can't be on two courts).
// Empty when the windows don't overlap. The one definition of "busy" — the
// validator and the admin preview share it.
function pairBusy(a, b) {
  const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
  if (!slotsOverlap(a.t, a.t + aMs, b.t, b.t + bMs)) return [];
  const kinds = [];
  if (a.m.venue === b.m.venue) kinds.push('venue');
  if (a.players && b.players) for (const id of a.players) if (b.players.has(id)) { kinds.push('player'); break; }
  return kinds;
}

module.exports = { loadRepo, writeTournament, writeTournamentIndex, slotsOverlap, fixedPlayers, schedEntries, pairBusy, consumedSlots, descendants, winTarget, reachedWinner, makeGames, feederBounds, isRealDate, findRoot, catCtx, tournamentText, cnameOf, branchOf, isRehearsalBranch, cleanTree, git, defaultSlug };
