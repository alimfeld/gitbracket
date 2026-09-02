'use strict';

// GitBracket match-day simulator — rehearse a whole tournament against a
// scratch copy of site/, watched live in a browser. One process owns both the
// sim clock and the results: it serves .sim/site over HTTP with a script that
// overrides the page's Date.now to the sim clock (so the kiosk's statuses,
// auto-centering, and board clock all track the rehearsal — site/ itself is
// untouched), and the shared editor from repl.js drives the day: same buffer,
// keys, and verbs, but a fake clock, a planScorable playable set, and never
// a commit — the scratch copy is not a repo.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { makeCat, isDone, resolveSide, schedTime, matchLabel, bestOfOf } = require('../site/derive.js');
const { loadRepo } = require('./tools.js');
const { writeEdit, applyScore, defaultSlug, C, editorMain } = require('./repl.js');

const STEP = 30 * 60 * 1000;  // ]/[ move the clock in 30 sim-minutes

// Random games for a match: the winner side takes the target games, with the
// loser's wins leading so no side reaches the target before the last game
// (the validator's match-flow rule); deuce games (12+, +2) a fifth of the time.
function makeGames(bestOf) {
  const target = (bestOf + 1) / 2;
  const n = target + Math.floor(Math.random() * (bestOf - target + 1));
  const winnerIsA = Math.random() < 0.5;
  const games = [];
  for (let i = 0; i < n; i++) {
    const aWins = i < n - target ? !winnerIsA : winnerIsA;
    const deuce = Math.random() < 0.2;
    const ws = deuce ? 12 + Math.floor(Math.random() * 5) : 11;
    const ls = deuce ? ws - 2 : Math.floor(Math.random() * 10);
    games.push(aWins ? { a: ws, b: ls } : { a: ls, b: ws });
  }
  return games;
}

// Due matches at a moment of sim time, with two un-scorable kinds: a due
// match whose sides don't resolve yet is blocked by its feeder, and any due
// match behind an earlier unplayed match on the same venue is blocked by the
// court — a venue plays one match at a time. Scorable = the earliest pending
// due match on a venue, with both sides resolved.
function planScorable(tjson, now) {
  const tz = tjson.timezone || 'UTC';
  const list = [];
  const blocked = [];
  const byVenue = new Map();
  for (const cid of Object.keys(tjson.matches || {})) {
    const meta = (tjson.categories || []).find(c => c.id === cid);
    const ms = tjson.matches[cid] || [];
    const ctx = makeCat({ meta, matches: ms }, tjson);
    for (const m of ms) {
      if (!m || isDone(m)) continue;
      const t = schedTime(m, tz);
      if (t === null || now < t) continue;
      const e = { cat: cid, m, ctx, stage: matchLabel(m, ctx), t };
      const s0 = resolveSide(m.sides && m.sides[0], ctx);
      const s1 = resolveSide(m.sides && m.sides[1], ctx);
      if (s0 && s1) {
        const venue = m.venue || 'TBD';
        if (!byVenue.has(venue)) byVenue.set(venue, []);
        byVenue.get(venue).push(e);
      } else {
        blocked.push({ ...e, wait: m.sides[!s0 ? 0 : 1] });
      }
    }
  }
  const byTime = (a, b) => a.t - b.t || a.cat.localeCompare(b.cat) || a.m.id - b.m.id;
  for (const [venue, es] of byVenue) {
    es.sort(byTime);
    for (let i = 1; i < es.length; i++) blocked.push({ ...es[i], venue, first: es[0] });
    list.push(es[0]);
  }
  list.sort(byTime);
  blocked.sort(byTime);
  return { list, blocked };
}

// Scratch copy of site/ — the rehearsal's whole world; the repo is untouched.
function copySite(root) {
  const dst = path.join(root, '.sim', 'site');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'site'), dst, { recursive: true });
  return dst;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Serve the scratch site with the clock override injected into the one SPA
// page (index.html is every view — fragment routing). The injected script
// owns the only clock the app reads (Date.now), refreshed from /clock once a
// second, so the kiosk statuses, auto-centering, and board clock all track
// the REPL's sim time without a single change to site/.
function serve(siteRoot, clock) {
  return http.createServer((req, res) => {
    if (req.url === '/clock') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ t: clock() }));
      return;
    }
    let rel;
    try { rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, ''); }
    catch { res.statusCode = 400; res.end(); return; }
    const file = path.join(siteRoot, rel === '' ? 'index.html' : rel);
    if (!file.startsWith(siteRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      const inj = `<script>let __simT=${clock()};setInterval(async()=>{try{__simT=(await(await fetch('/clock')).json()).t}catch(e){}},1000);Date.now=()=>__simT;</script>`;
      body = Buffer.from(body.toString('utf8').replace('</head>', inj + '</head>'));
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (cmd) spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// CLI entry (dispatched from gb.js): args = ['<slug>'].
function main(root, args) {
  const slug = args.find((a) => a && !a.startsWith('-')) || null;
  const siteRoot = copySite(root);
  const repo = loadRepo(siteRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  const key = slug || defaultSlug(repo);
  const info = key && repo.tournaments.get(key);
  if (!info || !info.tjson) {
    console.error(`sim: unknown tournament ${JSON.stringify(slug || '')} — have: ${repo.index.map(t => t.slug).join(', ')}`);
    process.exit(1);
  }
  const tjson = info.tjson;
  const tz = tjson.timezone || 'UTC';
  const all = Object.values(tjson.matches || {}).flat();
  const times = all.map(m => schedTime(m, tz)).filter(Number.isFinite);
  if (!times.length) {
    console.error('sim: nothing scheduled — generate a schedule first (node gb.js schedule specs/<slug>.json)');
    process.exit(1);
  }
  const state = { siteRoot, repo, slug: key, tjson, now: Math.min(...times) };
  const server = serve(siteRoot, () => state.now);
  server.listen(0, '127.0.0.1', () => {
    if (!process.stdin.isTTY) { console.error('sim: needs a terminal for keypresses'); process.exit(0); }
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(C.dim(`${tjson.name} — simulated day in .sim/site (never committed) — ${url}`));
    openBrowser(url);

    // Score one match: random games through the real writeEdit — validation,
    // rollback, byte-identical writes. Returns an error string or ''.
    const score = e => {
      const res = writeEdit(state.siteRoot, state.repo, state.slug, e.cat,
        (ms, ctx) => applyScore(ms, e.m.id, makeGames(bestOfOf(e.m, ctx)), ctx));
      return res.errs ? res.errs.join(' ') : res.err ? res.err : '';
    };

    // Re-plan until a pass scores nothing: a child fed by another match in
    // the same batch becomes scoreable once its feeder lands, any order.
    const scoreAll = () => {
      let errs = '';
      let progress = true;
      while (progress) {
        progress = false;
        for (const e of planScorable(state.tjson, state.now).list) {
          const err = score(e);
          if (err) errs += err + '\n'; else progress = true;
        }
      }
      return errs;
    };

    const playable = tjson => {
      const set = new Set();
      for (const e of planScorable(tjson, state.now).list) set.add(`${e.cat} ${e.m.id}`);
      return set;
    };

    // ]/[ nudge the clock, x plays everything due — sim-only keys, hidden
    // from live's hint bar; a string return is an error for the board's
    // message line.
    const simKey = ch => {
      if (ch === ']') { state.now += STEP; return true; }
      if (ch === '[') { state.now -= STEP; return true; }
      if (ch === 'x') return scoreAll() || true;
      return false;
    };

    editorMain(root, siteRoot, repo, {
      sim: true,
      slug: state.slug,
      clock: () => state.now,
      playable,
      simKey,
      onQuit: () => server.close(),
    });
  });
}

module.exports = { makeGames, planScorable, STEP, main };