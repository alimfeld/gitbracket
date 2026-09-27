'use strict';

// Admin daemon — the localhost page and tiny API over the repo. The browser is the
// UI; this process is the only writer, and every edit reuses the editor's
// validate/write/commit funnel. Pending = unpushed commits (@{upstream}..HEAD);
// publish = validate + push + deploy; undo/redo rewind only unpushed history.
// Nothing ships — the page lives under src/admin/ and the daemon serves it locally.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadRepo, catCtx, schedEntries, pairBusy, fixedPlayers, consumedSlots, descendants, slotsOverlap, feederBounds, plainObject, cleanTree, git, cnameOf, defaultSlug } = require('./tools.js');
const { execEdit, parseResult } = require('./edits.js');
const { matchSlotMs, schedTime } = require('../site/derive.js');
const { validateRepo } = require('./validate.js');
const { ship, deployRole } = require('./publish.js');

// Unpushed commits [{sha, msg}] over the branch's own upstream, not origin/main —
// that would count pushed sim commits forever. No upstream: fall back to origin/main.
function unpushed(root) {
  const up = git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
  const ref = up.code === 0 ? '@{upstream}' : 'origin/main';
  const b = git(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (b.code !== 0) return { commits: [], hasRemote: false };
  const l = git(root, ['log', '--oneline', `${ref}..HEAD`]);
  const commits = l.code === 0 && l.out.trim()
    ? l.out.trim().split('\n').map(line => ({ sha: line.slice(0, 7), msg: line.slice(8) }))
    : [];
  return { commits, hasRemote: true };
}

// One path for every verb the page can send; 'move' sets time+venue atomically
// (one validate, one commit). The editor owns the funnel.
function doEdit(state, verb, cat, matchId, value) {
  // The result field is free text — parsed here with the editor's grammar.
  if (verb === 'result' && typeof value === 'string') {
    const p = parseResult(value.trim().split(/\s+/).filter(Boolean));
    if (p.err) return { ok: false, error: p.err }; // the modal keeps the draft and flashes the grammar's own words
    value = p.value;
  }
  const r = execEdit(state, verb, cat, matchId, value);
  // A failure may mean the disk moved since load — reload so a retry isn't stale.
  if (r.errors) { reload(state); return { ok: false, errors: r.errors }; }
  if (r.error) { reload(state); return { ok: false, error: r.error }; }
  if (r.unchanged) return { ok: true, unchanged: true };
  state.redo = []; // a committed edit builds on the post-undo history — redo would replay onto it
  return { ok: true, sha: r.sha };
}

// Both undo and redo reset --hard, so the clean check covers the whole tree.
// Redo verifies HEAD is still the undone commit's parent, so pushed history is
// never rewritten.
function undo(state) {
  if (!cleanTree(state.root)) return { error: 'the repo has uncommitted changes — commit or stash before undoing' };
  const p = unpushed(state.root);
  if (!p.commits.length) return { error: 'nothing to undo' };
  // The window can fall back to origin/main, so a remote ref containing HEAD means the
  // tip is already out — undo stays local to unpushed commits.
  const hosted = git(state.root, ['branch', '-r', '--contains', 'HEAD']);
  if (hosted.code === 0 && hosted.out.trim()) return { error: 'HEAD is already pushed — undo only rewinds unpushed commits' };
  const head = git(state.root, ['rev-parse', 'HEAD']).out.trim();
  const parent = git(state.root, ['rev-parse', 'HEAD~1']);
  if (parent.code !== 0) return { error: 'nothing to undo — the branch is at its first commit' };
  const r = git(state.root, ['reset', '--hard', 'HEAD~1']);
  if (r.code !== 0) return { error: `undo failed: ${r.err}` };
  state.redo.push({ sha: head, parent: parent.out.trim(), msg: p.commits[0].msg }); // the dropped commit — redo's only record of it
  reload(state);
  return { sha: p.commits[0].sha, msg: p.commits[0].msg };
}

// The stack is daemon memory: ponytail: it dies on restart — a refs/admin-redo
// pointer would survive, add when an undo must outlive its session.
function redo(state) {
  const stack = state.redo;
  if (!stack.length) return { error: 'nothing to redo' };
  if (!cleanTree(state.root)) return { error: 'the repo has uncommitted changes — commit or stash before redoing' };
  const top = stack[stack.length - 1];
  if (git(state.root, ['rev-parse', 'HEAD']).out.trim() !== top.parent) {
    stack.length = 0; // stale — the branch moved since the undo; resetting would discard that work
    return { error: 'nothing to redo — the branch moved on' };
  }
  const r = git(state.root, ['reset', '--hard', top.sha]);
  if (r.code !== 0) return { error: `redo failed: ${r.err}` };
  stack.pop();
  reload(state);
  return { sha: top.sha.slice(0, 7), msg: top.msg };
}

// wall "HH:MM" of a stored schedule string; the scan works in wall minutes.
const wallMinOf = s => { const x = /T(\d{2}):(\d{2})/.exec(String(s || '')); return x ? +x[1] * 60 + +x[2] : null; };

// Legal starts for one match as wall-clock minutes per venue, using the gate's own
// rules (schedEntries, pairBusy, feederBounds) so preview and write can't disagree.
// The dragged match is off the board during the query.
function legalSlots(tjson, cat, matchId, day, gcd) {
  const tz = tjson.timezone || 'UTC';
  // The query param is untrusted: floor the step so the scan advances.
  const step = Number.isInteger(gcd) && gcd > 0 ? Math.max(gcd, 5) : 15;
  const { entries } = schedEntries(tjson);
  const others = entries.filter(e => !(e.cat === cat && e.m.id === Number(matchId)));
  const ctx = catCtx(tjson, cat);
  const m = ctx.byId.get(Number(matchId));
  if (!m || !Array.isArray(m.sides) || m.sides.length !== 2) return {}; // malformed match: the gate reports, the preview never offers
  const slotMin = matchSlotMs(m, ctx) / 60000;
  const players = fixedPlayers(m);
  const fb = feederBounds(m, ctx, tz);
  const floor = fb.floor; // m's own bound: its feeder slots' ends, gate-mirrored
  let ceiling = fb.ceiling; // match-edge consumers' starts — a pool's rank consumers are invisible to feederBounds, so the pool scan extends it
  // A pool match has no own bound, but a move is gated by every scheduled knockout
  // match holding a rank slot of its pool. Only committed data reaches the daemon, so
  // this collapses to the earliest scheduled consumer's start.
  if (m.pool !== undefined) {
    for (const C of ctx.matches) {
      if (!C || C.pool !== undefined || C.scheduled === undefined) continue;
      if (!C.sides || !C.sides.some(s => s && s.kind === 'pool' && s.pool === m.pool)) continue;
      const cs = schedTime(C, tz);
      if (cs === null) continue;
      ceiling = ceiling === null ? cs : Math.min(ceiling, cs);
    }
  }
  const out = {};
  // The generator anchors at the category block start, which need not divide
  // the slot length — scan the schedule's lattice, not midnight's.
  const wms = ctx.matches.map(x => wallMinOf(x && x.scheduled)).filter(w => w !== null);
  const offset = wms.length ? Math.min(...wms) % step : 0;
  for (const venue of (tjson.venues || []).filter(plainObject).map(v => v.id)) {
    const ticks = [];
    for (let wm = offset; wm < 1440; wm += step) {
      if (!Number.isFinite(slotMin) || wm + slotMin > 1440) continue;
      const iso = `${day}T${String(Math.floor(wm / 60)).padStart(2, '0')}:${String(wm % 60).padStart(2, '0')}:00`;
      const t = schedTime({ scheduled: iso }, tz);
      if (t === null) continue;
      if (floor !== null && t < floor) continue;
      const slotEnd = t + slotMin * 60000;
      if (ceiling !== null && slotEnd > ceiling) continue;
      let busy = false;
      // the candidate carries the real match so pairBusy sizes its window
      // exactly as the gate sizes the same match
      const cand = { m: { ...m, scheduled: iso, venue }, t, ctx, players };
      for (const e of others) if (pairBusy(cand, e).length) { busy = true; break; }
      if (!busy) ticks.push(wm);
    }
    out[venue] = ticks;
  }
  return out;
}

// Legality for one side, mirroring the gate's atoms. The side being replaced frees
// its own slot; busy players come from overlapping scheduled+undone matches.
function sideOpts(tjson, cat, matchId, si) {
  // The param is untrusted: clamp to the two sides the grid renders.
  si = si === 1 ? 1 : 0;
  const ms = (tjson.matches || {})[cat] || [];
  const ctx = catCtx(tjson, cat);
  const m = ctx.byId.get(Number(matchId));
  if (!m) return {};
  const { pool, edge } = consumedSlots(ms);
  const cur = m.sides && m.sides[si];
  if (cur && cur.kind === 'match') edge.delete(`${cur.match}:${cur.result}`);
  else if (cur && cur.kind === 'pool') pool.delete(`pool:${cur.pool}:${cur.rank}`);
  const { entries } = schedEntries(tjson);
  const mine = entries.find(e => e.cat === cat && e.m.id === Number(matchId));
  let busy = [];
  if (mine) {
    // A player is busy when already scheduled in another overlapping match — venue-blind,
    // since adding any of its players would double-book them. Only fixed players count.
    const mineMs = matchSlotMs(mine.m, mine.ctx);
    const busySet = new Set();
    for (const e of entries) {
      if (e.cat === cat && e.m.id === Number(matchId)) continue;
      if (!Number.isFinite(mineMs) || !e.players) continue;
      if (slotsOverlap(mine.t, mine.t + mineMs, e.t, e.t + matchSlotMs(e.m, e.ctx))) for (const id of e.players) busySet.add(id);
    }
    busy = [...busySet];
  }
  // The full registered roster, not just players appearing in a match.
  const roster = Array.isArray(tjson.players)
    ? tjson.players.filter(p => p && typeof p === 'object' && typeof p.id === 'string').map(p => p.id)
    : [];
  return {
    roster,
    busy,
    consumedRanks: [...pool.keys()],
    consumedEdges: [...edge.keys()],
    descendants: [...descendants(ms, Number(matchId))],
  };
}

// Reload from disk — undo (git reset) rewrites files.
function reload(state) {
  state.repo = loadRepo(state.siteRoot);
}

function json(res, code, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let over = false;
    req.on('data', c => {
      if (over) return;
      b += c;
      // An oversized body is refused by killing the connection — the caller
      // must not hang on a promise that will never get its 'end' (resolve
      // here; the handler's response write on the dead socket is a no-op).
      if (b.length > 1e6) { over = true; req.destroy(); resolve(''); }
    });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

// One static GET under a serving root — MIME by extension, traversal-guarded.
function staticFile(root, rel) {
  const file = path.join(root, rel === '' ? 'index.html' : rel);
  if (path.relative(root, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return { body: fs.readFileSync(file), type: MIME[path.extname(file)] || 'application/octet-stream' };
}

// Open the admin page in the platform browser; CI skips the launch.
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (cmd && !process.env.CI) spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// Serve the admin page (src/admin/) plus site/derive.js.
function serve(state) {
  const pageRoot = path.join(__dirname, 'admin');
  let server;
  server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST') {
      // Any webpage the operator has open can POST to this loopback daemon — a
      // text/plain fetch is a CORS-safelisted "simple" request (no preflight).
      // Reject cross-origin writes so a stray page can't score matches or deploy.
      const o = req.headers.origin;
      const self = `http://127.0.0.1:${server.address().port}`;
      // Origin: null (sandboxed iframe, file://) is truthy and matches neither self, so
      // the check refuses it with the rest.
      if (o && o !== self && o !== self.replace('127.0.0.1', 'localhost')) return json(res, 403, { error: 'forbidden origin' });
    }
    if (url.startsWith('/api/')) {
      if (url === '/api/tournaments') {
        const out = (Array.isArray(state.repo.index) ? state.repo.index : [])
          .filter(t => state.repo.tournaments.has(t.slug) && state.repo.tournaments.get(t.slug).tjson)
          .map(t => ({ slug: t.slug, name: t.name }));
        // the daemon's own default first, matching the serve log
        if (state.slug) out.sort((a, b) => a.slug === state.slug ? -1 : b.slug === state.slug ? 1 : 0);
        return json(res, 200, out);
      }
      if (url === '/api/data' || url === '/api/slots' || url === '/api/sideopts') {
        const q = new URL(req.url, 'http://x').searchParams;
        const slug = q.get('slug') || state.slug;
        const info = state.repo.tournaments.get(slug);
        if (!info || !info.tjson) return json(res, 404, { error: `unknown tournament ${slug}` });
        const body = url === '/api/data' ? info.tjson
          : url === '/api/slots' ? { ok: legalSlots(info.tjson, q.get('cat'), q.get('id'), q.get('day'), +(q.get('gcd') || '15')) }
          : { ok: sideOpts(info.tjson, q.get('cat'), q.get('id'), +(q.get('si') || '0')) };
        return json(res, 200, body);
      }
      if (url === '/api/pending') {
        const p = unpushed(state.root);
        const dirty = git(state.root, ['status', '--porcelain', '--', 'site/']);
        const top = state.redo && state.redo.length ? state.redo[state.redo.length - 1] : null;
        return json(res, 200, { ...p, dirty: dirty.code === 0 && dirty.out.trim().length > 0, slug: state.slug, domain: cnameOf(state.root), deployFailed: !!state.deployFailed, redo: top ? { sha: top.sha.slice(0, 7), msg: top.msg } : null });
      }
      if (url === '/api/edit' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad JSON' }); }
        // Untrusted input: JSON.parse admits null/"x"/[], and a stale page can name
        // any slug. Refuse both — a body dereference would throw out of the async
        // handler and kill the daemon.
        if (!plainObject(body)) return json(res, 400, { error: 'bad JSON body' });
        if (body.slug) {
          if (!state.repo.tournaments.has(body.slug)) return json(res, 400, { error: `unknown tournament ${body.slug}` });
          if (body.slug !== state.slug) { state.slug = body.slug; reload(state); }
        }
        const r = doEdit(state, body.verb, body.cat, String(body.matchId), body.value);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (url === '/api/undo' && req.method === 'POST') {
        const r = undo(state);
        return json(res, r.error ? 400 : 200, r);
      }
      if (url === '/api/redo' && req.method === 'POST') {
        const r = redo(state);
        return json(res, r.error ? 400 : 200, r);
      }
      if (url === '/api/publish' && req.method === 'POST') {
        const errs = validateRepo(loadRepo(state.siteRoot)).errs; // the gate on disk, never memory — the same guarantee publish makes
        if (errs.length) return json(res, 400, { errors: errs });
        const role = deployRole(state.root); // the daemon's console names the failure either way — the page answers with the role's reason
        if (!role.ok) return json(res, 400, { error: role.why });
        const p = unpushed(state.root);
        const push = p.hasRemote ? git(state.root, ['push']) : { code: 0 };
        if (push.code !== 0) return json(res, 400, { error: `push failed:\n${push.err}` });
        state.redo = []; // published — the undone edge is no longer the last act; undo/redo stay local to the unpushed window
        const s = await ship(state.root);
        state.deployFailed = s !== 0; // the badge reads "not live" until a ship actually lands
        return json(res, s === 0 ? 200 : 400, s === 0 ? { text: 'published' } : { error: 'deploy failed — see the daemon output' });
      }
      return json(res, 404, { error: 'unknown api' });
    }
    // static: admin page files, the shared domain modules, and /preview/ (the working
    // tree, loopback only — publish alone ships site/)
    if (url === '/preview' || url.startsWith('/preview/')) {
      const f = staticFile(state.siteRoot, url.replace(/^\/preview\/?/, ''));
      if (!f) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', f.type);
      return res.end(f.body);
    }
    const rel = url.replace(/^\/+/, '') || 'index.html';
    const f = staticFile(rel === 'derive.js' || rel === 'i18n.js' ? state.siteRoot : pageRoot, rel);
    if (!f) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', f.type);
    res.end(f.body);
  });
  return server;
}

// CLI entry (dispatched from gb.js): slug optional.
function main(root, args) {
  const slug = (args.find(a => a && !a.startsWith('-')) || null);
  const siteRoot = path.join(root, 'site');
  const repo = loadRepo(siteRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  const state = { root, siteRoot, repo, slug: slug || defaultSlug(repo), redo: [], deployFailed: false };
  const server = serve(state);
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`GitBracket admin — ${state.slug || '(pick a tournament)'} — ${url}  (ctrl-c quits; every edit validates and commits)`);
    openBrowser(url);
  });
  return 0;
}

module.exports = { legalSlots, sideOpts, doEdit, unpushed, undo, redo, serve, main };
