'use strict';

// GitBracket validator — schema + cross-file checks. I/O (loadRepo) is separate from
// checks (validateRepo), so tests run against fixtures/ in memory. Never writes.
//
// Two channels, two gates: `errs` are syntactic (unparseable, unreferenceable, or
// missing required config) and block an edit; `conflicts` are semantic (the data
// parses but contradicts the model) and block publish only — an edit may pass
// through one so its next step can repair it.

const path = require('path');
const { loadRepo, plainObject, isRealDate, schedEntries, pairBusy, consumedSlots, winTarget, reachedWinner, feederBounds, sameSet, daysOf } = require('./tools.js');
const { DATE_RE, ID_RE, ISO_RE, MAX_BEST_OF, validBestOf, tiebreakProblems, pairSig, matchSlotMs, makeCat, matchesOf, resolveSide, bestOfOf, schedTime, plRange, parentsOf } = require('../site/derive.js');

const RESULTS = ['winner', 'loser'];
const RESULT_STATUSES = ['played', 'walkover', 'void'];

// A semantic conflict. `where` + `message` print as the gate's one line; `refs` are
// the {cat, matchId} cards the admin highlights. A match-scoped `where` yields its
// own ref; a cross-match rule (double-book, shared slot) passes the partner too.
function makeConflict(where, message, refs) {
  const hit = /matches\.([a-z0-9-]+) match (\d+)/.exec(where);
  const base = hit ? [{ cat: hit[1], matchId: Number(hit[2]) }] : [];
  return { where, message, refs: base.concat(refs || []), toString() { return `${this.where}: ${this.message}`; } };
}

// One rule per status: played is a win plus the games it was decided by; walkover a
// win with no games; void nothing.
function validateResultShape(r, games, target, where, err, conflict) {
  const hasGames = Array.isArray(games);
  if (!RESULT_STATUSES.includes(r.status)) {
    err(where, `result.status must be one of ${RESULT_STATUSES.join(', ')}, got ${JSON.stringify(r.status)}`);
  } else if (r.status === 'void') {
    if (r.winner !== undefined) conflict(where, 'a void result has no winner');
    else if (hasGames) conflict(where, 'games and a void result are mutually exclusive');
  } else {
    if (r.winner !== 'a' && r.winner !== 'b') err(where, `result.winner must be 'a' or 'b', got ${JSON.stringify(r.winner)}`);
    if (r.status === 'played') {
      if (!hasGames) conflict(where, 'a played result records the games it was decided by');
      else if (typeof target === 'number') {
        // derived from the games — the stored winner must agree (and the games reach the target)
        const derived = reachedWinner(games, target);
        if (derived === null) conflict(where, 'a played result needs games that reach the best-of target');
        else if (derived !== r.winner) conflict(where, `result.winner '${r.winner}' does not match the games — side ${derived} won`);
      }
    } else if (hasGames) {
      conflict(where, 'games and a walkover result are mutually exclusive');
    }
  }
}

// All checks, in memory. Labels are repo-relative paths (site/tournaments/<slug>/...).
function validateRepo(repo) {
  const errs = [...repo.readErrs];
  const conflicts = [];
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const { index, tournaments } = repo;

  if (index === undefined) return { errs, conflicts }; // tournaments.json unreadable — readErrs carries the message
  if (!Array.isArray(index)) {
    err('tournaments.json', 'must be an array of tournament entries');
    return { errs, conflicts };
  }

  const seenSlugs = new Set();
  for (let i = 0; i < index.length; i++) {
    const t = index[i];
    // Name the entry once its slug parses, so a per-slug run sees it; a malformed-slug
    // entry can't be attributed.
    const named = t && typeof t.slug === 'string' && ID_RE.test(t.slug) ? ` (${t.slug})` : '';
    const where = `tournaments.json [${i}]${named}`;
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
    if (info) validateTournamentData(t.slug, t.name, t.location, t.dates, info, errs, conflicts);
  }

  return { errs, conflicts };
}

function validateTournamentData(slug, indexName, indexLocation, indexDates, info, errs, conflicts) {
  const tFile = `site/tournaments/${slug}.json`;
  const tjson = info.tjson;
  if (tjson === undefined) return; // unreadable — readErrs carries the message
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const conflict = (f, m, refs) => conflicts.push(makeConflict(f, m, refs));
  if (tjson === null) { err(tFile, 'must be an object, got null'); return; }

  // The tournament page loads only this file; the index copy exists for the list page — keep equal.
  if (typeof tjson.name !== 'string' || !tjson.name.trim()) {
    err(tFile, 'name must be a non-empty string');
  } else if (tjson.name !== indexName) {
    err(tFile, `name ${JSON.stringify(tjson.name)} does not match the index entry ${JSON.stringify(indexName)}`);
  }

  if (typeof tjson.location !== 'string' || !tjson.location.trim()) {
    err(tFile, 'location must be a non-empty string');
  } else if (typeof indexLocation === 'string' && tjson.location !== indexLocation) {
    err(tFile, `location ${JSON.stringify(tjson.location)} does not match the index entry ${JSON.stringify(indexLocation)}`);
  }

  // matches as a plain object, or null when malformed (reported below)
  const mjson = matchesOf(tjson);
  let tzOk = false;
  if (typeof tjson.timezone !== 'string' || !tjson.timezone) {
    err(tFile, 'timezone required');
  } else {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tjson.timezone });
      tzOk = true;
    }
    catch { err(tFile, `timezone ${JSON.stringify(tjson.timezone)} is not a valid IANA timezone`); }
  }
  if (tzOk) {
    const derived = daysOf(tjson);
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
  const players = new Set();

  // A non-array here used to crash mid-run (forEach on a string) instead of
  // reporting — the gate must never throw.
  const list = (v, field) => {
    if (v !== undefined && !Array.isArray(v)) err(tFile, `${field} must be an array, got ${JSON.stringify(v)}`);
    return Array.isArray(v) ? v : [];
  };
  // Every entity list registers the same way; the caller records (Set for venues/
  // players, Map for categories), false for a non-object.
  const checkEntry = (label, x, set, where) => {
    if (!x || typeof x !== 'object') { err(where, 'entry must be an object'); return false; }
    if (typeof x.id !== 'string' || !ID_RE.test(x.id)) err(where, `id ${JSON.stringify(x.id)} must match ${ID_RE}`);
    if (typeof x.name !== 'string' || !x.name.trim()) err(where, 'name must be a non-empty string');
    if (set.has(x.id)) err(where, `duplicate ${label} id ${x.id}`);
    return true;
  };
  const venuesArr = list(tjson.venues, 'venues');
  const categoriesArr = list(tjson.categories, 'categories');
  const playersArr = list(tjson.players, 'players');

  venuesArr.forEach((v, i) => {
    const where = `${tFile} venues[${i}]`;
    if (!checkEntry('venue', v, venues, where)) return;
    venues.add(v.id);
  });

  categoriesArr.forEach((c, i) => {
    const where = `${tFile} categories[${i}]`;
    if (!checkEntry('category', c, categories, where)) return;
    categories.set(c.id, c);
    const b = c.bestOf;
    if (b !== undefined && !plainObject(b)) err(where, `bestOf must be an object with odd groups/knockout numbers 1–${MAX_BEST_OF}`);
    const sm = c.slotMinutes;
    if (sm !== undefined && !plainObject(sm)) err(where, 'slotMinutes must be an object with positive-integer groups/knockout minutes');
    else if (sm !== undefined) {
      for (const k of ['groups', 'knockout']) {
        if (sm[k] !== undefined && (!Number.isInteger(sm[k]) || sm[k] < 1)) err(where, `slotMinutes.${k} must be a positive integer, got ${JSON.stringify(sm[k])}`);
      }
    }
    for (const p of tiebreakProblems(c.tiebreak)) err(where, p);
  });

  playersArr.forEach((p, i) => {
    const where = `${tFile} players[${i}]`;
    if (!checkEntry('player', p, players, where)) return;
    players.add(p.id);
  });

  if (tjson.matches !== undefined && mjson === null) {
    err(tFile, 'matches must be an object map of category id → match array');
  }

  for (const cid of Object.keys(mjson || {})) {
    if (!categories.has(cid)) err(`${tFile} matches.${cid}`, `maps to undeclared category ${JSON.stringify(cid)} — a key typo would silently render an empty category`);
  }

  for (const cat of categories.values()) {
    const ms = mjson ? mjson[cat.id] : undefined;
    if (ms === undefined) continue; // category with no matches entry is valid
    validateCategory(`${tFile} matches.${cat.id}`, ms, cat, players, venues, tjson, errs, conflicts, tzOk);
  }

  // ---- venue and player overlap on unplayed scheduled matches, across ALL categories ----
  // Per-category scope would miss a court double-booked across categories; windows use
  // the effective slot length, and schedEntries/pairBusy are the admin preview's atoms.
  // players is the resolved set, so a pool/edge side double-books like an explicit one.
  const { entries: sched, noSlot } = schedEntries(tjson);
  for (const cid of noSlot) {
    err(`${tFile} matches.${cid}`, 'scheduled matches resolve to no slot length — set slotMinutes (per stage or per match) or the board can\'t lay out the day');
  }
  // ponytail: O(n²) pair scan over one tournament file — small by construction;
  // a per-venue time index is the upgrade if a file ever grows past ~300 matches.
  for (let i = 0; i < sched.length; i++) {
    for (let j = i + 1; j < sched.length; j++) {
      const a = sched[i], b = sched[j];
      const aMs = matchSlotMs(a.m, a.ctx), bMs = matchSlotMs(b.m, b.ctx);
      const aF = `${tFile} matches.${a.cat}`, bF = `${tFile} matches.${b.cat}`;
      for (const kind of pairBusy(a, b)) {
        // both ends of the collision are named for the board — aF alone can't carry them
        const both = [{ cat: a.cat, matchId: a.m.id }, { cat: b.cat, matchId: b.m.id }];
        if (kind === 'venue') {
          conflict(aF, `${a.m.id} and ${b.m.id} overlap at venue ${a.m.venue} (${aMs / 60000}-minute and ${bMs / 60000}-minute slots) — ${bF} also schedules ${b.m.id}`, both);
        } else {
          const shared = [...a.players].filter(p => b.players.has(p)).join(', ');
          conflict(aF, `player ${shared} double-booked — ${a.m.id} (${a.m.scheduled}) and ${b.m.id} (${b.m.scheduled}, ${bF})`, both);
        }
      }
    }
  }
}

function validateCategory(cFile, matches, cat, players, venues, tjson, errs, conflicts, tzOk) {
  const err = (f, m) => errs.push(`${f}: ${m}`);
  const conflict = (f, m, refs) => conflicts.push(makeConflict(f, m, refs));
  if (!Array.isArray(matches)) { err(cFile, 'matches must be an array'); return; }

  const bestOf = cat.bestOf;
  const stageBest = stage => (bestOf && validBestOf(bestOf[stage])) ? bestOf[stage] : undefined;

  const byId = new Map();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const where = `${cFile} match[${i}]`;
    if (!m || typeof m !== 'object') { err(where, 'must be an object'); continue; }
    if (!Number.isInteger(m.id) || m.id < 1) err(where, `match id ${JSON.stringify(m.id)} must be a positive integer`);
    if (byId.has(m.id)) err(where, `duplicate match id ${m.id}`);
    byId.set(m.id, m);
  }

  const roster = players;
  let hasPool = false;
  let hasKnockout = false;
  const poolUses = new Map(); // pool -> Set<side sig>
  const poolPairings = new Map(); // pool -> matchup sig -> match ids
  const invalidPoolPairings = new Set(); // malformed pool matches already have a more useful finding
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

    if (m.slotMinutes !== undefined && (!Number.isInteger(m.slotMinutes) || m.slotMinutes < 1)) err(where, `slotMinutes must be a positive integer, got ${JSON.stringify(m.slotMinutes)}`);

    if (!Array.isArray(m.sides) || m.sides.length !== 2) {
      err(where, 'exactly two sides required');
      if (m.pool !== undefined) invalidPoolPairings.add(m.pool);
      continue;
    }
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
          // possibleStages assumes one pool per pair — a pair in two pools would
          // read stage seats from whichever pool it finds first.
          const prevPool = poolOfSig.get(sig);
          if (prevPool !== undefined && prevPool !== m.pool) conflict(where, `side ${sig} plays in two pools ${JSON.stringify(prevPool)} and ${JSON.stringify(m.pool)} — one pool per pair per category`);
          else poolOfSig.set(sig, m.pool);
        }
        pairSizes.add(side.ids.length);
        for (const pid of side.ids) {
          const prev = pairByPlayer.get(pid);
          if (prev && prev !== sig) conflict(where, `player ${pid} has two partners in category ${cat.id} (${prev} vs ${sig}) — pairs are fixed per category`);
          pairByPlayer.set(pid, sig);
        }
      } else if (side.kind === 'match') {
        if (m.pool !== undefined) conflict(where, `side ${si}: a pool match cannot have a match slot — pools are round robin`);
        if (!Number.isInteger(side.match) || !byId.has(side.match)) err(where, `side ${si}: unknown match slot ${JSON.stringify(side.match)}`);
        if (!RESULTS.includes(side.result)) err(where, `side ${si}: match slot result must be winner or loser, got ${JSON.stringify(side.result)}`);
      } else if (side.kind === 'pool') {
        if (m.pool !== undefined) conflict(where, `side ${si}: a pool match cannot have a pool slot — pools are round robin`);
        if (typeof side.pool !== 'string') err(where, `side ${si}: pool slot needs a pool string`);
        if (!Number.isInteger(side.rank) || side.rank < 1) err(where, `side ${si}: pool slot rank must be a positive integer, got ${JSON.stringify(side.rank)}`);
      } else {
        err(where, `side ${si}: unknown side kind ${JSON.stringify(side.kind)}`);
      }
    });

    if (m.sides[0]?.kind === 'players' && Array.isArray(m.sides[0].ids)
      && m.sides[1]?.kind === 'players' && Array.isArray(m.sides[1].ids)) {
      if (pairSig(m.sides[0].ids) === pairSig(m.sides[1].ids)) conflict(where, 'the two sides are the same player set');
    }
    if (m.pool !== undefined) {
      const validTeam = s => s && s.kind === 'players' && Array.isArray(s.ids) && s.ids.length > 0
        && new Set(s.ids).size === s.ids.length && s.ids.every(id => typeof id === 'string' && roster.has(id));
      if (typeof m.pool !== 'string' || !m.sides.every(validTeam)) invalidPoolPairings.add(m.pool);
      else {
        const teams = m.sides.map(s => pairSig(s.ids)).sort();
        if (teams[0] === teams[1]) invalidPoolPairings.add(m.pool);
        else {
          const key = JSON.stringify(teams);
          if (!poolPairings.has(m.pool)) poolPairings.set(m.pool, new Map());
          const ids = poolPairings.get(m.pool);
          if (!ids.has(key)) ids.set(key, []);
          ids.get(key).push(m.id);
        }
      }
    }
  }

  if (pairSizes.size > 1) conflict(cFile, `category ${cat.id} mixes singles and doubles sides (sizes ${[...pairSizes].join(', ')})`);
  for (const [pool, sigs] of poolUses) {
    if (sigs.size < 2) conflict(cFile, `pool ${JSON.stringify(pool)} has fewer than two distinct sides`);
    if (invalidPoolPairings.has(pool)) continue;
    const pairs = poolPairings.get(pool) || new Map();
    const teams = [...sigs];
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const key = JSON.stringify([teams[i], teams[j]].sort());
      const ids = pairs.get(key) || [];
      if (!ids.length) conflict(cFile, `pool ${JSON.stringify(pool)} is missing the matchup ${teams[i]} vs ${teams[j]}`);
      else for (const id of ids.slice(1)) conflict(`${cFile} match ${id}`, `pool ${JSON.stringify(pool)} repeats the matchup ${teams[i]} vs ${teams[j]}`);
    }
  }
  if (hasPool && !stageBest('groups')) err(cFile, `category ${cat.id}: groups stage in use but bestOf.groups must be an odd number 1–${MAX_BEST_OF}`);
  if (hasKnockout && !stageBest('knockout')) err(cFile, `category ${cat.id}: knockout stage in use but bestOf.knockout must be an odd number 1–${MAX_BEST_OF}`);

  // ---- acyclicity (must precede pass B — resolveSide recurses through slots) ----
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
    conflict(cFile, `slot cycle detected at match ${cycle}`, [{ cat: cat.id, matchId: cycle }]);
    return; // a cycle is the finding; pass B's derived reads would only add noise on top
  }

  // ---- derived state used below (shared with app.js) ----
  const ctx = makeCat({ meta: cat, matches }, tjson);
  function checkScheduled(s, where) {
    if (typeof s !== 'string' || !ISO_RE.test(s)) {
      err(where, `scheduled ${JSON.stringify(s)} must be local ISO-8601 wall time, e.g. 2025-07-14T09:00:00 — no offset or Z, the tournament timezone interprets it`);
      return;
    }
    // schedTime anchors in the tournament tz; a bad tz is already reported above, so
    // don't also blame every string.
    if (tzOk && schedTime({ scheduled: s }, tjson.timezone) === null) err(where, `scheduled ${s} does not parse as an instant`);
    const hh = Number(s.slice(11, 13)); // Date.parse rolls 24:00 over to the next day; catch it
    if (hh > 23) err(where, `scheduled ${s} has hour ${hh} — hours run 00-23`);
    // Date.parse rolls over impossible calendar dates (2025-02-30 -> Mar 2); catch them.
    const [y, mo, da] = s.slice(0, 10).split('-').map(Number);
    if (!isRealDate(y, mo, da)) err(where, `scheduled ${s} is not a real calendar date`);
  }

  // ---- pass B: slots, scoring, scheduling ----
  const sources = consumedSlots(matches); // slot source key -> first owning match id
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const where = `${cFile} match ${m.id || '?'}`;
    if (m.bestOf !== undefined && !validBestOf(m.bestOf)) {
      err(where, `bestOf override must be an odd number 1–${MAX_BEST_OF}, got ${JSON.stringify(m.bestOf)}`);
    }

    if (Array.isArray(m.sides) && m.sides.length === 2) {
      // consumedSlots records this match as the owner of every source it holds, so the
      // cross-match test below is blind to one source used on both sides.
      const seen = new Set();
      m.sides.forEach((side) => {
        if (!side || typeof side !== 'object') return;
        // the one claim rule for either kind — same-match reuse bites both
        const claim = (key, owner) => {
          if (seen.has(key)) conflict(where, `slot source ${key} is consumed twice by this match`);
          seen.add(key);
          // every holder but the first is a duplicate — the gate names the first owner,
          // and both cards light up
          if (owner.get(key) !== m.id) conflict(where, `slot source ${key} is consumed twice (also by ${owner.get(key)})`, [{ cat: cat.id, matchId: owner.get(key) }]);
        };
        if (side.kind === 'match') {
          claim(`${side.match}:${side.result}`, sources.edge);
        } else if (side.kind === 'pool') {
          claim(`pool:${side.pool}:${side.rank}`, sources.pool);
          if (typeof side.pool === 'string' && Number.isInteger(side.rank) && side.rank >= 1) {
            if (!poolUses.has(side.pool)) {
              err(where, `pool slot references unknown pool ${JSON.stringify(side.pool)} (no matches use it)`);
            } else if (side.rank > poolUses.get(side.pool).size) {
              conflict(where, `pool slot rank ${side.rank} out of range — pool ${JSON.stringify(side.pool)} has ${poolUses.get(side.pool).size} side(s)`);
            }
          }
        }
      });
    }

    if (m.games !== undefined && !Array.isArray(m.games)) err(where, `games must be an array of {a, b} game objects, got ${JSON.stringify(m.games)}`);
    if (m.result !== undefined && !plainObject(m.result)) {
      err(where, `result must be an object with a status (${RESULT_STATUSES.join(', ')}), got ${JSON.stringify(m.result)}`);
    }
    const hasGames = Array.isArray(m.games);
    const r = plainObject(m.result) ? m.result : undefined;
    let target;
    if (hasGames) {
      // match > stage override precedence; a bad bestOf is already reported above
      target = winTarget(bestOfOf(m, { bestOf }));
      validateGames(m.games, target, where, err, conflict);
    }
    if (r !== undefined) {
      validateResultShape(r, m.games, target, where, err, conflict);
    } else if (hasGames && reachedWinner(m.games, target) !== null) {
      conflict(where, 'games reach the best-of target — record a result (status + winner)');
    }
    // A scored match must resolve both sides; one team on both is a self-match.
    // An unresolved match waits (the gate reports, never guesses).
    if (Array.isArray(m.sides) && m.sides.length === 2) {
      const a = resolveSide(m.sides[0], ctx);
      const b = resolveSide(m.sides[1], ctx);
      if ((r !== undefined || hasGames) && (!a || !b)) {
        conflict(where, 'scored match must have both sides resolved to players — check the pool or match feeding the unresolved side');
      } else if (a && b && sameSet(a, b)) {
        conflict(where, `both sides resolve to the same team (${[...a].join(', ')}) — a match needs two distinct sides`);
      }
    }

    if (m.scheduled !== undefined) checkScheduled(m.scheduled, where);
    // A bracket can't start before its sources end nor end after its consumers begin;
    // schedule.js satisfies this by construction, typed edits hit this gate.
    if (m.scheduled !== undefined && m.pool === undefined) {
      const fb = feederBounds(m, ctx, tjson.timezone);
      const t = schedTime(m, tjson.timezone);
      const ms = matchSlotMs(m, ctx);
      if (fb && t !== null && !Number.isNaN(ms)) {
        if (fb.floor !== null && t < fb.floor) conflict(where, `match ${m.id} starts before its feeders end — a bracket can't start until its sources are done (move this match later or its feeders earlier)`);
        if (fb.ceiling !== null && t + ms > fb.ceiling) conflict(where, `match ${m.id} ends after a match it feeds starts — a feeder must finish before its consumer begins (move this match earlier or the consumer later)`);
      }
    }
    if (m.venue !== undefined && typeof m.venue !== 'string') {
      err(where, `venue must be a venue id string, got ${JSON.stringify(m.venue)}`);
    } else if (m.venue !== undefined && !venues.has(m.venue)) {
      err(where, `unknown venue ${JSON.stringify(m.venue)}`);
    }
  }

  // ---- the one-final rule: exactly one unfed champion-tree match, or the bracket
  // renders two "Final" labels and ordinal numbering picks an arbitrary root.
  const { winnerParent } = parentsOf(ctx);
  const roots = matches.filter(m => m && typeof m === 'object' && m.pool === undefined
    && Array.isArray(m.sides) && m.sides.length === 2
    && plRange(m, ctx) === null && !winnerParent.has(m.id));
  if (roots.length > 1) {
    conflict(cFile, `${roots.length} unfed knockout matches — exactly one championship final is allowed`,
      roots.map(m => ({ cat: cat.id, matchId: m.id })));
  }
}

function validateGames(games, target, where, err, conflict) {
  const valid = []; // well-formed games so far — the prefix reachedWinner counts
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g || typeof g !== 'object' || !Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0) {
      err(where, `games[${i}] must be non-negative integer scores`);
      continue;
    }
    if (g.a === g.b) { err(where, `games[${i}] has no winner (a equals b)`); continue; }
    // winTarget returns null when the stage's bestOf is invalid/absent — pass A
    // already flags the config, and 0 >= null would invent a reached target.
    if (typeof target !== 'number') continue;
    // the earlier valid games decide the target; one rule (reachedWinner) with the scorer
    if (reachedWinner(valid, target) !== null) {
      conflict(where, `games[${i}] recorded after a side already reached the target of ${target}`);
    }
    valid.push(g);
  }
}

// The slug must lead the finding's where — matching it anywhere lets a sibling quoting the same string leak in.
function filterSlug(msgs, slug) {
  // The slug lands in a regex — a caller may pass a non-id (the admin CLI takes a
  // positional arg), and a metacharacter must not break the pattern and take the
  // gate down with it.
  const s = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(?:site/)?tournaments/${s}\\.json\\b|^tournaments\\.json \\[[^\\]]*\\] \\(${s}\\)`);
  return msgs.filter(e => re.test(e));
}

// The two channels for an already-loaded repo, narrowed to one slug when given.
function findings(repo, slug) {
  const { errs, conflicts } = validateRepo(repo);
  return {
    errs: slug ? filterSlug(errs, slug) : errs,
    conflicts: slug ? filterSlug(conflicts, slug) : conflicts,
  };
}

// The dev gate: syntactic errors fail, semantic conflicts only report (publish re-checks).
function main(root, slug) {
  const repo = loadRepo(path.join(root, 'site'));
  if (slug !== undefined && !repo.tournaments.has(slug)) {
    console.error(`unknown tournament ${slug} — have: ${[...repo.tournaments.keys()].join(', ')}`);
    return 1;
  }
  const { errs: es, conflicts: cs } = findings(repo, slug);
  for (const c of cs) console.log(`conflict: ${c}`);
  for (const e of es) console.log(`error: ${e}`);
  if (es.length) {
    console.log(`validate: ${es.length} error(s) — fix and re-commit`);
    return 1;
  }
  console.log(cs.length ? `validate: ok (${cs.length} conflict(s) — publish blocked)` : 'validate: ok');
  return 0;
}

module.exports = { validateRepo, filterSlug, findings, main };
