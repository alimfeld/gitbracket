#!/usr/bin/env node
'use strict';

// GitBracket CLI — score entry on match day. Zero deps, no package.json.
// Run from anywhere under the repo root (the root is found by walking up).
//
//   node cli.js                            # list scorable matches (latest tournament)
//   node cli.js list [category]            #  … one category only
//   node cli.js score md m1 11-9 11-7      # set games — a prefix is a mid-match push
//   node cli.js forfeit md m7 1            # side 1 forfeits, side 0 wins
//   node cli.js -t 2026-mammut60 score …   # pick the tournament (default: last in tournaments.json)
//
// Scorable = both sides resolve to players — the same rule validate.js enforces
// on scored matches. Every edit runs the real validateRepo before the file is
// written; a rejected edit rolls the file back, so the CLI never leaves data
// the pre-commit hook would refuse.

const fs = require('fs');
const path = require('path');
const { makeCat, isDone, resolveSide, sideLabel, schedTime, gamesText, fmtTime } = require('./site/app.js');
const { loadRepo, validateRepo } = require('./validate.js');

// ---------- pure logic (tests drive these on fixture repos) ----------

function isScorable(m, ctx) {
  return !!m && Array.isArray(m.sides) && m.sides.length === 2
    && !!resolveSide(m.sides[0], ctx) && !!resolveSide(m.sides[1], ctx);
}

function parseGame(s) {
  const mm = /^(\d+)-(\d+)$/.exec(s);
  return mm ? { a: +mm[1], b: +mm[2] } : null;
}

// Mutate cjson in memory; return an error string or null. Never touches disk —
// the caller rolls back on validation failure.
function applyScore(cjson, matchId, games) {
  const m = (cjson.matches || []).find(x => x && x.id === matchId);
  if (!m) return `unknown match ${matchId}`;
  m.games = games;
  delete m.forfeit; // a correction replaces a forfeit
  return null;
}

function applyForfeit(cjson, matchId, sideIdx) {
  const m = (cjson.matches || []).find(x => x && x.id === matchId);
  if (!m) return `unknown match ${matchId}`;
  m.forfeit = sideIdx;
  delete m.games;
  return null;
}

// Every scorable match in the tournament: ready (no result) first, then by
// scheduled time, then id. This is what the `list` command prints.
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
// back and report the validator's errors. The file format
// (JSON.stringify(cjson, null, 2) + '\n') matches existing match files
// byte-for-byte, so a commit diff shows only the edited match.
function writeEdit(root, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const cats = (info.tjson.categories || []).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const cjson = info.matches.get(catId);
  if (!cjson) return { err: `no matches file for category ${catId}` };
  const file = path.join(root, 'tournaments', slug, 'matches', `${catId}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const aerr = apply(cjson);
  if (aerr) return { err: aerr };
  const { errs } = validateRepo(repo);
  if (errs.length) {
    Object.assign(cjson, JSON.parse(before)); // undo the in-memory edit too — a same-process retry must start from the original
    fs.writeFileSync(file, before);
    return { errs };
  }
  fs.writeFileSync(file, JSON.stringify(cjson, null, 2) + '\n');
  return { file };
}

// ---------- commands ----------

function listText(repo, slug, catOnly) {
  const info = repo.tournaments.get(slug);
  const tjson = info.tjson;
  const rows = listEligible(repo, slug);
  const shown = catOnly ? rows.filter(r => r.cat === catOnly) : rows;
  const entry = repo.index.find(e => e && e.slug === slug);
  const out = [`${(entry && entry.name) || slug} — ${shown.length} scorable match${shown.length === 1 ? '' : 'es'}:`];
  for (const r of shown) {
    const m = r.m, ctx = r.ctx, tz = tjson.timezone || 'UTC';
    const t = schedTime(m);
    const stage = m.pool !== undefined ? `Pool ${m.pool}` : 'KO';
    const score = m.forfeit !== undefined ? `forfeit ${m.forfeit}` : (gamesText(m) || '–');
    out.push(`  ${r.cat} ${m.id}  ${stage.padEnd(6)} ${t === null ? 'TBD' : fmtTime(t, tz)}  ${(m.venue || 'TBD').padEnd(8)} ${sideLabel(m.sides[0], ctx)} vs ${sideLabel(m.sides[1], ctx)}  ${score}`);
  }
  return out.join('\n');
}

const USAGE = `usage:
  node cli.js                      list scorable matches (latest tournament)
  node cli.js list [category]
  node cli.js score <category> <match> <a-b> [a-b ...]   e.g. score md m1 11-9 11-7
  node cli.js forfeit <category> <match> <0|1>
  node cli.js -t <slug> <command>  pick the tournament (default: last in tournaments.json)`;

function findRoot() {
  let dir = process.cwd();
  while (!fs.existsSync(path.join(dir, 'site', 'tournaments.json')) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return dir;
}

function main(argv) {
  let slug = null;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-t' || argv[i] === '--tournament') {
      slug = argv[++i];
      if (slug === undefined) { console.error('usage: -t <slug> — a tournament slug is required after -t'); process.exit(1); }
    }
    else if (argv[i] === '-h' || argv[i] === '--help' || argv[i] === 'help') { console.log(USAGE); return; }
    else pos.push(argv[i]);
  }

  const root = findRoot();
  const dataRoot = path.join(root, 'site');
  const repo = loadRepo(dataRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  if (!slug) {
    const last = repo.index.length && repo.index[repo.index.length - 1];
    if (!last || typeof last.slug !== 'string') { console.error('tournaments.json lists no tournaments — pass -t <slug>'); process.exit(1); }
    slug = last.slug;
  }
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) { console.error(`unknown tournament ${slug}`); process.exit(1); }

  const cmd = pos[0] || 'list';
  const rest = pos.slice(1);

  if (cmd === 'list') {
    const catOnly = rest[0];
    if (catOnly !== undefined && !(info.tjson.categories || []).some(c => c.id === catOnly)) {
      console.error(`unknown category ${catOnly} — have: ${(info.tjson.categories || []).map(c => c.id).join(', ')}`);
      process.exit(1);
    }
    console.log(listText(repo, slug, catOnly));
    return;
  }

  if (cmd !== 'score' && cmd !== 'forfeit') { console.error(`unknown command ${cmd}\n${USAGE}`); process.exit(1); }

  const [cat, matchId, ...tokens] = rest;
  const want = cmd === 'score' ? 'a-b [a-b ...]' : '0|1';
  if (!cat || !matchId || tokens.length === 0) { console.error(`usage: node cli.js ${cmd} <category> <match> ${want}`); process.exit(1); }

  if (cmd === 'forfeit') {
    const idx = Number(tokens[0]);
    if (tokens.length !== 1 || !Number.isInteger(idx) || (idx !== 0 && idx !== 1)) { console.error('forfeit side must be 0 or 1'); process.exit(1); }
  }
  const games = cmd === 'score' ? tokens.map(parseGame) : null;
  if (games) {
    const bad = tokens.findIndex((t, i) => !games[i]);
    if (bad !== -1) { console.error(`bad score ${JSON.stringify(tokens[bad])} — expected a-b, e.g. 11-9`); process.exit(1); }
  }

  const res = cmd === 'score'
    ? writeEdit(dataRoot, repo, slug, cat, c => applyScore(c, matchId, games))
    : writeEdit(dataRoot, repo, slug, cat, c => applyForfeit(c, matchId, Number(tokens[0])));
  if (res.err) { console.error(res.err); process.exit(1); }
  if (res.errs) {
    for (const e of res.errs) console.error(e);
    console.error(`not written — ${res.errs.length} validation error(s) — file rolled back`);
    process.exit(1);
  }

  const cjson = info.matches.get(cat);
  const ctx = makeCat({ meta: info.tjson.categories.find(c => c.id === cat), matches: cjson.matches }, info.tjson);
  const m = ctx.byId.get(matchId);
  if (m.forfeit !== undefined) console.log(`${cat}/${matchId} → side ${m.forfeit} forfeits — side ${1 - m.forfeit} wins`);
  else console.log(`${cat}/${matchId} → ${m.games.map(g => `${g.a}-${g.b}`).join(' · ')}${isDone(m, ctx) ? ' — done' : ''}`);
  console.log(`wrote ${path.relative(root, res.file)}`);
  console.log('next: git add -A && git commit -m "…" && git push');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { isScorable, parseGame, applyScore, applyForfeit, listEligible, writeEdit };
