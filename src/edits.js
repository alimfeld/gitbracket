'use strict';

// Edit engine — the one write path: every edit passes the syntactic gate, writes, and
// commits itself. Semantic conflicts ride back with the result; they block publish only.
// parseResult is shared with the daemon's result field.

const fs = require('fs');
const path = require('path');
const { isDone, sideLabel, schedDays, bestOfOf, matchesOf } = require('../site/derive.js');
const { writeTournament, tournamentText, catCtx, winTarget, reachedWinner, plainObject, git } = require('./tools.js');
const { validateRepo } = require('./validate.js');

// ---------- pure logic (tests drive these on fixture repos) ----------

function parseGame(s) {
  const mm = /^(\d+)[:-](\d+)$/.exec(s);
  return mm ? { a: +mm[1], b: +mm[2] } : null;
}

// Mutate in memory; return an error string or null. Never touches disk.
function findMatch(matches, matchId, fn) {
  const m = (matches || []).find(x => x && x.id === Number(matchId));
  if (!m) return `unknown match ${matchId}`;
  return fn(m) ?? null;
}

// Games are the evidence; at the best-of target the outcome is recorded as played.
// A prefix update stays in play; re-scoring replaces any earlier result.
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

// A clear removes both, returning the match to the unresolved board.
function applyClear(matches, matchId) {
  return findMatch(matches, matchId, m => { delete m.games; delete m.result; return null; });
}

// Rewrite one side to any validator-valid slot (players, pool rank, or match edge);
// all validity is the validator's — writeEdit validates the whole repo and rolls back.
function applySide(matches, matchId, value) {
  return findMatch(matches, matchId, m => {
    if (!Array.isArray(m.sides) || m.sides.length !== 2) return 'match has no two sides';
    m.sides[value.si] = value.side;
    return null;
  });
}

// Remove a match from the bracket. The syntactic gate refuses a match other matches
// still reference, so its consumers must be reseated first; its own feeders may orphan
// and ride back as conflicts, cleared by the next edit (delete or repoint).
function applyDelete(matches, matchId) {
  return findMatch(matches, matchId, m => {
    matches.splice(matches.indexOf(m), 1);
    return null;
  });
}

// Time and venue together — one commit, so a drag never lands a half-moved match.
function applyMove(matches, matchId, value) {
  return findMatch(matches, matchId, m => {
    if (value.time == null) delete m.scheduled; else m.scheduled = value.time;
    if (value.venue == null) delete m.venue; else m.venue = value.venue;
    return null;
  });
}

// Apply, gate on the syntactic whole-repo check, write — or roll back and report the
// errors. Semantic conflicts ride back with the result: they never block the write.
function writeEdit(siteRoot, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const tjson = info.tjson;
  const cats = (tjson.categories || []).filter(plainObject).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const ms = matchesOf(tjson)?.[catId];
  if (!ms) return { err: `no matches for category ${catId}` };
  const ctx = catCtx(tjson, catId);
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  // A hand-edited disk can be malformed between load and write: refuse, never throw.
  let before, beforeJson;
  try {
    before = fs.readFileSync(file, 'utf8');
    beforeJson = JSON.parse(before); // the rollback snapshot — the day guard below reads it too
  } catch (e) {
    return { err: `site/tournaments/${slug}.json is not readable JSON on disk (${e.message}) — fix the file and retry; nothing was written` };
  }
  // The memory snapshot can outlive an out-of-band hand edit; writing from it would
  // silently drop that edit. Compared through the same normalizer, so byte-layout-only
  // differences aren't a change.
  if (tournamentText(beforeJson) !== tournamentText(tjson)) {
    return { err: `the file changed on disk (${slug}.json) since it was loaded — refusing to overwrite it; reload and retry` };
  }
  // undo the in-memory edit too — a same-process retry must start from the original
  const restore = () => ms.splice(0, ms.length, ...((beforeJson.matches || {})[catId] || []));
  const aerr = apply(ms, ctx);
  if (aerr) return { err: aerr };
  // Published days are fixed: an edit that moves a match off a day (or clears a day's
  // last match) would desync the index, which no edit path follows. Refused here.
  const daysOf = tj => schedDays(Object.values(tj.matches || {}).flat(), tj.timezone || 'UTC');
  const beforeDays = daysOf(beforeJson);
  const afterDays = daysOf(tjson);
  const fmtDays = ds => ds.length ? ds.join(', ') : 'no scheduled days';
  if (fmtDays(beforeDays) !== fmtDays(afterDays)) {
    restore();
    return { err: `refused: this edit changes the tournament's scheduled days (${fmtDays(beforeDays)} → ${fmtDays(afterDays)}) — the index dates are fixed once the schedule is published and no edit follows them; keep the match on a published day, or change the days by hand-editing the file and its tournaments.json entry together` };
  }
  // The validator sees exactly what writeTournament will write.
  const { errs, conflicts } = validateRepo(repo);
  if (errs.length) {
    // Nothing was written — writeTournament runs only past this gate.
    restore();
    return { errs };
  }
  // byte equality is data equality — "21:19" for a stored "21-9" lands on the
  // same bytes, as does a re-scored identical game list
  if (tournamentText(tjson) === before) return { unchanged: true };
  writeTournament(siteRoot, slug, tjson);
  return { file, conflicts };
}

// ---------- the result grammar ----------

// games (bare) · wo a|b · void · empty clears. Grammar errors are caught here,
// before any I/O; data errors belong to the validator.
function parseResult(tokens) {
  if (!tokens.length) return { value: { shape: 'clear' } };
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

// 'result' dispatches by shape to the domain applies; unknown shapes are refused by
// name. 'side' names the side in its value (si).
function applyFor(verb, matchId, value) {
  // The daemon's value is untrusted: a non-object would throw out of the async handler.
  // Refuse the shape before any field is read.
  if ((verb === 'result' || verb === 'move' || verb === 'side') && !plainObject(value)) {
    return () => `${verb} edits carry a value object — got ${JSON.stringify(value)}`;
  }
  // result.score's nested games is iterated by reachedWinner — a non-array
  // would throw out of the handler just like a non-object value; same refusal.
  if (verb === 'result') return (ms, ctx) => {
    if (value.shape === 'score') {
      if (!Array.isArray(value.games)) return `score edits carry a games array — got ${JSON.stringify(value.games)}`;
      return applyScore(ms, matchId, value.games, ctx);
    }
    if (value.shape === 'walkover') return applyResult(ms, matchId, 'walkover', value.winner);
    if (value.shape === 'void') return applyResult(ms, matchId, 'void');
    if (value.shape === 'clear') return applyClear(ms, matchId);
    return `unknown result shape ${JSON.stringify(value.shape)}`;
  };
  if (verb === 'delete') return ms => applyDelete(ms, matchId);
  return verb === 'move' ? c => applyMove(c, matchId, value)
    : verb === 'side' ? c => applySide(c, matchId, value)
    : () => `unknown edit verb ${JSON.stringify(verb)}`;
}

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

// One-line summary of what changed, keyed off the edit kind — never the match state,
// so a move on a decided match reports the move. A side op on a decided match keeps
// its result, flagged so history can't read as a silent rewrite.
function editDetail(kind, m, value, ctx) {
  if (kind === 'delete') return 'deleted';
  if (kind === 'result') {
    if (value.shape === 'score') return (m.games || []).map(gg => `${gg.a}-${gg.b}`).join(' · '); // dashes — the detail reads like the board column
    if (value.shape === 'walkover') return `side ${value.winner} wins by walkover`;
    if (value.shape === 'void') return 'void';
    return '→ TBD'; // a clear returns the match to the board
  }
  if (kind === 'move') return `→ ${value.time ?? 'TBD'} @ ${value.venue ?? 'TBD'}`;
  // side — the a/b verbs carry value+ctx
  return `side ${value.si === 0 ? 'a' : 'b'} → ${sideLabel(value.side, ctx)}${isDone(m) ? ' (result kept)' : ''}`;
}

// ---------- the edit funnel (edits commit per AGENTS.md) ----------

// Validate, write, and always commit; the error/rollback report becomes the page's flash.
function execEdit(state, verb, cat, matchId, value) {
  const { root, siteRoot, repo, slug } = state;
  const info = repo.tournaments.get(slug);
  // An unknown slug is a report, never a throw; writeEdit's guard runs too late for this lookup.
  if (!info || !info.tjson) return { error: `unknown tournament ${slug}` };
  const ctx = catCtx(info.tjson, cat);
  const m = ctx.byId.get(Number(matchId)); // the same object writeEdit mutates in place
  const preStatus = m && m.result && m.result.status; // what a clear removes — its commit kind matches it
  const res = writeEdit(siteRoot, repo, slug, cat, applyFor(verb, matchId, value));
  // the structured facts the admin daemon JSON-ifies
  if (res.err) return { error: res.err };
  if (res.errs) return { errors: res.errs };
  if (res.unchanged) return { unchanged: true }; // same data — nothing written, nothing committed
  // a clear takes the kind of what it removed, so greps like ^score( still find it
  const kind = verb === 'result'
    ? (value.shape === 'clear' ? (preStatus === 'walkover' ? 'walkover' : preStatus === 'void' ? 'void' : 'score') : value.shape)
    : verb;
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
  return { sha, conflicts: res.conflicts };
}

module.exports = { applyScore, applyResult, applyMove, applySide, applyDelete, writeEdit, commitMessage, editDetail, parseResult, execEdit };
