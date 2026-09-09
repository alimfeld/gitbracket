'use strict';

// Edit engine — the one write path. Every edit validates, writes, and commits
// itself, so the process can die at any instant with nothing lost. The grammar
// (parsePayload) is shared with the daemon's result field — browser and typed
// entries can never drift.

const fs = require('fs');
const path = require('path');
const { makeCat, isDone, sideLabel, schedDays, dayKey, DATE_RE, catStatus, currentWave, bestOfOf } = require('../site/derive.js');
const { writeTournament, tournamentText, catCtx, winTarget, reachedWinner, git } = require('./tools.js');
const { validateRepo } = require('./validate.js');

// ---------- pure logic (tests drive these on fixture repos) ----------

function parseGame(s) {
  const mm = /^(\d+)[:-](\d+)$/.exec(s);
  return mm ? { a: +mm[1], b: +mm[2] } : null;
}

// Mutate the category's match list in memory; return an error string or null.
// Never touches disk — the caller rolls back on validation failure.
function findMatch(matches, matchId, fn) {
  const m = (matches || []).find(x => x && x.id === Number(matchId));
  if (!m) return `unknown match ${matchId}`;
  return fn(m) ?? null;
}

// Score a match: games are the evidence; once they reach the best-of target
// the outcome is recorded as played (the validator proves the games agree). A
// prefix update stays in play; re-scoring replaces any earlier result.
function applyScore(matches, matchId, games, ctx) {
  return findMatch(matches, matchId, m => {
    m.games = games;
    delete m.result; // a correction replaces a result
    // evidence -> outcome, same rule as the validator (reachedWinner)
    const target = winTarget(bestOfOf(m, ctx));
    const w = reachedWinner(games, target);
    if (w !== null) m.result = { status: 'played', winner: w };
    return null;
  });
}

// Games are cleared so games/result exclusivity stays a round-trip property.
function applyResult(matches, matchId, status, winner) {
  return findMatch(matches, matchId, m => {
    delete m.games;
    m.result = winner === undefined ? { status } : { status, winner };
    return null;
  });
}

// games and result are one round-trip pair — a clear removes both, and the
// match returns to the unresolved board.
function applyClear(matches, matchId) {
  return findMatch(matches, matchId, m => { delete m.games; delete m.result; return null; });
}

function applyVenue(matches, matchId, venueId) {
  return findMatch(matches, matchId, m => {
    if (venueId == null) delete m.venue; // null (admin JSON) unschedules the court
    else m.venue = venueId; // unknown venue + court double-booking are caught by validateRepo
  });
}

// Rewrite one side to any validator-valid slot — players, pool rank, or match
// edge. All validity is the validator's (unknown ids, pair-fixing, same-set,
// consumed-twice, rank range, cycles, double-books); writeEdit validates the
// whole repo and rolls back. A dead-tie break is just explicit players over a
// pool slot that renders TBD.
function applySide(matches, matchId, value) {
  return findMatch(matches, matchId, m => {
    if (!Array.isArray(m.sides) || m.sides.length !== 2) return 'match has no two sides';
    m.sides[value.si] = value.side;
    return null;
  });
}

function buildScheduled(hhmm, tz, date, now) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':');
  if (+h > 23 || +m > 59) return null;
  if (date !== undefined && !DATE_RE.test(date)) return null;
  // An impossible date (2026-02-30) passes this regex — the validator gate
  // rejects it on write, like applyVenue's unknown venues; the default date is
  // the caller's clock (the daemon's real clock — sim time never reaches an edit)
  const d = date || dayKey(now ?? Date.now(), tz);
  if (!d) return null; // dayKey is null on an unreadable timezone — never emit a "nullT…" string
  return `${d}T${h.padStart(2,'0')}:${m}:00`; // wall time — the tournament tz interprets it
}

function applyTime(matches, matchId, isoString) {
  return findMatch(matches, matchId, m => { if (isoString == null) delete m.scheduled; else m.scheduled = isoString; });
}

// Time and venue together — one writeEdit, one commit, so a drag on the admin
// grid never lands a half-moved match. null clears the field.
function applyMove(matches, matchId, value) {
  return findMatch(matches, matchId, m => {
    if (value.time == null) delete m.scheduled; else m.scheduled = value.time;
    if (value.venue == null) delete m.venue; else m.venue = value.venue;
    return null;
  });
}

// Apply an edit, validate the whole repo, write — or roll back and report the
// validator's errors. (writeTournament's byte-identical formatting keeps the
// commit diff to the one edited match.) An edit whose result is byte-identical
// to the stored file changes nothing: no write, no commit — execEdit reports
// unchanged.
function writeEdit(siteRoot, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const tjson = info.tjson;
  const cats = (tjson.categories || []).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const ms = tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches) ? tjson.matches[catId] : undefined;
  if (!ms) return { err: `no matches for category ${catId}` };
  const meta = tjson.categories.find(c => c.id === catId);
  const ctx = makeCat({ meta, matches: ms }, tjson);
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const beforeJson = JSON.parse(before); // the rollback snapshot — the day guard below reads it too
  const aerr = apply(ms, ctx);
  if (aerr) return { err: aerr };
  // The published days (the index dates) are fixed: only the schedule
  // generator rewrites them, and that's off the table once results are in. An
  // edit that moves a match off a day — or clears the last match of one —
  // would desync the index with no edit path to follow, so it's refused here;
  // the validator's dates-mismatch error stays for out-of-band hand edits.
  const daysOf = tj => schedDays(Object.values(tj.matches || {}).flat(), tj.timezone || 'UTC');
  const beforeDays = daysOf(beforeJson);
  const afterDays = daysOf(tjson);
  const fmtDays = ds => ds.length ? ds.join(', ') : 'no scheduled days';
  if (fmtDays(beforeDays) !== fmtDays(afterDays)) {
    ms.splice(0, ms.length, ...((beforeJson.matches || {})[catId] || [])); // undo the in-memory edit too — a same-process retry must start from the original
    return { err: `refused: this edit changes the tournament's scheduled days (${fmtDays(beforeDays)} → ${fmtDays(afterDays)}) — the index dates are fixed once the schedule is published and no edit follows them; keep the match on a published day, or change the days by hand-editing the file and its tournaments.json entry together` };
  }
  // tjson is the single view of the data, so the validator sees exactly what
  // writeTournament will write.
  const { errs } = validateRepo(repo);
  if (errs.length) {
    ms.splice(0, ms.length, ...((beforeJson.matches || {})[catId] || [])); // undo the in-memory edit too — a same-process retry must start from the original
    fs.writeFileSync(file, before);
    return { errs };
  }
  // byte equality is data equality — "21:19" for a stored "21-9" lands on the
  // same bytes, as does a re-scored identical game list
  if (tournamentText(tjson) === before) return { unchanged: true };
  writeTournament(siteRoot, slug, tjson);
  return { file };
}

// The current scoreable wave as entries — unplayed matches with resolved sides
// at each category's earliest scheduled time. Computed fresh every call, so a
// corrected score surfaces on the next pass.
const waveEntries = tjson => {
  const out = [];
  for (const cid of Object.keys(tjson.matches || {})) {
    const ctx = catCtx(tjson, cid);
    for (const m of currentWave(ctx, catStatus(ctx))) out.push({ cat: cid, m, ctx });
  }
  return out;
};

// ---------- the shared grammar ----------

// Payload grammar per edit kind — the daemon's result field parses with it, so
// typed entries and shaped JSON can never drift. Grammar errors are caught
// here, before any I/O; data errors belong to the validator.
function parsePayload(kind, tokens, tz, now) {
  if (kind === 'result') {
    // one outcome grammar: games (bare) · wo a · void · empty clears — the
    // shape rides the value
    if (!tokens.length) return { value: { shape: 'clear' } }; // empty payload clears
    const head = tokens[0];
    if (head === 'wo') {
      const side = tokens[1];
      if (side !== 'a' && side !== 'b') return { err: 'expected a or b after wo' };
      if (tokens.length > 2) return { err: 'wo takes nothing else' };
      return { value: { shape: 'walkover', winner: side } };
    }
    if (head === 'void') {
      if (tokens.length > 1) return { err: 'void takes nothing else' };
      return { value: { shape: 'void' } };
    }
    // the display speaks dashes; parseGame accepts both, so colon muscle memory still works
    const games = tokens.map(parseGame);
    const bad = tokens.findIndex((t, i) => !games[i]);
    if (bad !== -1) return { err: `bad score ${JSON.stringify(tokens[bad])} — expected a-b` };
    return { value: { shape: 'score', games } };
  }
  if (kind === 'venue') {
    if (!tokens.length) return { value: undefined }; // empty clears the court
    return { value: tokens[0] };
  }
  if (SIDE_VERBS[kind] !== undefined) {
    // the a/b verb fixes the side; the payload is shape-only: players <ids> | pool <pool> <rank> | match <id> winner|loser —
    // validity is the validator's (unknown ids, consumed-twice, range, cycles, double-books)
    const si = SIDE_VERBS[kind];
    const shape = tokens[0];
    const rest = tokens.slice(1);
    if (shape === 'players') {
      if (!rest.length) return { err: 'expected player ids after players' };
      return { value: { si, side: { kind: 'players', ids: rest } } };
    }
    if (shape === 'pool') {
      if (rest[0] === undefined || rest[1] === undefined) return { err: 'expected pool and rank, e.g. pool A 2' };
      if (!/^\d+$/.test(rest[1]) || +rest[1] < 1) return { err: `bad rank ${JSON.stringify(rest[1])} — expected a positive integer` };
      return { value: { si, side: { kind: 'pool', pool: rest[0], rank: +rest[1] } } };
    }
    if (shape === 'match') {
      if (rest[0] === undefined || rest[1] === undefined) return { err: 'expected match id and result, e.g. match 7 winner' };
      if (!/^\d+$/.test(rest[0])) return { err: `bad match id ${JSON.stringify(rest[0])} — expected a number` };
      if (rest[1] !== 'winner' && rest[1] !== 'loser') return { err: `result must be winner or loser, got ${JSON.stringify(rest[1])}` };
      return { value: { si, side: { kind: 'match', match: +rest[0], result: rest[1] } } };
    }
    return { err: `expected players, pool, or match — got ${JSON.stringify(shape)}` };
  }
  // time: [YYYY-MM-DD] hh:mm — empty unschedules
  if (!tokens.length) return { value: undefined };
  const a = tokens[0], b = tokens[1];
  const date = b !== undefined && DATE_RE.test(a) ? a : undefined;
  const hhmm = date !== undefined ? b : a;
  if (!hhmm) return { err: 'expected hh:mm (optionally preceded by a date) — empty clears' };
  const iso = buildScheduled(hhmm, tz, date, now);
  if (iso === null) {
    // buildScheduled fails on a bad time — or, when the time is fine, on the
    // default day the tz can't compute (an explicit date never fails here), so
    // name the timezone, not the time
    const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    return tm && +tm[1] <= 23 && +tm[2] <= 59
      ? { err: `bad timezone ${JSON.stringify(tz)} — can't compute today's date` }
      : { err: `bad time ${JSON.stringify(hhmm)} — expected hh:mm` };
  }
  return { value: iso };
}

// Two verbs (side-a / side-b) so an edit names the side it rewrites.
const SIDE_VERBS = { 'side-a': 0, 'side-b': 1 };

// 'result' folds score / walkover / void / clear into one entry — the shape
// dispatches to the domain applies.
function applyFor(verb, matchId, value) {
  if (verb === 'result') return (ms, ctx) => {
    if (value.shape === 'score') return applyScore(ms, matchId, value.games, ctx);
    if (value.shape === 'walkover') return applyResult(ms, matchId, 'walkover', value.winner);
    if (value.shape === 'void') return applyResult(ms, matchId, 'void');
    return applyClear(ms, matchId);
  };
  return verb === 'venue' ? c => applyVenue(c, matchId, value)
    : verb === 'move' ? c => applyMove(c, matchId, value)
    : SIDE_VERBS[verb] !== undefined ? c => applySide(c, matchId, value)
    : c => applyTime(c, matchId, value); // time — undefined unschedules
}

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

// One-line summary of what changed — keyed off the edit kind, never the match
// state, so a venue or time edit on a decided match reports the move, not the
// result. A side op on a decided match keeps the stored games/result for the
// NEW team, so the detail flags it — history must never read as a silent rewrite.
function editDetail(kind, m, value, ctx) {
  return kind === 'result' ? (value.shape === 'score' ? (m.games || []).map(gg => `${gg.a}-${gg.b}`).join(' · ') // dashes — the detail reads like the board column
      : value.shape === 'walkover' ? `side ${value.winner} wins by walkover`
      : value.shape === 'void' ? 'void'
      : '→ TBD') // a clear returns the match to the board
    : kind === 'time' ? (m.scheduled === undefined ? '→ TBD' : `→ ${m.scheduled}`)
    : kind === 'venue' ? `→ ${m.venue === undefined ? 'TBD' : m.venue}`
    : kind === 'move' ? `→ ${value.time ?? 'TBD'} @ ${value.venue ?? 'TBD'}`
    : `side ${value.si === 0 ? 'a' : 'b'} → ${sideLabel(value.side, ctx)}${isDone(m) ? ' (result kept)' : ''}`; // side — the a/b verbs carry value+ctx
}

// ---------- the edit funnel (edits commit per AGENTS.md) ----------

// Validate, write, and always commit — git is the record and the daemon is the
// only writer. The error or rolled-back report becomes the page's flash.
function execEdit(state, verb, cat, matchId, value) {
  const { root, siteRoot, repo, slug } = state;
  const info = repo.tournaments.get(slug);
  const ctx = catCtx(info.tjson, cat);
  const m = ctx.byId.get(Number(matchId)); // the same object writeEdit mutates in place
  const preStatus = m && m.result && m.result.status; // what a clear removes — its commit kind matches it
  const res = writeEdit(siteRoot, repo, slug, cat, applyFor(verb, matchId, value));
  // the structured facts the admin daemon JSON-ifies
  if (res.err) return { error: res.err };
  if (res.errs) return { errors: res.errs };
  if (res.unchanged) return { unchanged: true }; // same data — nothing written, nothing committed
  // a result edit keeps its shape kind; a clear takes the kind of what it
  // removed — greps like ^score( still find it
  const kind = verb === 'result'
    ? (value.shape === 'clear' ? (preStatus === 'walkover' ? 'walkover' : preStatus === 'void' ? 'void' : 'score') : value.shape)
    : SIDE_VERBS[verb] !== undefined ? 'side' : verb;
  const file = res.file; // writeEdit's own byte-identical write target
  const detail = editDetail(verb, m, value, ctx);
  const msg = commitMessage(kind, slug, cat, matchId, detail);
  git(root, ['add', path.relative(root, file)]);
  // pathspec commit — anything else the operator staged stays staged, never
  // swept into a match-day commit
  const c = git(root, ['commit', '-m', msg, '--', path.relative(root, file)]);
  if (c.code !== 0) {
    return { error: `${path.relative(root, file)} written but the commit failed:\n${c.err}\n(file staged — commit it manually)` };
  }
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  return { sha };
}

module.exports = { parseGame, buildScheduled, applyScore, applyResult, applyVenue, applySide, applyTime, writeEdit, commitMessage, editDetail, waveEntries, parsePayload, execEdit };