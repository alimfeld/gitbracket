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
// immediately. The prompt shows sync state: ↑n unpushed commits, ↓n behind,
// * dirty tree. Tab completes at every level.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { makeCat, isDone, resolveSide, sideLabel, schedTime, gamesText, fmtTime, matchLabel, poolStandings } = require('../site/derive.js');
const { loadRepo, writeTournament } = require('./tools.js');
const { validateRepo } = require('./validate.js');
const { buildKnockout } = require('./schedule.js');

// ---------- pure logic (tests drive these on fixture repos) ----------

function isScorable(m, ctx) {
  return !!m && Array.isArray(m.sides) && m.sides.length === 2
    && !!resolveSide(m.sides[0], ctx) && !!resolveSide(m.sides[1], ctx);
}

function parseGame(s) {
  const mm = /^(\d+)[:-](\d+)$/.exec(s);
  return mm ? { a: +mm[1], b: +mm[2] } : null;
}

// Mutate cjson in memory; return an error string or null. Never touches disk —
// the caller rolls back on validation failure.
function findMatch(cjson, matchId, fn) {
  const m = (cjson.matches || []).find(x => x && x.id === matchId);
  if (!m) return `unknown match ${matchId}`;
  return fn(m) ?? null;
}

function applyScore(cjson, matchId, games) {
  return findMatch(cjson, matchId, m => {
    m.games = games;
    delete m.forfeit; // a correction replaces a forfeit
  });
}

function applyForfeit(cjson, matchId, sideIdx) {
  return findMatch(cjson, matchId, m => {
    m.forfeit = sideIdx;
    delete m.games;
  });
}

function applyVenue(cjson, matchId, venueId) {
  return findMatch(cjson, matchId, m => {
    m.venue = venueId; // unknown venue + court double-booking are caught by validateRepo
  });
}

// Replace all knockout matches for a category (no pool) with new ones.
// Pool matches are preserved.
function applyRebracket(cjson, newKO) {
  const pools = cjson.matches.filter(m => m.pool !== undefined);
  cjson.matches = pools.concat(newKO).sort((a, b) => a.id.localeCompare(b.id));
  return null;
}

// Every scorable match in the tournament: ready (no result) first, then by
// scheduled time, then id.
function listEligible(repo, slug) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return null;
  const rows = [];
  for (const cat of info.tjson.categories || []) {
    const cjson = info.matches.get(cat.id);
    if (!cjson) continue;
    const ctx = makeCat({ meta: cat, matches: cjson.matches }, info.tjson);
    for (const m of cjson.matches) {
      if (isScorable(m, ctx)) rows.push({ cat: cat.id, m, ctx });
    }
  }
  const t = r => schedTime(r.m) ?? Infinity; // unscheduled matches sort last
  rows.sort((a, b) => isDone(a.m, a.ctx) - isDone(b.m, b.ctx) || t(a) - t(b) || a.m.id.localeCompare(b.m.id));
  return rows;
}

// Apply an edit to one match, validate the whole repo, write — or roll the file
// back and report the validator's errors. The write
// (JSON.stringify(tournament, null, 2) + '\n') is byte-identical to the file
// apart from the edited match, so a commit diff shows only that match.
function writeEdit(siteRoot, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const cats = (info.tjson.categories || []).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const cjson = info.matches.get(catId);
  if (!cjson) return { err: `no matches for category ${catId}` };
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const aerr = apply(cjson);
  if (aerr) return { err: aerr };
  const { errs } = validateRepo(repo);
  if (errs.length) {
    cjson.matches = (JSON.parse(before).matches || {})[catId] || []; // undo the in-memory edit too — a same-process retry must start from the original
    fs.writeFileSync(file, before);
    return { errs };
  }
  const matches = {};
  for (const [cid, c] of info.matches) matches[cid] = c.matches;
  writeTournament(siteRoot, slug, { ...info.tjson, matches });
  return { file };
}

function listText(repo, slug, cat) {
  const info = repo.tournaments.get(slug);
  const tjson = info.tjson;
  const shown = listEligible(repo, slug).filter(r => r.cat === cat);
  const entry = repo.index.find(e => e && e.slug === slug);
  const idw = Math.max(...shown.map(r => r.m.id.length));
  const stagew = Math.max(...shown.map(r => matchLabel(r.m, r.ctx).length));
  const venuew = Math.max(...shown.map(r => (r.m.venue || 'TBD').length));
  const out = [`${C.bold((entry && entry.name) || slug)} / ${C.bold(C.cyan(cat))} — ${shown.length} scorable match${shown.length === 1 ? '' : 'es'}:`];
  for (const r of shown) {
    const m = r.m, ctx = r.ctx, tz = tjson.timezone || 'UTC';
    const t = schedTime(m);
    const stage = matchLabel(m, ctx);
    const time = t === null ? C.yellow('TBD'.padStart(8)) : C.dim(fmtTime(t, tz).padStart(8));
    const venue = m.venue ? C.magenta(m.venue.padEnd(venuew)) : C.yellow('TBD'.padEnd(venuew));
    const g = gamesText(m);
    const score = m.forfeit !== undefined ? C.yellow(`forfeit ${m.forfeit}`) : g ? C.green(g) : C.dim('–');
    out.push(`  ${C.bold(m.id.padEnd(idw))}  ${C.dim(stage.padEnd(stagew))} ${time}  ${venue} ${sideLabel(m.sides[0], ctx)}${C.dim(' vs ')}${sideLabel(m.sides[1], ctx)}  ${score}`);
  }
  return out.join('\n');
}

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

const VERBS = ['ls', 'cd', 'q', 'help', 'score', 'ff', 'venue', 'rebracket', 'push', 'pull', 'status', 'validate'];

// Any line is <verb> <args> — the first word is always a command.
function parseCmd(line) {
  const [head, ...args] = line.trim().split(/\s+/);
  return { kind: VERBS.includes(head) ? head : 'unknown', args };
}

// Resolve a cd target against the current position. state = { repo, slug, cat }.
function navigate(state, token) {
  if (token === '/') return { slug: null, cat: null };
  if (token === '..') {
    if (state.slug === null) return { slug: null, cat: null };
    return state.cat === null ? { slug: null, cat: null } : { slug: state.slug, cat: null };
  }
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
  const cjson = info.matches.get(cat.id);
  const matches = (cjson && cjson.matches) || [];
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
  const ahead = git(root, ['rev-list', '--count', '@{u}..HEAD']);
  const behind = git(root, ['rev-list', '--count', 'HEAD..@{u}']);
  if (ahead.code || behind.code) return ''; // no upstream — indicator unavailable
  const dirty = git(root, ['status', '--porcelain']);
  let s = '';
  if (ahead.out.trim() !== '0') s += ` ↑${ahead.out.trim()}`;
  if (behind.out.trim() !== '0') s += ` ↓${behind.out.trim()}`;
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
  ff <match> <0|1>              forfeit: side 0 or 1 forfeits
  venue <match> <venue>         move a match to another court
  rebracket <player> […] [2|4|8]  rebuild KO omitting teams; optional placements depth (default 4)

${C.bold('sync (every edit commits itself):')}
  push  pull  status  validate

${C.dim('prompt: ↑n = n unpushed commits, ↓n = n behind, * = dirty tree. Tab completes.')}`;
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
    } else if ((verb === 'score' || verb === 'ff' || verb === 'venue') && parts.length === 2 && state.cat) {
      const cjson = state.repo.tournaments.get(state.slug).matches.get(state.cat);
      cands = cjson ? cjson.matches.map(m => m.id) : [];
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

function gitPush(root) {
  const r = git(root, ['push']);
  if (r.code === 0) return 'pushed';
  const rejected = /rejected|! \[rejected\]/.test(r.err + r.out);
  return (rejected ? 'push rejected — someone pushed first: run pull (rebases), then push\n' : '') + r.err.trim();
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

// ---------- shallow ANSI paint (TTY only — piped output stays plain) ----------

const C = (() => {
  const tty = process.stdout.isTTY; // colors are no-ops when piped — callers need no guard
  const w = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: s => w(1, s), dim: s => w(2, s), red: s => w(31, s), yellow: s => w(33, s), green: s => w(32, s), cyan: s => w(36, s), magenta: s => w(35, s) };
})();

// Color the final output string — commands and pure functions stay plain.
function paint(s) {
  if (!s) return s;
  if (s.includes('not written') || s.includes('but the commit failed') || s.startsWith('push rejected')) return C.red(s);
  return s.split('\n').map(l =>
    /^(error:|unknown |bad |\d+ error\(s\))/.test(l) ? C.red(l)
    : /^(warn:|usage:|\(\d+ warning\(s\)\))/.test(l) ? C.yellow(l)
    : /committed |— done$|wins$|^validate: ok$|^pushed$|^pulled/.test(l) ? C.green(l)
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
  const cjson = info.matches.get(cat);
  const ctx = makeCat({ meta: info.tjson.categories.find(c => c.id === cat), matches: cjson.matches }, info.tjson);
  const m = ctx.byId.get(matchId);
  const detail = kind === 'score' ? gamesText(m) : kind === 'forfeit' ? `side ${m.forfeit}` : `→ ${m.venue}`;
  const msg = commitMessage(kind, slug, cat, matchId, detail);
  git(root, ['add', path.relative(root, res.file)]);
  const c = git(root, ['commit', '-m', msg]);
  if (c.code !== 0) return `wrote ${path.relative(root, res.file)} but the commit failed:\n${c.err}\n(file staged — commit it manually)`;
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  const sum = m.forfeit !== undefined
    ? `${cat}/${matchId} → side ${m.forfeit} forfeits — side ${1 - m.forfeit} wins`
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
    return applyAndCommit(state, 'score', matchId, c => applyScore(c, matchId, games));
  }
  if (kind === 'ff') {
    const [matchId, side] = args;
    const idx = Number(side);
    if (!matchId || side === undefined) return 'usage: ff <match> <0|1>';
    if (!Number.isInteger(idx) || (idx !== 0 && idx !== 1)) return 'forfeit side must be 0 or 1';
    return applyAndCommit(state, 'forfeit', matchId, c => applyForfeit(c, matchId, idx));
  }
  if (kind === 'venue') {
    const [matchId, venueId] = args;
    if (!matchId || !venueId) return 'usage: venue <match> <venue>';
    return applyAndCommit(state, 'venue', matchId, c => applyVenue(c, matchId, venueId));
  }
}

function rebracketCmd(state, dropPlayers) {
  if (state.cat === null) return 'cd into a category first';
  const { root, siteRoot, repo, slug, cat } = state;
  const info = repo.tournaments.get(slug);
  const tjson = info.tjson;
  const catMeta = tjson.categories.find(c => c.id === cat);
  const cjson = info.matches.get(cat);
  const ctx = makeCat({ meta: catMeta, matches: cjson.matches }, tjson);

  // Collect standings per pool, filter out dropouts
  const poolIds = [...new Set(cjson.matches.filter(m => m.pool).map(m => m.pool))];
  if (poolIds.length === 0) return 'no pool matches in this category';
  const dropSet = new Set(dropPlayers);
  const perPool = [];
  let dropped = false, remainingCount = 0;
  for (const pid of poolIds) {
    const st = poolStandings(ctx, pid);
    if (!st) return `pool ${pid} not fully decided — score/forfeit all pool matches first`;
    const kept = st.filter(r => ![...r.ids].some(id => dropSet.has(id)));
    if (kept.length !== st.length) dropped = true;
    if (kept.length === 0 && poolIds.length > 1) return `pool ${pid} would be empty — dropping leaves a pool with no teams`;
    remainingCount += kept.length;
    perPool.push({ pool: pid, teams: kept.map(r => [...r.ids]) });
  }
  if (!dropped) return `no team contains ${dropPlayers.join(', ')} — check player IDs`;
  if (remainingCount < 2) return 'fewer than 2 teams remain — no knockout possible';

  // Get final override from existing KO matches
  const oldKO = cjson.matches.filter(m => !m.pool).sort((a, b) => schedTime(a) - schedTime(b));
  const finalM = oldKO.find(m => m.bestOf !== undefined);
  const fin = finalM ? { bestOf: finalM.bestOf, slotMinutes: finalM.slotMinutes } : {};

  const last = dropPlayers[dropPlayers.length - 1];
  const placements = last === '2' || last === '8' ? Number(dropPlayers.pop()) : 4;

  // Build new knockout from remaining teams in all pools
  let next = 11;
  while (cjson.matches.some(m => m.id === 'm' + next)) next++;
  const mid = () => 'm' + next++;
  const newKO = buildKnockout(
    perPool.map(p => p.teams),
    perPool.map(p => p.pool),
    mid, fin, placements
  );

  // Convert pool slot references to explicit player slots — the dropped
  // team's rank no longer exists in the pool standings, but pool slots
  // still resolve through the original data. Baking them avoids that.
  for (const m of newKO) {
    for (const s of m.sides) {
      if (s.kind === 'pool') {
        const pp = perPool.find(p => p.pool === s.pool);
        if (pp && s.rank - 1 < pp.teams.length) {
          s.kind = 'players';
          s.ids = pp.teams[s.rank - 1];
          delete s.pool;
          delete s.rank;
        }
      }
    }
  }

  // SFs get the earliest old slots, final and bronze get the latest.
  // The old classification-round slot (e.g. 16:00) falls out and is freed.
  for (let i = 0; i < 2 && i < newKO.length && i < oldKO.length; i++) {
    newKO[i].scheduled = oldKO[i].scheduled;
    newKO[i].venue = oldKO[i].venue;
  }
  for (let i = 2; i < newKO.length; i++) {
    const oi = oldKO.length - (newKO.length - i);
    newKO[i].scheduled = oldKO[oi].scheduled;
    newKO[i].venue = oldKO[oi].venue;
  }

  // Write, validate, rollback on failure (writeEdit handles all of that)
  const res = writeEdit(siteRoot, repo, slug, cat, c => applyRebracket(c, newKO));
  if (res.err) return res.err;
  if (res.errs) return res.errs.join('\n') + '\nnot written — validation error(s), file rolled back';

  // Commit
  const msg = `rebracket(${slug}): ${cat} drop ${dropPlayers.join(', ')}`;
  git(root, ['add', path.relative(root, res.file)]);
  const cr = git(root, ['commit', '-m', msg]);
  if (cr.code !== 0) return `rebracket written but commit failed:\n${cr.err}\n(file staged — commit it manually)`;

  const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  const lines = newKO.map(m => {
    const s0 = sideLabel(m.sides[0], ctx);
    const s1 = sideLabel(m.sides[1], ctx);
    return `  ${m.id}: ${s0} vs ${s1} @ ${fmtTime(schedTime(m), tjson.timezone)} ${m.venue}`;
  });
  return `rebracketed ${cat} — ${newKO.length} KO match${newKO.length === 1 ? '' : 'es'}:\n` + lines.join('\n') + `\ncommit ${sha}: ${msg}`;
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
  if (kind === 'rebracket') {
    if (state.cat === null) return 'cd into a category first';
    if (args.length === 0) return 'usage: rebracket <player> [player …] [2|4|8]';
    return rebracketCmd(state, args);
  }
  if (kind === 'score' || kind === 'ff' || kind === 'venue') {
    if (state.cat === null) return 'cd into a category first';
    return editCmd(state, kind, args);
  }
  if (kind === 'push') return gitPush(state.root);
  if (kind === 'pull') return gitPull(state);
  if (kind === 'status') return gitStatus(state.root);
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
  rl.on('line', line => {
    const t = line.trim();
    if (!t) console.log(paint(listing(state)));
    else {
      const { kind, args } = parseCmd(t);
      if (kind === 'q') { rl.close(); return; }
      if (kind === 'unknown') {
        const word = t.split(/\s+/)[0];
        const info = state.slug ? state.repo.tournaments.get(state.slug) : null;
        const target = state.slug === null ? state.repo.tournaments.has(word)
          : state.cat === null && info && (info.tjson.categories || []).some(c => c.id === word);
        console.log(paint(`unknown command ${word}${target ? ` — did you mean cd ${word}?` : ''} — help`));
      } else {
        console.log(paint(dispatch(kind, args, state)));
      }
    }
    show();
  });
  rl.on('close', () => { console.log(C.dim('bye')); });
  show();
}

// CLI entry (dispatched from gb.js): root is the repo root.
function main(root) {
  const siteRoot = path.join(root, 'site');
  const repo = loadRepo(siteRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  replMain(root, siteRoot, repo);
}

module.exports = { main, isScorable, parseGame, applyScore, applyForfeit, applyVenue, applyRebracket, listEligible, listText, writeEdit, commitMessage, parseCmd, navigate, catSummary };
