'use strict';

// GitBracket validator — schema + cross-file checks, run via `node gb.js
// validate [slug]`. I/O (loadRepo in src/tools.js) is separate from checks
// (validateRepo) so tests can run the whole validator against fixtures/ in
// memory. Never writes — the gate stays pure.

const path = require('path');
const { loadRepo, isRealDate, slotsOverlap } = require('./tools.js');
const { LOCALE, DATE_RE, ID_RE, ISO_RE, pairSig, matchSlotMs, makeCat, isDone, poolStandings, resolveSide, isDeadTie, bestOfOf, countWins, schedTime, schedDays, placementLabel } = require('../site/derive.js');

const RESULTS = ['winner', 'loser'];
const RESULT_STATUSES = ['played', 'walkover', 'void'];
// The standings-impact contract, one rule per status (derive.js's counting is
// the same switch): played counts win+gd/pd from games; walkover counts a win
// only; void counts nothing and settles the match.
function validateResultShape(r, hasGames, target, m, where, err) {
  if (!RESULT_STATUSES.includes(r.status)) {
    err(where, `result.status must be one of ${RESULT_STATUSES.join(', ')}, got ${JSON.stringify(r.status)}`);
  } else if (r.status === 'void') {
    if (r.winner !== undefined) err(where, 'a void result has no winner');
    else if (hasGames) err(where, 'games and a void result are mutually exclusive');
  } else {
    if (r.winner !== 'a' && r.winner !== 'b') err(where, `result.winner must be 'a' or 'b', got ${JSON.stringify(r.winner)}`);
    if (r.status === 'played') {
      if (!hasGames) err(where, 'a played result records the games it was decided by');
      else if (typeof target === 'number') {
        const [w0, w1] = countWins(m.games);
        if (w0 < target && w1 < target) err(where, 'a played result needs games that reach the best-of target');
        else {
          const derived = w0 >= target ? 'a' : 'b';
          if (derived !== r.winner) err(where, `result.winner '${r.winner}' does not match the games — side ${derived} won`);
        }
      }
    } else if (hasGames) {
      err(where, 'games and a walkover result are mutually exclusive');
    }
  }
}

// All checks, in memory. Labels are repo-relative paths (site/tournaments/<slug>/...).
function validateRepo(repo) {
  const errs = [...repo.readErrs];
  const warns = [];
  const err = (f, m) => errs.push(`${f}: ${m}`);
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
    if (typeof t.location !== 'string' || !t.location.trim()) err(where, 'location must be a non-empty string');
    if (t.dates !== undefined && (!Array.isArray(t.dates) || !t.dates.length || !t.dates.every(d => typeof d === 'string' && DATE_RE.test(d)))) err(where, 'dates must be a non-empty array of YYYY-MM-DD when present');
    if (typeof t.slug !== 'string' || !ID_RE.test(t.slug)) {
      err(where, `slug ${JSON.stringify(t.slug)} must match ${ID_RE}`);
      continue; // never track or look up a malformed slug
    }
    if (seenSlugs.has(t.slug)) err(where, `duplicate slug ${t.slug}`);
    seenSlugs.add(t.slug);
    const info = tournaments.get(t.slug);
    if (info) validateTournamentData(t.slug, t.name, t.location, t.dates, info, errs, warns);
  }

  return { errs, warns };
}

function validateTournamentData(slug, indexName, indexLocation, indexDates, info, errs, warns) {
  const tFile = `site/tournaments/${slug}.json`;
  const tjson = info.tjson;
  if (tjson === undefined) return; // unreadable — readErrs carries the message
  const err = (f, m) => errs.push(`${f}: ${m}`);
  if (tjson === null) { err(tFile, 'must be an object, got null'); return; }

  // The tournament page loads only this file (never the index), so the name
  // must live here too; the index copy exists for the list page — keep them equal.
  if (typeof tjson.name !== 'string' || !tjson.name.trim()) {
    err(tFile, 'name must be a non-empty string');
  } else if (tjson.name !== indexName) {
    err(tFile, `name ${JSON.stringify(tjson.name)} does not match the index entry ${JSON.stringify(indexName)}`);
  }

  // the list shows the index copy, the page the file's — they must agree
  if (typeof tjson.location !== 'string' || !tjson.location.trim()) {
    err(tFile, 'location must be a non-empty string');
  } else if (typeof indexLocation === 'string' && tjson.location !== indexLocation) {
    err(tFile, `location ${JSON.stringify(tjson.location)} does not match the index entry ${JSON.stringify(indexLocation)}`);
  }

  // the index copy must match the file's days — mirrors the name check above
  // mjson: matches as a plain object, or null when malformed (reported above)
  const mjson = tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches) ? tjson.matches : null;
  let tzOk = false;
  if (typeof tjson.timezone !== 'string' || !tjson.timezone) {
    err(tFile, 'timezone required');
  } else {
    try {
      new Intl.DateTimeFormat(LOCALE, { timeZone: tjson.timezone });
      tzOk = true;
    }
    catch { err(tFile, `timezone ${JSON.stringify(tjson.timezone)} is not a valid IANA timezone`); }
  }
  if (tzOk) {
    const derived = schedDays(Object.values(tjson.matches || {}).flat(), tjson.timezone);
    if (indexDates === undefined) {
      if (derived.length) err(tFile, `dates missing — the schedule spans ${JSON.stringify(derived)}`);
    } else {
      const same = derived.length === indexDates.length && derived.every((d, i) => d === indexDates[i]);
      if (!same) {
        err(tFile, derived.length === 0
          ? `dates ${JSON.stringify(indexDates)} but the tournament schedules no matches`
          : `dates ${JSON.stringify(indexDates)} does not match the schedule ${JSON.stringify(derived)}`);
      }
    }
  }

  const venues = new Set();
  const categories = new Map();
  const players = new Map();

  // Array-top-level shape: a non-array here used to crash the validator mid-
  // run (forEach on a string) instead of reporting; the gate must never throw.
  const list = (v, field) => {
    if (v !== undefined && !Array.isArray(v)) err(tFile, `${field} must be an array, got ${JSON.stringify(v)}`);
    return Array.isArray(v) ? v : [];
  };
  const venuesArr = list(tjson.venues, 'venues');
  const categoriesArr = list(tjson.categories, 'categories');
  const playersArr = list(tjson.players, 'players');

  venuesArr.forEach((v, i) => {
    const where = `${tFile} venues[${i}]`;
    if (!v || typeof v !== 'object') { err(where, 'entry must be an object'); return; }
    if (typeof v.id !== 'string' || !ID_RE.test(v.id)) err(where, `id ${JSON.stringify(v.id)} must match ${ID_RE}`);
    if (typeof v.name !== 'string' || !v.name.trim()) err(where, 'name must be a non-empty string');
    if (venues.has(v.id)) err(where, `duplicate venue id ${v.id}`);
    venues.add(v.id);
  });

  categoriesArr.forEach((c, i) => {
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

  playersArr.forEach((p, i) => {
    const where = `${tFile} players[${i}]`;
    if (!p || typeof p !== 'object') { err(where, 'entry must be an object'); return; }
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) err(where, `id ${JSON.stringify(p.id)} must match ${ID_RE}`);
    if (typeof p.name !== 'string' || !p.name.trim()) err(where, 'name must be a non-empty string');
    if (players.has(p.id)) err(where, `duplicate player id ${p.id}`);
    players.set(p.id, p);
  });

  if (tjson.matches !== undefined && (typeof tjson.matches !== 'object' || tjson.matches === null || Array.isArray(tjson.matches))) {
    err(tFile, 'matches must be an object map of category id → match array');
  }

  for (const cid of Object.keys(mjson || {})) {
    if (!categories.has(cid)) err(`${tFile} matches.${cid}`, `maps to undeclared category ${JSON.stringify(cid)} — a key typo would silently render an empty category`);
  }

  for (const cat of categories.values()) {
    const ms = mjson ? mjson[cat.id] : undefined;
    if (ms === undefined) continue; // category with no matches entry is valid
    validateCategory(`${tFile} matches.${cat.id}`, ms, cat, players, venues, tjson, errs, warns, tzOk);
  }

  // ---- venue overlap on unplayed scheduled matches, across ALL categories ----
  // Per-category scope would miss a court double-booked by two categories. A
  // match's window is its effective slot (match slotMinutes > per-stage
  // category slotMinutes > default), so a long final can collide with the next match
  // even when starts are more than the default apart.
  const sched = [];
  const noSlot = new Set(); // categories whose scheduled matches resolve to no slot length
  for (const cat of categories.values()) {
    const ms = mjson ? mjson[cat.id] : undefined;
    if (!Array.isArray(ms)) continue;
    const ctx = makeCat({ meta: cat, matches: ms }, tjson);
    for (const m of ms) {
      if (!m || typeof m !== 'object' || m.venue === undefined || m.scheduled === undefined) continue;
      if (isDone(m)) continue;
      const t = schedTime(m, tjson.timezone);
      if (t === null) continue;
      if (Number.isNaN(matchSlotMs(m, ctx))) noSlot.add(cat.id); // NaN slots make the kiosk's due/overdue windows uncomputable
      // Known-player set only when both sides are fixed players — a match/pool
      // slot's players resolve only after results, so it can't be checked here
      // (the generator's invariant, same predicate schedule.js uses).
      const players = Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every(s => s && s.kind === 'players' && Array.isArray(s.ids))
        ? new Set(m.sides.flatMap(s => s.ids)) : null;
      sched.push({ f: `${tFile} matches.${cat.id}`, m, t, ctx, players });
    }
  }
  for (const cid of noSlot) {
    warns.push(`${tFile} matches.${cid}: scheduled matches resolve to no slot length — set slotMinutes (per stage or per match) or the kiosk can't mark matches overdue`);
  }
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j];
      const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
      if (!slotsOverlap(a.t, a.t + aMs, b.t, b.t + bMs)) continue;
      if (a.m.venue === b.m.venue) {
        err(a.f, `${a.m.id} and ${b.m.id} overlap at venue ${a.m.venue} (${aMs / 60000}-minute and ${bMs / 60000}-minute slots) — ${b.f} also schedules ${b.m.id}`);
      }
      // player double-book: two undone matches sharing a known player in the same
      // window, across courts and categories — the generator's invariant, moved
      // into the gate so a REPL time/venue edit can't reopen it. venue-blind
      // (a player can't be in two places at once even on different courts).
      if (a.players && b.players) {
        const shared = [...a.players].filter(p => b.players.has(p));
        if (shared.length) {
          err(a.f, `player ${shared.join(', ')} double-booked — ${a.m.id} (${a.m.scheduled}) and ${b.m.id} (${b.m.scheduled}, ${b.f})`);
        }
      }
    }
  }
}

function validateCategory(cFile, matches, cat, players, venues, tjson, errs, warns, tzOk) {
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const warn = (f, m) => warns.push(`${f}: ${m}`);
  if (!Array.isArray(matches)) { err(cFile, 'matches must be an array'); return; }

  const bestOf = cat.bestOf;
  const stageBest = stage => (bestOf && typeof bestOf[stage] === 'number' && bestOf[stage] % 2 === 1 && bestOf[stage] > 0)
    ? bestOf[stage] : undefined;

  const byId = new Map();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const where = `${cFile} match[${i}]`;
    if (!m || typeof m !== 'object') { err(where, 'must be an object'); continue; }
    if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 1) err(where, `match id ${JSON.stringify(m.id)} must be a positive integer`);
    if (byId.has(m.id)) err(where, `duplicate match id ${m.id}`);
    byId.set(m.id, m);
  }

  const roster = new Set(players.keys()); // a side id must be a registered player — who plays what is what the matches say, nothing else to maintain
  let hasPool = false;
  let hasKnockout = false;
  const poolUses = new Map(); // pool -> Set<side sig>
  const poolOfSig = new Map(); // side sig -> pool (one pool per pair per category)
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
          if (!roster.has(pid)) err(where, `side ${si}: unknown player ${pid} — register it in players`);
        }
        const sig = pairSig(side.ids);
        if (m.pool !== undefined) {
          if (!poolUses.has(m.pool)) poolUses.set(m.pool, new Set());
          poolUses.get(m.pool).add(sig);
          // derive.js's possibleStages assumes one pool per pair — a pair in two
          // pools would read stage seats from whichever pool it finds first.
          const prevPool = poolOfSig.get(sig);
          if (prevPool !== undefined && prevPool !== m.pool) err(where, `side ${sig} plays in two pools ${JSON.stringify(prevPool)} and ${JSON.stringify(m.pool)} — one pool per pair per category`);
          else poolOfSig.set(sig, m.pool);
        }
        pairSizes.add(side.ids.length);
        for (const pid of side.ids) {
          const prev = pairByPlayer.get(pid);
          if (prev && prev !== sig) err(where, `player ${pid} has two partners in category ${cat.id} (${prev} vs ${sig}) — pairs are fixed per category`);
          pairByPlayer.set(pid, sig);
        }
      } else if (side.kind === 'match') {
        if (m.pool !== undefined) err(where, `side ${si}: a pool match cannot have a match slot — pools are round robin`);
        if (typeof side.match !== 'number' || !Number.isInteger(side.match) || !byId.has(side.match)) err(where, `side ${si}: unknown match slot ${JSON.stringify(side.match)}`);
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
    if (!Array.isArray(m.sides)) { state.set(m.id, 2); return; } // malformed sides: pass A reports it — never throw here
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
      err(where, `scheduled ${JSON.stringify(s)} must be local ISO-8601 wall time, e.g. 2025-07-14T09:00:00 — no offset or Z, the tournament timezone interprets it`);
      return;
    }
    // Anchor in the tournament tz via schedTime — the one derivation, same as the site.
    // With a bad timezone the tz error is already reported above; don't also blame
    // every scheduled string for not parsing.
    if (tzOk && schedTime({ scheduled: s }, tjson.timezone) === null) err(where, `scheduled ${s} does not parse as an instant`);
    const hh = Number(s.slice(11, 13)); // Date.parse rolls 24:00 over to the next day; catch it
    if (hh > 23) err(where, `scheduled ${s} has hour ${hh} — hours run 00-23`);
    // Date.parse rolls over impossible calendar dates (2025-02-30 -> Mar 2); catch them.
    const [y, mo, da] = s.slice(0, 10).split('-').map(Number);
    if (!isRealDate(y, mo, da)) err(where, `scheduled ${s} is not a real calendar date`);
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
    if (m.result !== undefined && (typeof m.result !== 'object' || m.result === null || Array.isArray(m.result))) {
      err(where, `result must be an object with a status (${RESULT_STATUSES.join(', ')}), got ${JSON.stringify(m.result)}`);
    }
    const hasGames = Array.isArray(m.games);
    const r = (m.result && typeof m.result === 'object' && !Array.isArray(m.result)) ? m.result : undefined;
    let target;
    if (hasGames) {
      // override precedence from derive.js (match > stage) — a non-number bestOf
      // is reported above, so the numeric guard is all this check adds
      const b = bestOfOf(m, { bestOf });
      target = (typeof b === 'number' && b % 2 === 1) ? (b + 1) / 2 : undefined;
      validateGames(m.games, target, where, err);
    }
    if (r !== undefined) {
      validateResultShape(r, hasGames, target, m, where, err);
    } else if (hasGames && typeof target === 'number') {
      const [w0, w1] = countWins(m.games);
      if (w0 >= target || w1 >= target) err(where, 'games reach the best-of target — record a result (status + winner)');
    }
    if ((r !== undefined || hasGames) && Array.isArray(m.sides) && m.sides.length === 2) {
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

  // ---- the one-final rule: a knockout stage needs exactly one match on the
  // winner tree that no match feeds, or the bracket renders two "Final" labels
  // and the ordinal numbering picks an arbitrary root. placementLabel excludes
  // classification matches (they sit under loser edges), same predicate the
  // renderer's mainFinal uses — the gate reads derive.js, never app.js.
  let finals = 0;
  for (const m of matches) {
    if (!m || typeof m !== 'object' || m.pool !== undefined || !Array.isArray(m.sides) || m.sides.length !== 2) continue;
    if (placementLabel(m, ctx) !== null) continue;
    if (matches.some(X => X && Array.isArray(X.sides)
      && X.sides.some(s => s && s.kind === 'match' && s.result === 'winner' && s.match === m.id))) continue;
    finals++;
  }
  if (finals > 1) err(cFile, `${finals} unfed knockout matches — exactly one championship final is allowed`);
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

// validate <slug>: errors touching that tournament's file or index entry.
// Exact matches only — a bare substring would leak tie3 errors into `validate tie`.
// slug is id-regex-gated upstream, so it is safe inside the regex.
function filterErrs(errs, slug) {
  const re = new RegExp(`(?:tournaments/${slug}\.json|"${slug}"|slug ${slug}(?:\\s|$))`);
  return errs.filter(e => re.test(e));
}

function main(root, slug) {
  const repo = loadRepo(path.join(root, 'site'));
  if (slug !== undefined && !repo.tournaments.has(slug)) {
    console.error(`unknown tournament ${slug} — have: ${[...repo.tournaments.keys()].join(', ')}`);
    process.exit(1);
  }
  const { errs, warns } = validateRepo(repo);
  const es = slug ? filterErrs(errs, slug) : errs;
  const ws = slug ? filterErrs(warns, slug) : warns;
  for (const w of ws) console.log(`warn: ${w}`);
  for (const e of es) console.log(`error: ${e}`);
  if (es.length) {
    console.log(`validate: ${es.length} error(s) — fix and re-commit`);
    process.exit(1);
  }
  console.log(ws.length ? `validate: ok (${ws.length} warning(s))` : 'validate: ok');
}

module.exports = { validateRepo, filterErrs, main };
