'use strict';

// GitBracket match-day REPL — navigate, score, move venues; every edit
// validates, writes, and commits itself, so the process can die at any
// instant with nothing lost. Dispatched from gb.js; pure edit functions are
// exported for tests.
//
// The REPL navigates tournaments like a directory tree. Every line is a
// command — the first word is always a verb, so targets (slugs, categories,
// matches) only ever appear as cd/score args and can't collide with commands.
// Every successful edit is validated (the real validateRepo) and committed
// immediately. publish ships site/ (validate gate, then surge). The prompt
// shows git facts only: ↑n = commits not on origin/main, ↓n = commits on
// origin/main not local, * = dirty tree. status also compares the current
// tournament's file against the live domain. Tab completes at every level.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { makeCat, isDone, sideLabel, teamLabel, schedTime, gamesText, fmtTime, matchLabel, koColumn, placementLabel, poolStandings, fmtDiff, bestOfOf, countWins, sideLetter, otherSide, dayKey } = require('../site/derive.js');
const { loadRepo, writeTournament } = require('./tools.js');
const { validateRepo } = require('./validate.js');
const { ship } = require('./publish.js');

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

// Score a match: games are the evidence, and once they reach the best-of
// target the outcome is recorded as played (winner stored, per the model — the
// validator proves the games agree). A prefix update (games below target)
// stays in play; re-scoring replaces any earlier result.
function applyScore(matches, matchId, games, ctx) {
  return findMatch(matches, matchId, m => {
    m.games = games;
    delete m.result; // a correction replaces a result
    const b = bestOfOf(m, ctx);
    if (typeof b === 'number' && b % 2 === 1) {
      const target = (b + 1) / 2;
      const [w0, w1] = countWins(games);
      if (w0 >= target || w1 >= target) m.result = { status: 'played', winner: sideLetter(w0 >= target ? 0 : 1) };
    }
    return null;
  });
}

// Record a result that isn't a played score: walkover names the side that
// gives the match away (winner = the other side); void settles a match
// nobody plays (both sides out) — no winner, nothing counts. Any games are
// cleared, keeping games/result exclusivity a round-trip property.
function applyResult(matches, matchId, status, loser) {
  return findMatch(matches, matchId, m => {
    delete m.games;
    m.result = loser === undefined ? { status } : { status, winner: otherSide(loser) };
    return null;
  });
}

function applyVenue(matches, matchId, venueId) {
  return findMatch(matches, matchId, m => {
    m.venue = venueId; // unknown venue + court double-booking are caught by validateRepo
  });
}

function buildScheduled(hhmm, tz) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':');
  if (+h > 23 || +m > 59) return null;
  const date = dayKey(Date.now(), tz); // tz-local date
  return `${date}T${h.padStart(2,'0')}:${m}:00`; // wall time — the tournament tz interprets it
}

function applyTime(matches, matchId, isoString) {
  return findMatch(matches, matchId, m => { m.scheduled = isoString; });
}



// Apply an edit to one match, validate the whole repo, write — or roll the file
// back and report the validator's errors. (writeTournament's byte-identical
// formatting keeps the commit diff to the one edited match.) apply receives
// the category context so score can read the best-of target.
function writeEdit(siteRoot, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const cats = (info.tjson.categories || []).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const ms = info.matches.get(catId);
  if (!ms) return { err: `no matches for category ${catId}` };
  const meta = info.tjson.categories.find(c => c.id === catId);
  const ctx = makeCat({ meta, matches: ms }, info.tjson);
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const aerr = apply(ms, ctx);
  if (aerr) return { err: aerr };
  const { errs } = validateRepo(repo);
  if (errs.length) {
    ms.splice(0, ms.length, ...((JSON.parse(before).matches || {})[catId] || [])); // undo the in-memory edit too — a same-process retry must start from the original
    fs.writeFileSync(file, before);
    return { errs };
  }
  const matches = {};
  for (const [cid, arr] of info.matches) matches[cid] = arr;
  writeTournament(siteRoot, slug, { ...info.tjson, matches });
  return { file };
}

function formatMatchLine(m, ctx, tz, stage, sidew, idw, venuew, stagew) {
  const t = schedTime(m, tz);
  const time = t === null ? C.yellow('TBD'.padStart(8)) : C.dim(fmtTime(t, tz).padStart(8));
  const v = m.venue || 'TBD';
  const venue = (m.venue ? C.magenta : C.yellow)(v.padEnd(venuew || v.length));
  // slot shape = best-of, same as the cards: real games render, the rest are ·
  const parts = (m.games || []).map(g => `${g.a}-${g.b}`);
  while (parts.length < (bestOfOf(m, ctx) || 1)) parts.push('·');
  const r = m.result;
  const score = !r || r.status === 'played' ? C.green(parts.join(' '))
    : C.yellow(r.status === 'void' ? 'void' : `W/O side ${otherSide(r.winner)}`);
  const s0 = sideLabel(m.sides[0], ctx);
  const s1 = sideLabel(m.sides[1], ctx);
  const sides = s0 + C.dim(' vs ') + s1;
  const sidePad = sidew !== undefined ? ' '.repeat(Math.max(0, sidew - (s0.length + 4 + s1.length))) : '';
  const stagePad = stagew !== undefined ? ' '.repeat(Math.max(0, stagew - stage.length)) : '';
  return `${C.bold(idw ? String(m.id).padEnd(idw) : m.id)}  ${C.dim(stage)}${stagePad}  ${sides}${sidePad}  ${time}  ${venue}  ${score}`;
}

// KO listing order: earlier round first (higher column), then placement
// matches after the main-bracket match of the same column, then id. Keys off
// the placement model itself (placementLabel), not label prefixes — a
// '9th–16th semi' is placement too, and the old startsWith('3rd'|'5th'|'7th')
// check silently interleaved any deeper classification with the main bracket.
function koCompare(a, b, ctx) {
  const ca = koColumn(a.m, ctx), cb = koColumn(b.m, ctx);
  if (ca !== cb) return cb - ca;
  const pa = placementLabel(a.m, ctx) !== null ? 1 : 0;
  const pb = placementLabel(b.m, ctx) !== null ? 1 : 0;
  if (pa !== pb) return pa - pb;
  return a.m.id - b.m.id;
}

function listText(repo, slug, cat) {
  const info = repo.tournaments.get(slug);
  const tjson = info.tjson;
  const matches = info.matches.get(cat);
  const meta = tjson.categories.find(c => c.id === cat);
  const ctx = makeCat({ meta, matches }, tjson);
  const tz = tjson.timezone || 'UTC';
  const entry = repo.index.find(e => e && e.slug === slug);
  const lines = [`${C.bold((entry && entry.name) || slug)} / ${C.bold(C.cyan(cat))}`];

  const poolIds = [...new Set(matches.filter(m => m.pool).map(m => m.pool))].sort();
  // all pools at once, so column widths align across them (matches do the same)
  const head = ['#', 'Team', 'W', 'L', 'GD', 'PD']; // same headers as the site's standings table
  const tables = [];
  for (const pid of poolIds) {
    const st = poolStandings(ctx, pid, true);
    tables.push({ pid, rows: st && st.map((r, i) => [String(i + 1), teamLabel(r.ids, ctx), String(r.wins), String(r.losses), fmtDiff(r.gd), fmtDiff(r.pd)]) });
  }
  const wid = head.map((h, c) => Math.max(h.length, ...tables.flatMap(t => t.rows || []).map(r => r[c].length)));
  const fmt = cells => '  ' + cells.map((c, i) => (i === 1 ? c.padEnd(wid[i]) : c.padStart(wid[i]))).join('  ');
  for (const { pid, rows } of tables) {
    lines.push('', `${C.cyan('Pool ' + pid)}:`);
    if (rows) lines.push(fmt(head), ...rows.map(fmt));
  }

  // Flat match listing with stage labels, no section headers
  const all = matches.map(m => ({ m, stage: matchLabel(m, ctx) }));
  all.sort((a, b) => {
    const pa = a.m.pool !== undefined, pb = b.m.pool !== undefined;
    if (pa !== pb) return pa ? -1 : 1; // pool matches first
    if (pa) return a.m.pool.localeCompare(b.m.pool) || a.m.id - b.m.id;
    return koCompare(a, b, ctx); // earlier round first, placement after the same-column main match
  });
  const idw = Math.max(...all.map(r => String(r.m.id).length));
  const stagew = Math.max(...all.map(r => r.stage.length));
  const sidew = Math.max(...all.map(r => sideLabel(r.m.sides[0], ctx).length + 4 + sideLabel(r.m.sides[1], ctx).length));
  const venuew = Math.max(...all.map(r => (r.m.venue || 'TBD').length));
  if (all.length) lines.push('');
  for (const { m, stage } of all) {
    lines.push('    ' + formatMatchLine(m, ctx, tz, stage, sidew, idw, venuew, stagew));
  }

  return lines.join('\n');
}

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

const VERBS = ['ls', 'cd', 'q', 'help', 'score', 'wo', 'void', 'time', 'venue', 'publish', 'pull', 'status', 'validate'];

// Any line is <verb> <args> — the first word is always a command.
function parseCmd(line) {
  const [head, ...args] = line.trim().split(/\s+/);
  return { kind: VERBS.includes(head) ? head : 'unknown', args };
}

// Resolve a cd target against the current position. state = { repo, slug, cat }.
function navigate(state, token) {
  if (token === '/') return { slug: null, cat: null };
  if (token === '..') return state.cat === null ? { slug: null, cat: null } : { slug: state.slug, cat: null };
  if (state.slug === null) {
    if (!state.repo.tournaments.has(token)) return { err: `unknown tournament ${token} — tab completes` };
    return { slug: token, cat: null };
  }
  if (state.cat === null) {
    const info = state.repo.tournaments.get(state.slug);
    if (!(info.tjson.categories || []).some(c => c.id === token)) return { err: `unknown category ${token} — tab completes` };
    return { slug: state.slug, cat: token };
  }
  return { err: `matches are leaves — score ${token} … or cd ..` };
}

// One tournament's line for the category listing: id, name, match counts.
function catSummary(info, cat) {
  const matches = info.matches.get(cat.id) || [];
  const ctx = makeCat({ meta: cat, matches }, info.tjson);
  const done = matches.filter(m => isDone(m, ctx)).length;
  const name = C.cyan(cat.name);
  const doneTxt = done === 0 ? C.dim('0') : done === matches.length ? C.green(done) : C.yellow(done);
  return `${C.bold(C.cyan(cat.id))} — ${name} · ${matches.length} match${matches.length === 1 ? '' : 'es'}, ${doneTxt} done`;
}

// ---------- git + repo I/O (thin shell, not unit-tested) ----------

function git(root, args) {
  // spawnSync, not execSync: execSync has no argv array — args must be baked
  // into the command string, which breaks ids with spaces and quotes.
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { code: r.status === 0 ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };
}

function syncSuffix(root) {
  // Git facts only — the prompt must not depend on how publishing happened
  // (gb.js publish, plain surge, CI) or on a remote being reachable. ↑ = commits
  // not on origin/main (unshared, the thing you'd ship), ↓ = commits on
  // origin/main you don't have. Each indicator grades independently: a missing
  // remote silences only the one that needs it, never the others.
  const ahead = git(root, ['rev-list', '--count', 'origin/main..HEAD']);
  const behind = git(root, ['rev-list', '--count', 'HEAD..origin/main']);
  const dirty = git(root, ['status', '--porcelain']);
  let s = '';
  if (ahead.code === 0 && ahead.out.trim() !== '0') s += ` ↑${ahead.out.trim()}`;
  if (behind.code === 0 && behind.out.trim() !== '0') s += ` ↓${behind.out.trim()}`;
  if (dirty.code === 0 && dirty.out.length) s += ' *';
  return s;
}

// ---------- REPL ----------

function helpText() {
  return `${C.bold('navigate:')}
  ls                     list this level
  cd <slug|category>     enter — cd .. / cd / go up / root, cd alone shows the path
  q                      quit (every edit is committed; nothing is lost)

${C.bold('score & manage (inside a category):')}
  score <match> <a:b> [a:b …]   set games — a prefix is a mid-match update, re-score corrects
  wo <match> <a|b>              walkover: side a or b walks over — a player out: wo every
                                remaining match of their team, the bracket self-heals
  void <match>                  void: no winner, nothing counts (both sides out)
  venue <match> <venue>         move a match to another court
  time <match> <hh:mm>          shift a match to another time today

${C.bold('sync (every edit commits itself):')}
  publish  pull  status  validate

${C.dim('prompt: ↑n = n commits not on origin/main, ↓n = n on origin/main not local, * = dirty tree. Tab completes.')}`;
}

function makePrompt(state) {
  const p = state.slug ? `${state.slug}${state.cat ? '/' + state.cat : ''}` : '';
  const sync = syncSuffix(state.root).replace('*', C.yellow('*'));
  return `gitbracket${p ? ':' + C.cyan(p) : ''}${sync ? C.dim(sync) : ''}> `;
}

function completer(state) {
  return line => {
    const parts = line.split(/\s+/).filter(Boolean);
    const partial = parts.length ? parts[parts.length - 1] : '';
    const verb = parts[0];
    let cands = [];
    if (!verb) cands = VERBS;
    else if (parts.length === 1) cands = VERBS.filter(v => v.startsWith(verb));
    else if (verb === 'cd') {
      cands = state.slug === null ? [...state.repo.tournaments.keys()]
        : state.cat === null ? (state.repo.tournaments.get(state.slug).tjson.categories || []).map(c => c.id) : [];
    } else if ((verb === 'score' || verb === 'wo' || verb === 'void' || verb === 'time' || verb === 'venue') && parts.length === 2 && state.cat) {
      const arr = state.repo.tournaments.get(state.slug).matches.get(state.cat);
      cands = arr ? arr.map(m => m.id) : [];
    } else if (verb === 'venue' && parts.length === 3) {
      cands = (state.repo.tournaments.get(state.slug).tjson.venues || []).map(v => v.id);
    }
    return [cands.filter(c => c.startsWith(partial) && c !== partial).slice(0, 100), partial];
  };
}

function listing(state) {
  if (state.slug === null) {
    if (!state.repo.index.length) return 'no tournaments — add one to tournaments.json';
    return state.repo.index.map(e => {
      const info = state.repo.tournaments.get(e.slug);
      const n = info && info.tjson ? (info.tjson.categories || []).length : 0;
      return `${C.bold(C.cyan(e.name))}  (${e.slug}) — ${n} categor${n === 1 ? 'y' : 'ies'}`;
    }).join('\n');
  }
  const info = state.repo.tournaments.get(state.slug);
  if (state.cat === null) return (info.tjson.categories || []).map(c => catSummary(info, c)).join('\n');
  return listText(state.repo, state.slug, state.cat);
}

function validateText(repo) {
  const { errs, warns } = validateRepo(repo);
  const lines = [...warns.map(w => `warn: ${w}`), ...errs.map(e => `error: ${e}`)];
  if (!lines.length) return 'validate: ok';
  return lines.join('\n') + (errs.length ? `\n${errs.length} error(s)` : ` (${warns.length} warning(s))`);
}

function gitPublish(state) {
  // Gate on disk, not memory — surge uploads site/ from disk, so validate
  // exactly what ships. (publish.main's gate exits the process — unusable here.)
  const { errs } = validateRepo(loadRepo(state.siteRoot));
  if (errs.length) return errs.join('\n') + '\nnot published — validation error(s)';
  if (ship(state.root) !== 0) return 'not published — see the output above';
  return 'published';
}

function gitPull(state) {
  const r = git(state.root, ['pull', '--rebase']);
  if (r.code !== 0) {
    const txt = (r.err + r.out).trim();
    return txt + (/(CONFLICT|conflict)/.test(txt) ? '\nresolve the conflicted file, then push' : '');
  }
  state.repo = loadRepo(state.siteRoot); // the in-memory snapshot is stale after a pull
  if (state.slug && !state.repo.tournaments.has(state.slug)) {
    state.slug = null;
    state.cat = null;
    return 'pulled — repo reloaded; current tournament vanished, back at root';
  }
  return 'pulled — repo reloaded';
}

function gitStatus(root) {
  return git(root, ['status', '-sb']).out.trim() || '(clean)';
}

// Compare the one file this session edits — tournaments/<slug>.json — with
// what the live domain serves, so `status` answers "is what I have what's
// live?" without assuming how it got there (gb.js publish, plain surge, CI —
// all invisible here, all covered). The file is a few KB, so a GET + text
// compare is the whole check; no host-specific headers. Offline is "unknown",
// never "stale" or "current". Thin shell, not unit-tested (network).
async function liveStatus(state) {
  if (state.slug === null) return ''; // no single tournament file at root
  const domain = fs.readFileSync(path.join(state.siteRoot, 'CNAME'), 'utf8').trim();
  const rel = `tournaments/${state.slug}.json`;
  let body;
  try {
    const res = await fetch(`https://${domain}/${rel}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `live: HTTP ${res.status} for /${rel}`;
    body = await res.text();
  } catch {
    return `live: can't reach ${domain} (offline — unknown)`;
  }
  if (body === fs.readFileSync(path.join(state.siteRoot, rel), 'utf8')) return `live: ${state.slug} is current`;
  return `live: ${rel} differs — publish to converge`;
}

async function statusCmd(state) {
  const live = await liveStatus(state);
  const s = gitStatus(state.root);
  return live ? `${s}\n${live}` : s;
}

// ---------- shallow ANSI paint (TTY only — piped output stays plain) ----------

const C = (() => {
  const tty = process.stdout.isTTY; // colors are no-ops when piped — callers need no guard
  const w = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: s => w(1, s), dim: s => w(2, s), red: s => w(31, s), yellow: s => w(33, s), green: s => w(32, s), cyan: s => w(36, s), magenta: s => w(35, s) };
})();

// Color the final output string — commands and pure functions stay plain.
function paint(s) {
  if (!s) return s;
  if (s.includes('not written') || s.includes('but the commit failed') || s.startsWith('not published')) return C.red(s);
  return s.split('\n').map(l =>
    /^(error:|unknown |bad |\d+ error\(s\))/.test(l) ? C.red(l)
    : /^(warn:|usage:|\(\d+ warning\(s\)\))/.test(l) ? C.yellow(l)
    : /committed |— done$|wins$|^validate: ok$|^published$|^pulled/.test(l) ? C.green(l)
    : /^→ /.test(l) ? C.cyan(l)
    : l
  ).join('\n');
}

// Apply + write + commit one edit; every successful edit is a commit, so the
// tree is never dirty for long and Ctrl-C can't lose anything.
function applyAndCommit(state, kind, matchId, apply) {
  const { root, siteRoot, repo, slug, cat } = state;
  const res = writeEdit(siteRoot, repo, slug, cat, apply);
  if (res.err) return res.err;
  if (res.errs) return res.errs.join('\n') + '\nnot written — validation error(s), file rolled back';
  const info = repo.tournaments.get(slug);
  const matches = info.matches.get(cat);
  const ctx = makeCat({ meta: info.tjson.categories.find(c => c.id === cat), matches }, info.tjson);
  const m = ctx.byId.get(Number(matchId));
  const r = m.result;
  const detail = kind === 'score' ? gamesText(m)
    : r ? (r.status === 'void' ? 'void' : `side ${otherSide(r.winner)} walks over`)
    : kind === 'time' ? `→ ${m.scheduled}`
    : `→ ${m.venue}`;
  const msg = commitMessage(kind, slug, cat, matchId, detail);
  git(root, ['add', path.relative(root, res.file)]);
  const c = git(root, ['commit', '-m', msg]);
  if (c.code !== 0) return `wrote ${path.relative(root, res.file)} but the commit failed:\n${c.err}\n(file staged — commit it manually)`;
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  const sum = r
    ? r.status === 'void' ? `${cat}/${matchId} → void`
      : `${cat}/${matchId} → side ${otherSide(r.winner)} walks over — side ${r.winner} wins`
    : kind === 'time' ? `${cat}/${matchId} → ${m.scheduled}`
    : `${cat}/${matchId} → ${gamesText(m)}${isDone(m, ctx) ? ' — done' : ''}`;
  return `${sum}\ncommitted ${sha}: ${msg}`;
}

function editCmd(state, kind, args) {
  if (kind === 'score') {
    const [matchId, ...tokens] = args;
    if (!matchId || tokens.length === 0) return 'usage: score <match> <a:b> [a:b ...]';
    const games = tokens.map(parseGame);
    const bad = tokens.findIndex((t, i) => !games[i]);
    if (bad !== -1) return `bad score ${JSON.stringify(tokens[bad])} — expected a:b, e.g. 11:9`;
    return applyAndCommit(state, 'score', matchId, (c, ctx) => applyScore(c, matchId, games, ctx));
  }
  if (kind === 'wo') {
    const [matchId, side] = args;
    if (!matchId || side === undefined) return 'usage: wo <match> <a|b>';
    if (side !== 'a' && side !== 'b') return 'side must be a or b';
    return applyAndCommit(state, 'walkover', matchId, c => applyResult(c, matchId, 'walkover', side));
  }
  if (kind === 'void') {
    const [matchId] = args;
    if (!matchId) return 'usage: void <match>';
    return applyAndCommit(state, 'void', matchId, c => applyResult(c, matchId, 'void'));
  }
  if (kind === 'venue') {
    const [matchId, venueId] = args;
    if (!matchId || !venueId) return 'usage: venue <match> <venue>';
    return applyAndCommit(state, 'venue', matchId, c => applyVenue(c, matchId, venueId));
  }
  if (kind === 'time') {
    const [matchId, hhmm] = args;
    if (!matchId || !hhmm) return 'usage: time <match> <hh:mm>';
    const tz = state.repo.tournaments.get(state.slug).tjson.timezone;
    const iso = buildScheduled(hhmm, tz);
    if (!iso) return `bad time ${JSON.stringify(hhmm)} — expected hh:mm, e.g. 10:30`;
    return applyAndCommit(state, 'time', matchId, c => applyTime(c, matchId, iso));
  }
}

function dispatch(kind, args, state) {
  if (kind === 'ls') return listing(state);
  if (kind === 'cd') {
    if (!args[0]) return curPath(state);
    const r = navigate(state, args[0]);
    if (r.err) return r.err;
    state.slug = r.slug;
    state.cat = r.cat;
    return '→ ' + curPath(state);
  }
  if (kind === 'score' || kind === 'wo' || kind === 'void' || kind === 'time' || kind === 'venue') {
    if (state.cat === null) return 'cd into a category first';
    return editCmd(state, kind, args);
  }
  if (kind === 'publish') return gitPublish(state);
  if (kind === 'pull') return gitPull(state);
  if (kind === 'status') return statusCmd(state);
  if (kind === 'validate') return validateText(state.repo);
  if (kind === 'help') return helpText();
}

const curPath = state => `${state.slug || '/'}${state.cat ? '/' + state.cat : ''}`;

function replMain(root, siteRoot, repo) {
  const state = { root, siteRoot, repo, slug: null, cat: null };
  if (repo.index.length) {
    const last = repo.index[repo.index.length - 1]; // the REPL default: the latest tournament
    if (last && repo.tournaments.has(last.slug)) state.slug = last.slug;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: completer(state), historySize: 500 });
  const show = () => { rl.setPrompt(makePrompt(state)); rl.prompt(); };
  console.log(C.dim('gitbracket — tab completes, help for commands, q to quit'));
  rl.on('line', async line => {
    const t = line.trim();
    if (!t) console.log(paint(listing(state)));
    else {
      const { kind, args } = parseCmd(t);
      if (kind === 'q') { state.quit = true; rl.close(); return; }
      if (kind === 'unknown') {
        const word = t.split(/\s+/)[0];
        const info = state.slug ? state.repo.tournaments.get(state.slug) : null;
        const target = state.slug === null ? state.repo.tournaments.has(word)
          : state.cat === null && info && (info.tjson.categories || []).some(c => c.id === word);
        console.log(paint(`unknown command ${word}${target ? ` — did you mean cd ${word}?` : ''} — help`));
      } else {
        console.log(paint(await dispatch(kind, args, state)));
      }
    }
    if (state.quit) return; // q/EOF landed while this async command was in flight
    show();
  });
  rl.on('close', () => { state.quit = true; console.log(C.dim('bye')); });
  show();
}

// CLI entry (dispatched from gb.js): root is the repo root.
function main(root) {
  const siteRoot = path.join(root, 'site');
  const repo = loadRepo(siteRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  replMain(root, siteRoot, repo);
}

module.exports = { parseGame, buildScheduled, applyScore, applyResult, applyVenue, applyTime, writeEdit, commitMessage, parseCmd, navigate, main, koCompare };
