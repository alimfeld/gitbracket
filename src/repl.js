'use strict';

// GitBracket match-day REPL — navigate, score, move venues; every edit
// validates, writes, and commits itself, so the process can die at any
// instant with nothing lost. Dispatched from gb.js; pure edit functions are
// exported for tests.
//
// Flat command model, no cursors: `use` picks a tournament, `ls` reads it.
// Mutators (score, wo, void, venue, time, publish) are slash-gated — a bare
// spelling is rejected with a hint; every successful edit validates (the
// real validateRepo) and commits immediately. publish ships site/ (validate
// gate, then surge) but never pushes git — that stays the director's manual
// pull --rebase && push. status compares the selected tournament's file
// against the live domain. Tab completes at every position.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { makeCat, isDone, resolveSide, sideLabel, teamLabel, schedTime, fmtTime, matchLabel, poolStandings, poolRanks, fmtDiff, bestOfOf, countWins, sideLetter, winnerIdx, dayKey } = require('../site/derive.js');
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

// Games are cleared so games/result exclusivity stays a round-trip property.
function applyResult(matches, matchId, status, winner) {
  return findMatch(matches, matchId, m => {
    delete m.games;
    m.result = winner === undefined ? { status } : { status, winner };
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

// A side's listing name: unresolved slots keep the long form — "Winner of
// 8", "1st in Pool A" — and a resolved slot appends the compact seed in
// parens, so the team reads first with its origin beside it: Ada / Grace (7W).
function listingSide(side, ctx) {
  const ids = resolveSide(side, ctx);
  if (!ids) return sideLabel(side, ctx); // includes the TBD fallback
  const seed = side.kind === 'match' ? `${side.match}${side.result === 'winner' ? 'W' : 'L'}`
    : side.kind === 'pool' ? `${side.pool}${side.rank}` : null;
  const name = teamLabel(ids, ctx);
  return seed === null ? name : `${name} (${seed})`;
}

function formatMatchLine(cid, m, ctx, tz, stage, g) {
  const t = schedTime(m, tz);
  const time = t === null ? C.yellow('TBD'.padStart(8)) : C.dim(fmtTime(t, tz).padStart(8));
  const v = m.venue || 'TBD';
  const venue = (m.venue ? C.magenta : C.yellow)(v.padEnd(g.venuew || v.length));
  // slot shape = best-of, same as the cards: real games render, the rest are ·
  const parts = (m.games || []).map(g => `${g.a}-${g.b}`);
  while (parts.length < (bestOfOf(m, ctx) || 1)) parts.push('·');
  const r = m.result;
  const score = !r || r.status === 'played' ? C.green(parts.join(' '))
    : C.yellow(r.status === 'void' ? 'void' : `W/O side ${r.winner}`);
  const s0 = listingSide(m.sides[0], ctx);
  const s1 = listingSide(m.sides[1], ctx);
  // decided matches color the winner green — the played score column already
  // reads green, so a green winner name and its score are one win signal;
  // void has no winner, nothing colored. Padding is plain-text arithmetic
  // pasted after the colored label — ANSI codes never count into widths.
  const w = winnerIdx(m);
  const sides = (w === 0 ? C.green(s0) : s0) + ' '.repeat(Math.max(0, g.leftw - s0.length))
    + C.dim(' vs ') + (w === 1 ? C.green(s1) : s1) + ' '.repeat(Math.max(0, g.rightw - s1.length));
  const stagePad = ' '.repeat(Math.max(0, g.stagew - stage.length));
  // the ref is "<category> <id>" — it copy-pastes straight into a /score line
  const ref = `${cid} ${m.id}`;
  return `${C.bold(ref.padEnd(g.idw))}  ${C.dim(stage)}${stagePad}  ${sides}  ${time}  ${venue}  ${score}`;
}

// The `ls` filter: a case-insensitive substring over a player's id and
// display name ("ada" finds p1/Ada Lovelace, "lovelace" also does; "win" does
// not — unresolved slots have no player to match).
function makePlayerHit(tjson, needle) {
  const plist = tjson.players || [];
  const nameOf = id => { const p = plist.find(p => p.id === id); return p ? p.name : id; };
  const n = needle && needle.toLowerCase();
  // no filter → falsy, so callers skip filtering entirely
  return n ? ids => [...ids].some(id => (id + '|' + nameOf(id)).toLowerCase().includes(n)) : null;
}

// The match-day listing. cats are the categories to show (one for `ls md`,
// all for bare `ls`); needle is the ls player filter — it narrows standings
// to the player's own row(s) and matches to the ones a side actually
// contains. Unfiltered, this is the whole score desk sheet.
// Two passes: resolve categories first (a player filter drops categories the
// player never plays in), collecting global column widths, then render, so
// sides line up across the whole listing — not just within a category.
function listText(repo, slug, cats, needle) {
  const info = repo.tournaments.get(slug);
  const tjson = info.tjson;
  const tz = tjson.timezone || 'UTC';
  const playerHit = makePlayerHit(tjson, needle);
  const head = ['#', 'Team', 'W', 'L', 'GD', 'PD']; // same headers as the site's standings table

  // pass 1 — per-category blocks and the widths shared across every match
  const secs = [];
  const g = { idw: 0, stagew: 0, leftw: 0, rightw: 0, venuew: 0 };
  for (const cid of cats) {
    const meta = tjson.categories.find(c => c.id === cid);
    const matches = info.matches.get(cid) || [];
    const ctx = makeCat({ meta, matches }, tjson);
    const tables = [];
    const poolIds = [...new Set(matches.filter(m => m.pool).map(m => m.pool))].sort();
    for (const pid of poolIds) {
      const st = poolStandings(ctx, pid, true);
      if (!st) continue;
      // ranks come from the full ladder (dead-tie members share it), before the player filter drops rows
      const ranks = poolRanks(st);
      const rows = [];
      for (let i = 0; i < st.length; i++) {
        const r = st[i];
        if (playerHit && !playerHit(r.ids)) continue; // ls <name>: the player's rows only
        rows.push([String(ranks[i]), teamLabel(r.ids, ctx), String(r.wins), String(r.losses), fmtDiff(r.gd), fmtDiff(r.pd)]);
      }
      if (rows.length) tables.push({ pid, rows });
    }
    // matches — a player filter keeps only matches whose sides resolve to it
    let all = matches.map(m => ({ m, stage: matchLabel(m, ctx) }));
    if (playerHit) all = all.filter(({ m }) => (m.sides || []).some(s => {
      const ids = resolveSide(s, ctx);
      return !!ids && playerHit(ids);
    }));
    if (all.length) {
      // ids are chronological — listing by id is the day's running order, no
      // separate round/placement sort needed
      all.sort((a, b) => a.m.id - b.m.id);
      for (const { m, stage } of all) {
        g.idw = Math.max(g.idw, `${cid} ${m.id}`.length);
        g.stagew = Math.max(g.stagew, stage.length);
        g.leftw = Math.max(g.leftw, listingSide(m.sides[0], ctx).length);
        g.rightw = Math.max(g.rightw, listingSide(m.sides[1], ctx).length);
        g.venuew = Math.max(g.venuew, (m.venue || 'TBD').length);
      }
    }
    if (tables.length || all.length) secs.push({ cid, meta, ctx, tables, all });
  }

  // pass 2 — render, one blank line between sections; every category gets the
  // same prominent heading whether one is shown (ls md) or all (bare ls)
  const lines = [];
  let any = false;
  for (const sec of secs) {
    const body = [];
    lines.push(''); // a heading is never glued to the prompt line above
    body.push(C.bold(C.under(C.cyan(`${sec.meta ? sec.meta.name : sec.cid} — ${sec.cid}`)))) // name first, id after
    if (sec.tables.length) {
      // one continuous box per pool; column widths align across a section's pools;
      // the pool id lives in the Team header cell — no separate title line
      const wid = head.map((h, c) => Math.max(h.length,
        ...sec.tables.map(t => (c === 1 ? `Pool ${t.pid} Teams` : h).length),
        ...sec.tables.flatMap(t => t.rows).map(r => r[c].length)));
      const w = n => '─'.repeat(n + 2);
      const top = '┌' + wid.map(w).join('┬') + '┐';
      const mid = '├' + wid.map(w).join('┼') + '┤';
      const bot = '└' + wid.map(w).join('┴') + '┘';
      const fmt = cells => '│' + cells.map((c, i) => ' ' + (i === 1 ? c.padEnd(wid[i]) : c.padStart(wid[i])) + ' ').join('│') + '│';
      for (const { pid, rows } of sec.tables) {
        const hdr = head.map((h, i) => i === 1 ? `Pool ${pid} Teams` : h);
        body.push('', top, fmt(hdr), mid, ...rows.map(fmt), bot);
      }
    }
    if (sec.all.length) {
      if (body.length) body.push('');
      for (const { m, stage } of sec.all) body.push(formatMatchLine(sec.cid, m, sec.ctx, tz, stage, g));
    }
    if (body.length) { any = true; lines.push(...body); }
  }
  if (!any) lines.push(needle ? `nothing for ${JSON.stringify(needle)}` : 'no matches');
  return lines.join('\n') + '\n'; // the listing always ends on a blank line
}

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

// Bare commands never mutate data or ship: reading + session are bare,
// editing must be slashed. The slash only permits a mutator — slashing a bare
// command (ls, use…) is harmless and accepted.
const BARE = ['use', 'ls', 'status', 'help', 'quit', 'q'];
const MUT = ['score', 'wo', 'void', 'venue', 'time', 'publish'];

function parseCmd(line) {
  const [raw, ...args] = line.trim().split(/\s+/);
  if (raw === '') return { kind: 'unknown', args: [], needSlash: false };
  if (raw.startsWith('/')) {
    const head = raw.slice(1);
    return { kind: MUT.includes(head) || BARE.includes(head) ? head : 'unknown', args, needSlash: false };
  }
  if (MUT.includes(raw)) return { kind: raw, args, needSlash: true }; // bare mutator → hint, never executed
  if (BARE.includes(raw)) return { kind: raw, args, needSlash: false };
  return { kind: 'unknown', args: [], needSlash: false };
}

// ---------- git + repo I/O (thin shell, not unit-tested) ----------

function git(root, args) {
  // spawnSync, not execSync: execSync has no argv array — args must be baked
  // into the command string, which breaks ids with spaces and quotes.
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { code: r.status === 0 ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };
}

// ---------- REPL ----------

function helpText() {
  return `${C.bold('bare commands — read-only, never touch anything:')}
  use <slug>            select a tournament (bare: list tournaments; tab completes slugs)
  ls [category] [name]  matches — bare: the whole matchday sheet; add a category and/or
                        a player name to narrow (standings keep that player's rows)
  status                validate errors, git state, and live-domain comparison
  help                  this text
  quit (q)              leave — every edit is already committed

${C.bold('slash commands — they edit data or ship:')}
  /score <cat> <id> <a:b> [a:b …]   set games — a prefix is a mid-match update, re-score corrects
  /wo <cat> <id> <a|b>              walkover: side a or b wins without playing (opponent can't)
  /void <cat> <id>                  void: no winner, nothing counts (both sides out)
  /venue <cat> <id> <venue>         move a match to another court
  /time <cat> <id> <hh:mm>          shift a match to another time today
  /publish                          validate, then ship site/ to the domain (git push stays manual)

${C.dim('a bare line never mutates data or ships — a bare mutator is rejected with "did you mean /…?"')}`;
}

function makePrompt(state) {
  const p = state.slug ? C.cyan(state.slug) : '';
  return `gitbracket${p ? ':' + p : ''}> `;
}

function completer(state) {
  return line => {
    const parts = line.split(/\s+/).filter(Boolean);
    const partial = parts.length ? parts[parts.length - 1] : '';
    const v = parts[0] || '';
    const ALL = [...BARE, ...MUT.map(m => '/' + m)];
    let cands = [];
    if (!v) cands = ALL;
    else if (parts.length === 1) cands = ALL.filter(c => c.startsWith(v));
    else {
      const verb = v.startsWith('/') ? v.slice(1) : v;
      const info = state.slug ? state.repo.tournaments.get(state.slug) : null;
      const cats = info ? (info.tjson.categories || []).map(c => c.id) : [];
      if (verb === 'use' && parts.length === 2) cands = [...state.repo.tournaments.keys()];
      else if (verb === 'ls' && parts.length === 2) cands = cats;
      else if (verb === 'ls' && parts.length === 3) {
        const plist = (info && info.tjson.players) || [];
        cands = plist.flatMap(p => [p.id, p.name]);
      } else if (MUT.includes(verb) && verb !== 'publish' && parts.length === 2) cands = cats;
      else if (MUT.includes(verb) && verb !== 'publish' && parts.length === 3) {
        const arr = cats.includes(parts[1]) ? info.matches.get(parts[1]) : null;
        cands = arr ? arr.map(m => String(m.id)) : []; // ids are numbers; startsWith needs strings
      } else if (verb === 'venue' && parts.length === 4) {
        cands = ((info && info.tjson.venues) || []).map(v => v.id);
      }
    }
    return [cands.filter(c => c.startsWith(partial) && c !== partial).slice(0, 100), partial];
  };
}

function tournamentList(state) {
  if (!state.repo.index.length) return 'no tournaments — add one to tournaments.json';
  return state.repo.index.map(e => {
    const info = state.repo.tournaments.get(e.slug);
    const n = info && info.tjson ? (info.tjson.categories || []).length : 0;
    return `${C.bold(C.cyan(e.name))}  (${e.slug}) — ${n} categor${n === 1 ? 'y' : 'ies'}`;
  }).join('\n');
}

function listing(state, cat, player) {
  if (state.slug === null) return tournamentList(state);
  const info = state.repo.tournaments.get(state.slug);
  const cats = (info.tjson.categories || []).map(c => c.id);
  if (cat != null && !cats.includes(cat)) return `unknown category ${cat} — have: ${cats.join(', ')}`;
  return listText(state.repo, state.slug, cat === null ? cats : [cat], player || null);
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

function gitStatus(root) {
  const lines = [];
  const s = git(root, ['status', '-sb']);
  if (s.code === 0 && s.out.trim()) lines.push(s.out.trim());
  // Unpushed commits, one per line; a missing origin/main (clone, offline)
  // silences the section the same way the prompt indicators used to.
  const unpushed = git(root, ['log', '--oneline', 'origin/main..HEAD']);
  if (unpushed.code === 0) for (const l of unpushed.out.trim().split('\n')) if (l) lines.push(`  ${l}`);
  return lines.join('\n') || '(clean)';
}

// Compare the one file this session edits — tournaments/<slug>.json — with
// what the live domain serves, so `status` answers "is what I have what's
// live?" without assuming how it got there (gb.js publish, plain surge, CI —
// all invisible here, all covered). The file is a few KB, so a GET + text
// compare is the whole check; no host-specific headers. Offline is "unknown",
// never "stale" or "current". Thin shell, not unit-tested (network).
async function liveStatus(state) {
  if (state.slug === null) return ''; // no single tournament file at root
  let domain;
  try { domain = fs.readFileSync(path.join(state.siteRoot, 'CNAME'), 'utf8').trim(); }
  catch { return 'live: no site/CNAME — unknown'; }
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
  const v = validateText(state.repo);
  const s = gitStatus(state.root);
  const live = await liveStatus(state);
  return [v, s, live].filter(Boolean).join('\n');
}

// ---------- shallow ANSI paint (TTY only — piped output stays plain) ----------

const C = (() => {
  const tty = process.stdout.isTTY; // colors are no-ops when piped — callers need no guard
  const w = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: s => w(1, s), dim: s => w(2, s), red: s => w(31, s), yellow: s => w(33, s), green: s => w(32, s), cyan: s => w(36, s), magenta: s => w(35, s), under: s => w(4, s) };
})();

// Color the final output string — commands and pure functions stay plain.
function paint(s) {
  if (!s) return s;
  if (s.includes('not written') || s.includes('but the commit failed') || s.startsWith('not published')) return C.red(s);
  return s.split('\n').map(l =>
    /^(error:|unknown |bad |\d+ error\(s\))/.test(l) ? C.red(l)
    : /^(warn:|usage:|\(\d+ warning\(s\)\))/.test(l) ? C.yellow(l)
    : /committed |— done$|wins$|^validate: ok$|^published$/.test(l) ? C.green(l)
    : /^→ /.test(l) ? C.cyan(l)
    : l
  ).join('\n');
}

// One-line summary of what changed — mirror it in the commit message and the
// echo. Keyed off the edit kind, never the match state, so a venue or time
// edit on an already-decided match reports the move, not the result.
function editDetail(kind, m) {
  const r = m.result;
  return kind === 'score' ? (m.games || []).map(gg => `${gg.a}:${gg.b}`).join(' · ')
    : kind === 'time' ? `→ ${m.scheduled}`
    : kind === 'venue' ? `→ ${m.venue}`
    : r.status === 'void' ? 'void' : `side ${r.winner} wins by walkover`;
}

// Apply + write + commit one edit; every successful edit is a commit, so the
// tree is never dirty for long and Ctrl-C can't lose anything.
function applyAndCommit(state, kind, cat, matchId, apply) {
  const { root, siteRoot, repo, slug } = state;
  const res = writeEdit(siteRoot, repo, slug, cat, apply);
  if (res.err) return res.err;
  if (res.errs) return res.errs.join('\n') + '\nnot written — validation error(s), file rolled back';
  const info = repo.tournaments.get(slug);
  const matches = info.matches.get(cat);
  const ctx = makeCat({ meta: info.tjson.categories.find(c => c.id === cat), matches }, info.tjson);
  const m = ctx.byId.get(Number(matchId));
  const detail = editDetail(kind, m);
  const msg = commitMessage(kind, slug, cat, matchId, detail);
  git(root, ['add', path.relative(root, res.file)]);
  const c = git(root, ['commit', '-m', msg]);
  if (c.code !== 0) return `wrote ${path.relative(root, res.file)} but the commit failed:\n${c.err}\n(file staged — commit it manually)`;
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  // the echo mirrors the commit message — one dispatch (detail), plus the
  // score-only "— done" flag, so a completed score can never read as a walkover
  const sum = `${cat}/${matchId} → ${detail}${kind === 'score' && isDone(m) ? ' — done' : ''}`;
  return `${sum}\ncommitted ${sha}: ${msg}`;
}

function editCmd(state, kind, cat, matchId, rest) {
  if (kind === 'score') {
    if (!matchId || rest.length === 0) return 'usage: /score <category> <match> <a:b> [a:b ...]';
    const games = rest.map(parseGame);
    const bad = rest.findIndex((t, i) => !games[i]);
    if (bad !== -1) return `bad score ${JSON.stringify(rest[bad])} — expected a:b, e.g. 11:9`;
    return applyAndCommit(state, 'score', cat, matchId, (c, ctx) => applyScore(c, matchId, games, ctx));
  }
  if (kind === 'wo') {
    const side = rest[0];
    if (side === undefined) return 'usage: /wo <category> <match> a|b';
    if (side !== 'a' && side !== 'b') return 'side must be a or b';
    return applyAndCommit(state, 'walkover', cat, matchId, c => applyResult(c, matchId, 'walkover', side));
  }
  if (kind === 'void') {
    if (matchId === undefined) return 'usage: /void <category> <match>';
    return applyAndCommit(state, 'void', cat, matchId, c => applyResult(c, matchId, 'void'));
  }
  if (kind === 'venue') {
    const venueId = rest[0];
    if (!venueId) return 'usage: /venue <category> <match> <venue>';
    return applyAndCommit(state, 'venue', cat, matchId, c => applyVenue(c, matchId, venueId));
  }
  if (kind === 'time') {
    const hhmm = rest[0];
    if (!hhmm) return 'usage: /time <category> <match> <hh:mm>';
    const tz = state.repo.tournaments.get(state.slug).tjson.timezone;
    const iso = buildScheduled(hhmm, tz);
    if (!iso) return `bad time ${JSON.stringify(hhmm)} — expected hh:mm, e.g. 10:30`;
    return applyAndCommit(state, 'time', cat, matchId, c => applyTime(c, matchId, iso));
  }
}

function dispatch(cmd, state) {
  if (cmd.needSlash) return `did you mean /${cmd.kind}?`;
  const { kind, args } = cmd;
  if (kind === 'ls') {
    // a filter token is only a category id when it is one
    const cats = state.slug ? (state.repo.tournaments.get(state.slug).tjson.categories || []).map(c => c.id) : [];
    const first = args[0];
    const cat = first && cats.includes(first) ? first : null;
    const player = args.slice(cat ? 1 : 0).join(' ') || null;
    return listing(state, cat, player);
  }
  if (kind === 'use') {
    if (!args[0]) return tournamentList(state);
    const info = state.repo.tournaments.get(args[0]);
    if (!info) return `unknown tournament ${args[0]} — tab completes`;
    if (!info.tjson) return `tournament ${args[0]} has no readable data — the validator reports it`;
    state.slug = args[0];
    return '→ ' + args[0];
  }
  if (kind === 'status') return statusCmd(state);
  if (kind === 'help') return helpText();
  if (kind === 'publish') return gitPublish(state);
  const [cat, matchId, ...rest] = args;
  if (!cat || matchId === undefined) return `usage: /${kind} <category> <match> … — see help`;
  return editCmd(state, kind, cat, matchId, rest);
}

// a null file would crash every command, so skip it.
function defaultSlug(repo) {
  if (!repo.index.length) return null;
  const last = repo.index[repo.index.length - 1];
  const info = last && repo.tournaments.get(last.slug);
  return info && info.tjson ? last.slug : null;
}

function replMain(root, siteRoot, repo) {
  const state = { root, siteRoot, repo, slug: defaultSlug(repo) };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: completer(state), historySize: 500 });
  const show = () => { rl.setPrompt(makePrompt(state)); rl.prompt(); };
  console.log(C.dim('gitbracket — tab completes, help for commands, quit to leave'));
  rl.on('line', async line => {
    const t = line.trim();
    if (!t) console.log(paint(listing(state)));
    else {
      const cmd = parseCmd(t);
      if (cmd.kind === 'q' || cmd.kind === 'quit') { state.quit = true; rl.close(); return; }
      const out = cmd.kind === 'unknown' ? `unknown command ${t.split(/\s+/)[0]} — help` : await dispatch(cmd, state);
      console.log(paint(out));
    }
    if (state.quit) return; // quit/EOF landed while this async command was in flight
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

module.exports = { parseGame, buildScheduled, applyScore, applyResult, applyVenue, applyTime, writeEdit, commitMessage, editDetail, parseCmd, listText, completer, defaultSlug, dispatch, main };
