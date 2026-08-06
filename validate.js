#!/usr/bin/env node
'use strict';

// GitBracket validator — schema + cross-file checks. Zero deps, no package.json.
// Run from the repo root: `node validate.js`. The pre-commit hook wraps this.
// I/O (loadRepo) is separate from checks (validateRepo) so tests can run the
// whole validator against fixtures/ in memory. `node --test` runs the suite.

const fs = require('fs');
const path = require('path');
const { ID_RE, pairSig, matchSlotMs, slotsOverlap, makeCat, isDone, poolStandings, resolveSide, isDeadTie } = require('./site/app.js');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESULTS = ['winner', 'loser'];

function readJson(file, errs) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errs.push(`${file}: not readable JSON (${e.message})`);
    return undefined;
  }
}

// Read a repo root into memory:
// { index, tournaments: Map<slug, { tjson, matches: Map<catId, cjson> }>, readErrs }.
// validateRepo() runs every check on this structure; tests build it from fixtures/.
function loadRepo(root) {
  const readErrs = [];
  const index = readJson(path.join(root, 'tournaments.json'), readErrs);
  const tournaments = new Map();
  if (Array.isArray(index)) {
    for (const t of index) {
      if (!t || typeof t.slug !== 'string' || !ID_RE.test(t.slug)) continue;
      const tdir = path.join(root, 'tournaments', t.slug);
      const tjson = readJson(path.join(tdir, 'tournament.json'), readErrs);
      const matches = new Map();
      let files = [];
      try { files = fs.readdirSync(path.join(tdir, 'matches')); } catch { files = []; } // missing dir = no matches files = valid
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        matches.set(f.slice(0, -5), readJson(path.join(tdir, 'matches', f), readErrs));
      }
      tournaments.set(t.slug, { tjson, matches });
    }
  }
  return { index, tournaments, readErrs };
}

// All checks, in memory. Labels are repo-relative paths (site/tournaments/<slug>/...).
function validateRepo(repo) {
  const errs = [...repo.readErrs];
  const warns = [];
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const warn = (f, m) => warns.push(`${f}: ${m}`);
  const { index, tournaments } = repo;

  if (index === undefined) return { errs, warns }; // tournaments.json unreadable — readErrs carries the message
  if (!Array.isArray(index)) {
    err('tournaments.json', 'must be an array of tournament entries');
    return { errs, warns };
  }

  const seenSlugs = new Set();
  for (let i = 0; i < index.length; i++) {
    const t = index[i];
    const where = `tournaments.json [${i}]`;
    if (!t || typeof t !== 'object') { err(where, 'entry must be an object'); continue; }
    if (typeof t.name !== 'string' || !t.name.trim()) err(where, 'name must be a non-empty string');
    if (typeof t.slug !== 'string' || !ID_RE.test(t.slug)) err(where, `slug ${JSON.stringify(t.slug)} must match ${ID_RE}`);
    if (seenSlugs.has(t.slug)) err(where, `duplicate slug ${t.slug}`);
    seenSlugs.add(t.slug);
  }

  for (const t of index) {
    if (!t || typeof t.slug !== 'string' || !ID_RE.test(t.slug)) continue;
    const info = tournaments.get(t.slug);
    if (info) validateTournamentData(t.slug, info, errs, warns);
  }

  return { errs, warns };
}

function validateTournamentData(slug, info, errs, warns) {
  const tFile = `site/tournaments/${slug}/tournament.json`;
  const tjson = info.tjson;
  if (tjson === undefined) return; // unreadable — readErrs carries the message
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const warn = (f, m) => warns.push(`${f}: ${m}`);
  if (tjson === null) { err(tFile, 'tournament.json must be an object, got null'); return; }

  if (typeof tjson.timezone !== 'string' || !tjson.timezone) {
    err(tFile, 'timezone required');
  } else {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tjson.timezone }); }
    catch { err(tFile, `timezone ${JSON.stringify(tjson.timezone)} is not a valid IANA timezone`); }
  }

  const venues = new Set();
  const categories = new Map();
  const players = new Map();

  (tjson.venues || []).forEach((v, i) => {
    const where = `${tFile} venues[${i}]`;
    if (!v || typeof v !== 'object') { err(where, 'entry must be an object'); return; }
    if (typeof v.id !== 'string' || !ID_RE.test(v.id)) err(where, `id ${JSON.stringify(v.id)} must match ${ID_RE}`);
    if (typeof v.name !== 'string' || !v.name.trim()) err(where, 'name must be a non-empty string');
    if (venues.has(v.id)) err(where, `duplicate venue id ${v.id}`);
    venues.add(v.id);
  });

  (tjson.categories || []).forEach((c, i) => {
    const where = `${tFile} categories[${i}]`;
    if (!c || typeof c !== 'object') { err(where, 'entry must be an object'); return; }
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) err(where, `id ${JSON.stringify(c.id)} must match ${ID_RE}`);
    if (typeof c.name !== 'string' || !c.name.trim()) err(where, 'name must be a non-empty string');
    if (categories.has(c.id)) err(where, `duplicate category id ${c.id}`);
    categories.set(c.id, c);
    const b = c.bestOf;
    if (b !== undefined && (typeof b !== 'object' || b === null)) err(where, 'bestOf must be an object with odd positive groups/knockout numbers');
    const sm = c.slotMinutes;
    if (sm !== undefined && (typeof sm !== 'object' || sm === null)) err(where, 'slotMinutes must be an object with positive-integer groups/knockout minutes');
    else if (sm !== undefined) {
      for (const k of ['groups', 'knockout']) {
        if (sm[k] !== undefined && (typeof sm[k] !== 'number' || !Number.isInteger(sm[k]) || sm[k] < 1)) err(where, `slotMinutes.${k} must be a positive integer, got ${JSON.stringify(sm[k])}`);
      }
    }
  });

  (tjson.players || []).forEach((p, i) => {
    const where = `${tFile} players[${i}]`;
    if (!p || typeof p !== 'object') { err(where, 'entry must be an object'); return; }
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) err(where, `id ${JSON.stringify(p.id)} must match ${ID_RE}`);
    if (typeof p.name !== 'string' || !p.name.trim()) err(where, 'name must be a non-empty string');
    if (players.has(p.id)) err(where, `duplicate player id ${p.id}`);
    players.set(p.id, p);
    if (!Array.isArray(p.categories)) { err(where, 'categories must be an array of category ids'); return; }
    for (const cid of p.categories) {
      if (typeof cid !== 'string' || !categories.has(cid)) err(where, `unknown category ${JSON.stringify(cid)}`);
    }
  });

  const mdir = `site/tournaments/${slug}/matches`;
  for (const cid of info.matches.keys()) {
    if (!categories.has(cid)) err(`${mdir}/${cid}.json`, `file maps to undeclared category ${JSON.stringify(cid)} — a filename typo would silently render an empty category`);
  }

  for (const cat of categories.values()) {
    const cjson = info.matches.get(cat.id);
    if (cjson === undefined) continue; // category with no matches file is valid
    validateCategory(`${mdir}/${cat.id}.json`, cjson, cat, players, venues, tjson, errs, warns);
  }

  // ---- venue overlap on unplayed scheduled matches, across ALL categories ----
  // Per-category scope would miss a court double-booked by two categories. A
  // match's window is its effective slot (match slotMinutes > per-stage
  // category slotMinutes > default), so a long final can collide with the next match
  // even when starts are more than the default apart.
  const sched = [];
  for (const cat of categories.values()) {
    const cjson = info.matches.get(cat.id);
    if (cjson === undefined || typeof cjson !== 'object' || !Array.isArray(cjson.matches)) continue;
    const ctx = makeCat({ meta: cat, matches: cjson.matches }, tjson);
    for (const m of cjson.matches) {
      if (!m || typeof m !== 'object' || m.venue === undefined || m.scheduled === undefined) continue;
      if (isDone(m, ctx)) continue;
      const t = Date.parse(m.scheduled);
      if (Number.isNaN(t)) continue;
      sched.push({ f: `${mdir}/${cat.id}.json`, m, t, ctx });
    }
  }
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j];
      if (a.m.venue !== b.m.venue) continue;
      const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
      if (slotsOverlap(a.t, a.t + aMs, b.t, b.t + bMs)) {
        err(a.f, `${a.m.id} and ${b.m.id} overlap at venue ${a.m.venue} (${aMs / 60000}-minute and ${bMs / 60000}-minute slots) — ${b.f} also schedules ${b.m.id}`);
      }
    }
  }
}

function validateCategory(cFile, cjson, cat, players, venues, tjson, errs, warns) {
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const warn = (f, m) => warns.push(`${f}: ${m}`);
  if (typeof cjson !== 'object' || cjson === null) { err(cFile, 'must be an object'); return; }
  const matches = cjson.matches;
  if (!Array.isArray(matches)) { err(cFile, 'matches must be an array'); return; }

  const bestOf = cat.bestOf;
  const stageBest = stage => (bestOf && typeof bestOf[stage] === 'number' && bestOf[stage] % 2 === 1 && bestOf[stage] > 0)
    ? bestOf[stage] : undefined;

  const byId = new Map();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const where = `${cFile} match[${i}]`;
    if (!m || typeof m !== 'object') { err(where, 'must be an object'); continue; }
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) err(where, `id ${JSON.stringify(m.id)} must match ${ID_RE}`);
    if (byId.has(m.id)) err(where, `duplicate match id ${m.id}`);
    byId.set(m.id, m);
  }

  const roster = new Set([...players.values()].filter(p => (p.categories || []).includes(cat.id)).map(p => p.id));
  let hasPool = false;
  let hasKnockout = false;
  const poolUses = new Map(); // pool -> Set<side sig>
  const pairByPlayer = new Map(); // playerId -> side sig
  const pairSizes = new Set();

  // ---- pass A: shape, roster, pairs, pool membership ----
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const where = `${cFile} match ${m.id || '?'}`;
    if (m.pool !== undefined) {
      hasPool = true;
      if (typeof m.pool !== 'string') err(where, `pool must be a string, got ${JSON.stringify(m.pool)}`);
      else if (!m.pool.trim()) err(where, 'pool must be a non-empty string');
    } else {
      hasKnockout = true;
    }

    if (m.slotMinutes !== undefined && (typeof m.slotMinutes !== 'number' || !Number.isInteger(m.slotMinutes) || m.slotMinutes < 1)) err(where, `slotMinutes must be a positive integer, got ${JSON.stringify(m.slotMinutes)}`);

    if (!Array.isArray(m.sides) || m.sides.length !== 2) { err(where, 'exactly two sides required'); continue; }
    m.sides.forEach((side, si) => {
      if (!side || typeof side !== 'object') { err(where, `side ${si} must be an object`); return; }
      if (side.kind === 'players') {
        if (!Array.isArray(side.ids) || side.ids.length === 0 || side.ids.some(id => typeof id !== 'string')) {
          err(where, `side ${si}: ids must be a non-empty array of strings`);
          return;
        }
        if (new Set(side.ids).size !== side.ids.length) err(where, `side ${si}: duplicate player id in side`);
        for (const pid of side.ids) {
          if (!roster.has(pid)) err(where, `side ${si}: player ${pid} is not in category ${cat.id}`);
        }
        const sig = pairSig(side.ids);
        if (m.pool !== undefined) {
          if (!poolUses.has(m.pool)) poolUses.set(m.pool, new Set());
          poolUses.get(m.pool).add(sig);
        }
        pairSizes.add(side.ids.length);
        for (const pid of side.ids) {
          const prev = pairByPlayer.get(pid);
          if (prev && prev !== sig) err(where, `player ${pid} has two partners in category ${cat.id} (${prev} vs ${sig}) — pairs are fixed per category`);
          pairByPlayer.set(pid, sig);
        }
      } else if (side.kind === 'match') {
        if (m.pool !== undefined) err(where, `side ${si}: a pool match cannot have a match slot — pools are round robin`);
        if (typeof side.match !== 'string' || !byId.has(side.match)) err(where, `side ${si}: unknown match slot ${JSON.stringify(side.match)}`);
        if (!RESULTS.includes(side.result)) err(where, `side ${si}: match slot result must be winner or loser, got ${JSON.stringify(side.result)}`);
      } else if (side.kind === 'pool') {
        if (m.pool !== undefined) err(where, `side ${si}: a pool match cannot have a pool slot — pools are round robin`);
        if (typeof side.pool !== 'string') err(where, `side ${si}: pool slot needs a pool string`);
        if (typeof side.rank !== 'number' || !Number.isInteger(side.rank) || side.rank < 1) err(where, `side ${si}: pool slot rank must be a positive integer, got ${JSON.stringify(side.rank)}`);
      } else {
        err(where, `side ${si}: unknown side kind ${JSON.stringify(side.kind)}`);
      }
    });

    if (m.sides[0] && m.sides[1] && m.sides[0].kind === 'players' && m.sides[1].kind === 'players') {
      if (pairSig(m.sides[0].ids) === pairSig(m.sides[1].ids)) err(where, 'the two sides are the same player set');
    }
  }

  if (pairSizes.size > 1) err(cFile, `category ${cat.id} mixes singles and doubles sides (sizes ${[...pairSizes].join(', ')})`);
  for (const [pool, sigs] of poolUses) {
    if (sigs.size < 2) err(cFile, `pool ${JSON.stringify(pool)} has fewer than two distinct sides`);
  }
  if (hasPool && !stageBest('groups')) err(cFile, `category ${cat.id}: groups stage in use but bestOf.groups is not an odd positive number`);
  if (hasKnockout && !stageBest('knockout')) err(cFile, `category ${cat.id}: knockout stage in use but bestOf.knockout is not an odd positive number`);

  // ---- acyclicity (before pass B: resolveSide recurses through slots, a cycle must be rejected first) ----
  const state = new Map(); // 1 = visiting, 2 = done
  let cycle = null;
  const visit = (m) => {
    const s = state.get(m.id);
    if (s === 2) return;
    if (s === 1) { cycle = m.id; return; }
    state.set(m.id, 1);
    for (const side of m.sides) {
      if (side && side.kind === 'match') {
        const ref = byId.get(side.match);
        if (ref) {
          visit(ref);
          if (cycle) return;
        }
      }
    }
    state.set(m.id, 2);
  };
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    visit(m);
    if (cycle) break;
  }
  if (cycle) {
    err(cFile, `slot cycle detected at match ${cycle}`);
    return; // pass B would recurse forever on a cyclic DAG
  }

  // ---- derived state used below (shared with app.js) ----
  const ctx = makeCat({ meta: cat, matches }, tjson);
  function checkScheduled(s, where) {
    if (typeof s !== 'string' || !ISO_RE.test(s)) {
      err(where, `scheduled ${JSON.stringify(s)} must be ISO-8601 with an explicit offset, e.g. 2025-07-14T09:00:00-04:00`);
      return;
    }
    if (Number.isNaN(Date.parse(s))) err(where, `scheduled ${s} does not parse as an instant`);
    const hh = Number(s.slice(11, 13)); // Date.parse rolls 24:00 over to the next day; catch it
    if (hh > 23) err(where, `scheduled ${s} has hour ${hh} — hours run 00-23`);
    const om = /[+-](\d{2}):(\d{2})$/.exec(s);
    if (om) {
      const oh = Number(om[1]), omm = Number(om[2]);
      if (oh > 14 || (oh === 14 && omm > 0) || omm > 59) {
        err(where, `scheduled ${s} offset ${om[0]} is outside ISO-8601's ±14:00 — a typo here silently shifts every instant`);
      }
    }
    // Date.parse rolls over impossible calendar dates (2025-02-30 -> Mar 2); catch them.
    const [y, mo, da] = s.slice(0, 10).split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1, da));
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) err(where, `scheduled ${s} is not a real calendar date`);
  }

  // ---- pass B: slots, scoring, scheduling ----
  const sources = new Map(); // slot source key -> owning match id
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const where = `${cFile} match ${m.id || '?'}`;
    if (m.bestOf !== undefined && (typeof m.bestOf !== 'number' || m.bestOf % 2 !== 1 || m.bestOf < 1)) {
      err(where, `bestOf override must be an odd positive integer, got ${JSON.stringify(m.bestOf)}`);
    }

    if (Array.isArray(m.sides) && m.sides.length === 2) {
      m.sides.forEach((side, si) => {
        if (!side || typeof side !== 'object') return;
        if (side.kind === 'match') {
          const key = `${side.match}:${side.result}`;
          if (sources.has(key)) err(where, `slot source ${key} is consumed twice (also by ${sources.get(key)})`);
          else sources.set(key, m.id);
        } else if (side.kind === 'pool') {
          const key = `pool:${side.pool}:${side.rank}`;
          if (sources.has(key)) err(where, `slot source ${key} is consumed twice (also by ${sources.get(key)})`);
          else sources.set(key, m.id);
          if (typeof side.pool === 'string' && typeof side.rank === 'number' && Number.isInteger(side.rank) && side.rank >= 1) {
            if (!poolUses.has(side.pool)) {
              err(where, `pool slot references unknown pool ${JSON.stringify(side.pool)} (no matches use it)`);
            } else if (side.rank > poolUses.get(side.pool).size) {
              err(where, `pool slot rank ${side.rank} out of range — pool ${JSON.stringify(side.pool)} has ${poolUses.get(side.pool).size} side(s)`);
            } else {
              const st = poolStandings(ctx, side.pool);
              if (st && isDeadTie(st, side.rank)) {
                warn(where, `pool slot rank ${side.rank} is a dead tie — the slot renders TBD; replace the source with explicit players or a decider`);
              }
            }
          }
        }
      });
    }

    if (m.games !== undefined && !Array.isArray(m.games)) err(where, `games must be an array of {a, b} game objects, got ${JSON.stringify(m.games)}`);
    const hasGames = Array.isArray(m.games);
    const hasForfeit = m.forfeit !== undefined;
    if (hasGames && hasForfeit) err(where, 'games and forfeit are mutually exclusive');
    if (hasGames) {
      const b = (typeof m.bestOf === 'number' ? m.bestOf : stageBest(m.pool !== undefined ? 'groups' : 'knockout'));
      const target = (b !== undefined && b % 2 === 1) ? (b + 1) / 2 : undefined;
      validateGames(m.games, target, where, err);
    }
    if (hasForfeit && m.forfeit !== 0 && m.forfeit !== 1) {
      err(where, `forfeit must index a side (0 or 1), got ${JSON.stringify(m.forfeit)}`);
    }
    if ((hasGames || hasForfeit) && Array.isArray(m.sides) && m.sides.length === 2) {
      if (!resolveSide(m.sides[0], ctx) || !resolveSide(m.sides[1], ctx)) {
        err(where, 'scored match must have both sides resolved to players — check the pool or match feeding the unresolved side');
      }
    }

    if (m.scheduled !== undefined) checkScheduled(m.scheduled, where);
    if (m.venue !== undefined && typeof m.venue !== 'string') {
      err(where, `venue must be a venue id string, got ${JSON.stringify(m.venue)}`);
    } else if (m.venue !== undefined && !venues.has(m.venue)) {
      err(where, `unknown venue ${JSON.stringify(m.venue)}`);
    }
  }
}

function validateGames(games, target, where, err) {
  const wins = [0, 0];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g || typeof g !== 'object' || !Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0) {
      err(where, `games[${i}] must be non-negative integer scores`);
      continue;
    }
    if (g.a === g.b) { err(where, `games[${i}] has no winner (a equals b)`); continue; }
    if (target === undefined) continue;
    if (wins[0] >= target || wins[1] >= target) {
      err(where, `games[${i}] recorded after a side already reached the target of ${target}`);
      continue;
    }
    if (g.a > g.b) wins[0]++; else wins[1]++;
  }
}

function main() {
  const root = process.argv[2] || process.cwd();
  const { errs, warns } = validateRepo(loadRepo(path.join(root, 'site')));
  for (const w of warns) console.log(`warn: ${w}`);
  for (const e of errs) console.log(`error: ${e}`);
  if (errs.length) {
    console.log(`validate: ${errs.length} error(s) — fix and re-commit`);
    process.exit(1);
  }
  console.log(warns.length ? `validate: ok (${warns.length} warning(s))` : 'validate: ok');
}

if (require.main === module) main();

module.exports = { loadRepo, validateRepo };
