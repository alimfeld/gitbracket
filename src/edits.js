'use strict';

// Edit engine — the one write path. Every edit validates, writes, and commits
// itself, so the process can die at any instant with nothing lost. The result
// grammar (parseResult) is shared with the daemon's result field — browser and
// typed entries can never drift.

const fs = require('fs');
const path = require('path');
const { isDone, sideLabel, schedDays, catStatus, currentWave, bestOfOf } = require('../site/derive.js');
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
  const ctx = catCtx(tjson, catId);
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const beforeJson = JSON.parse(before); // the rollback snapshot — the day guard below reads it too
  // The daemon's memory snapshot can outlive an out-of-band hand edit; writing
  // from it would silently drop that edit in the next commit (the pre-commit's
  // disk-side validate can't see it either). Refuse — the daemon reloads on
  // failure, so a retry applies onto the fresh state. Compared through the
  // same normalizer, so byte-layout-only differences (a minified fixture) are
  // not a change; data changes are.
  if (tournamentText(beforeJson) !== tournamentText(tjson)) {
    return { err: `the file changed on disk (${slug}.json) since it was loaded — refusing to overwrite it; reload and retry` };
  }
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
    // Nothing was written — writeTournament runs only past this gate — so the
    // in-memory undo is the whole rollback.
    ms.splice(0, ms.length, ...((beforeJson.matches || {})[catId] || []));
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

// ---------- the result grammar ----------

// The result field's one grammar — games (bare) · wo a|b · void · empty
// clears. The shape rides the value; grammar errors are caught here, before any
// I/O, and data errors belong to the validator. Shaped JSON skips this
// entirely, so the browser and typed entries share the same shapes.
function parseResult(tokens) {
  if (!tokens.length) return { value: { shape: 'clear' } }; // empty clears
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

// 'result' folds score / walkover / void / clear into one entry — the shape
// dispatches to the domain applies; anything else is refused by name, never
// silently treated as one of them. 'side' names the side in its value (si) —
// the verb doesn't repeat it.
function applyFor(verb, matchId, value) {
  if (verb === 'result') return (ms, ctx) => {
    if (value.shape === 'score') return applyScore(ms, matchId, value.games, ctx);
    if (value.shape === 'walkover') return applyResult(ms, matchId, 'walkover', value.winner);
    if (value.shape === 'void') return applyResult(ms, matchId, 'void');
    if (value.shape === 'clear') return applyClear(ms, matchId);
    return `unknown result shape ${JSON.stringify(value.shape)}`;
  };
  return verb === 'move' ? c => applyMove(c, matchId, value)
    : verb === 'side' ? c => applySide(c, matchId, value)
    : () => `unknown edit verb ${JSON.stringify(verb)}`;
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

// Validate, write, and always commit — git is the record and the daemon is the
// only writer. The error or rolled-back report becomes the page's flash.
function execEdit(state, verb, cat, matchId, value) {
  const { root, siteRoot, repo, slug } = state;
  const info = repo.tournaments.get(slug);
  // An unknown slug is a report, never a throw: the daemon's request handler is
  // the one caller that can be handed a stale or hostile slug, and writeEdit's
  // own guard runs too late to save this lookup.
  if (!info || !info.tjson) return { error: `unknown tournament ${slug}` };
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
  return { sha };
}

module.exports = { parseGame, applyScore, applyResult, applyMove, applySide, writeEdit, commitMessage, editDetail, waveEntries, parseResult, execEdit };