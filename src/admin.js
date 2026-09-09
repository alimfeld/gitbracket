'use strict';

// GitBracket admin daemon — a localhost page plus a tiny API over the repo.
// The browser is the UI; this process is the only writer (git is the record):
// every edit reuses the editor's writeEdit funnel — validate, write, commit —
// so the browser can never outrun the gate. Pending = unpushed commits
// (origin/main..HEAD); publish = validate + push + deploy; undo = reset the
// last commit, offered only while unpushed (history is append-only once
// pushed); redo = restore the commit the last undo dropped, live only while
// the undo is still the last act.
// Nothing ships — site/ is untouched; the page lives under src/admin/ and the
// daemon serves it locally, exactly as sim serves .sim/site.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadRepo, staticFile, catCtx, schedEntries, pairBusy, fixedPlayers, consumedSlots, descendants, slotsOverlap, feederBounds } = require('./tools.js');
const { execEdit, defaultSlug, git, parsePayload } = require('./editor.js');
const { matchSlotMs, schedTime } = require('../site/derive.js');
const { validateRepo } = require('./validate.js');
const { ship } = require('./publish.js');

// The unpushed commits as [{sha, msg}], empty when no remote or nothing pending.
function unpushed(root) {
  const b = git(root, ['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (b.code !== 0) return { commits: [], hasRemote: false };
  const l = git(root, ['log', '--oneline', 'origin/main..HEAD']);
  const commits = l.code === 0 && l.out.trim()
    ? l.out.trim().split('\n').map(line => ({ sha: line.slice(0, 7), msg: line.slice(8) }))
    : [];
  return { commits, hasRemote: true };
}

// Validate the gate on disk (never memory) — the same guarantee publish makes.
function gate(siteRoot) {
  const { errs } = validateRepo(loadRepo(siteRoot));
  return errs;
}

// The edit funnel, one path for every verb the page can send — score/wo/void/
// clear via 'result', venue, time, a side, or a combined 'move' (a drag sets
// time+venue atomically: one validate, one commit — a half-moved match must
// never land). The editor owns the funnel (execEdit); this is the JSON view.
function doEdit(state, verb, cat, matchId, value) {
  state.commit = true; // the daemon always commits — git is the record
  // The page's one free-text entry is the result field: the raw string arrives
  // here and is parsed with the terminal editor's grammar (parsePayload), so
  // the browser and the terminal can never drift. Everything else arrives
  // pre-shaped (venue id, side object, a move's time+venue).
  if (verb === 'result' && typeof value === 'string') {
    const info = state.repo.tournaments.get(state.slug);
    const tz = (info && info.tjson && info.tjson.timezone) || 'UTC';
    const p = parsePayload('result', value.trim().split(/\s+/).filter(Boolean), tz, Date.now());
    if (p.err) return { ok: false, error: p.err }; // the modal keeps the draft and flashes the grammar's own words
    value = p.value;
  }
  const r = execEdit(state, verb, cat, matchId, value);
  if (r.errors) return { ok: false, errors: r.errors };
  if (r.error) return { ok: false, error: r.error };
  if (r.unchanged) return { ok: true, unchanged: true, text: r.text };
  state.redo = []; // a committed edit builds on the post-undo history — redo would replay onto it
  return { ok: true, sha: r.sha, text: r.text };
}

// Both resets (undo, redo) need a pristine tree — one predicate for the mirrors.
function cleanTree(root) {
  return git(root, ['diff', '--quiet']).code === 0 && git(root, ['diff', '--cached', '--quiet']).code === 0;
}

// undo/redo — mirror resets across the same edge. Undo drops HEAD (the pending
// gate below makes the dropped commit unpushed by definition); redo restores
// it as fresh pending. Both reset --hard, so the clean check must cover the
// whole working tree — a site/-only scope would silently wipe an in-progress
// edit elsewhere (README, a spec); untracked files are safe (reset --hard
// leaves them) and stay unblocking. Redo is offered only while the undo is
// still the last act — any committed edit or publish clears the stack, and the
// redo itself verifies HEAD is still the undone commit's parent, so the reset
// can only move back along the exact edge the undo took: pushed history is
// never rewritten.
function undo(state) {
  if (!cleanTree(state.root)) return { error: 'the repo has uncommitted changes — commit or stash before undoing' };
  const p = unpushed(state.root);
  if (!p.commits.length) return { error: 'nothing to undo' };
  const head = git(state.root, ['rev-parse', 'HEAD']).out.trim();
  const parent = git(state.root, ['rev-parse', 'HEAD~1']).out.trim();
  const r = git(state.root, ['reset', '--hard', 'HEAD~1']);
  if (r.code !== 0) return { error: `undo failed: ${r.err}` };
  state.redo.push({ sha: head, parent, msg: p.commits[0].msg }); // the dropped commit — redo's only record of it
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

// The day's legal starts for one match, as wall-clock minutes per venue — the
// grid ticks (0..1440 step gcd) where the move passes the gate's own rules:
// venue/player conflicts via the validator's shared atoms (schedEntries +
// pairBusy), feeder bounds via tools.js's feederBounds — the same functions
// validateRepo runs, so the preview and the write gate can't disagree. The
// dragged match is off the board during the query: its own window conflicts
// with nothing.
function legalSlots(tjson, cat, matchId, day, gcd) {
  const tz = tjson.timezone || 'UTC';
  const { entries } = schedEntries(tjson);
  const others = entries.filter(e => !(e.cat === cat && e.m.id === Number(matchId)));
  const ctx = catCtx(tjson, cat);
  const m = ctx.byId.get(Number(matchId));
  if (!m || !Array.isArray(m.sides) || m.sides.length !== 2) return {}; // malformed match: the gate reports, the preview never offers
  const slotMin = matchSlotMs(m, ctx) / 60000;
  const players = fixedPlayers(m);
  const fb = feederBounds(m, ctx, tz);
  let floor = fb.floor; // m's own bound: its feeder slots' ends (match-edge + pool sides), gate-mirrored
  let ceiling = fb.ceiling; // match-edge consumers' starts — a pool match's rank consumers are invisible to feederBounds, so the pool scan extends it
  // A pool match carries no own bound, yet a move is gated by every scheduled
  // knockout match holding a rank slot of its pool: such a consumer must start
  // after the pool's last scheduled end. Only committed data reaches this daemon
  // (every edit validates), so a move can only raise the pool end — the whole
  // consumer set collapses to one bound, the earliest scheduled consumer's start.
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
  for (const venue of (tjson.venues || []).map(v => v.id)) {
    const ticks = [];
    for (let wm = 0; wm < 1440; wm += gcd) {
      if (!Number.isFinite(slotMin) || wm + slotMin > 1440) continue;
      const iso = `${day}T${String(Math.floor(wm / 60)).padStart(2, '0')}:${String(wm % 60).padStart(2, '0')}:00`;
      const t = schedTime({ scheduled: iso }, tz);
      if (t === null) continue;
      if (floor !== null && t < floor) continue;
      const slotEnd = t + slotMin * 60000;
      if (ceiling !== null && slotEnd > ceiling) continue;
      let busy = false;
      // the candidate carries the real match — its pool and slotMinutes size
      // the window pairBusy tests, exactly as the gate sizes the same match
      const cand = { m: { ...m, scheduled: iso, venue }, t, ctx, players };
      for (const e of others) if (pairBusy(cand, e).length) { busy = true; break; }
      if (!busy) ticks.push(wm);
    }
    out[venue] = ticks;
  }
  return out;
}

// The side picker's legality for one side of one match, mirroring the gate's
// own atoms (consumedSlots, schedEntries, slotsOverlap, descendants) so the
// options the modal greys and validateRepo agree — same no-drift deal as legalSlots.
// The side being replaced frees its own slot. Busy players come only from
// scheduled+undone matches overlapping this one (unscheduled: no window, so
// no player is busy yet — the drag gate protects a later slot).
function sideOpts(tjson, cat, matchId, si) {
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
    // A player is busy when they're already scheduled in any other
    // scheduled+undone match whose window overlaps this one — venue-blind, and
    // independent of whether the two matches share a player, because adding any
    // of that match's players here would double-book them. Only fixed players
    // count (a slot side resolves later; the gate's own pairBusy is the same).
    const mineMs = matchSlotMs(mine.m, mine.ctx);
    const busySet = new Set();
    for (const e of entries) {
      if (e.cat === cat && e.m.id === Number(matchId)) continue;
      if (!Number.isFinite(mineMs) || !e.players) continue;
      if (slotsOverlap(mine.t, mine.t + mineMs, e.t, e.t + matchSlotMs(e.m, e.ctx))) for (const id of e.players) busySet.add(id);
    }
    busy = [...busySet];
  }
  return {
    busy,
    consumedRanks: [...pool.keys()],
    consumedEdges: [...edge.keys()],
    descendants: [...descendants(ms, Number(matchId))],
  };
}

// Reload the repo from disk — undo (git reset) rewrites files, so the in-memory
// view must be rebuilt or the next edit would validate against stale data.
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
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

// Serve the admin page (src/admin/) plus site/derive.js (the shared domain model).
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
      if (o && o !== self && o !== self.replace('127.0.0.1', 'localhost')) return json(res, 403, { error: 'forbidden origin' });
    }
    if (url.startsWith('/api/')) {
      if (url === '/api/tournaments') {
        const out = state.repo.index
          .filter(t => state.repo.tournaments.has(t.slug) && state.repo.tournaments.get(t.slug).tjson)
          .map(t => ({ slug: t.slug, name: t.name }));
        // the daemon's own default first, so the page boots on the same
        // tournament the serve log names — one source of truth for the active one
        if (state.slug) out.sort((a, b) => a.slug === state.slug ? -1 : b.slug === state.slug ? 1 : 0);
        return json(res, 200, out);
      }
      if (url === '/api/data') {
        const slug = new URL(req.url, 'http://x').searchParams.get('slug') || state.slug;
        const info = state.repo.tournaments.get(slug);
        if (!info || !info.tjson) return json(res, 404, { error: `unknown tournament ${slug}` });
        return json(res, 200, info.tjson);
      }
      if (url === '/api/slots') {
        const q = new URL(req.url, 'http://x').searchParams;
        const info = state.repo.tournaments.get(q.get('slug') || state.slug);
        if (!info || !info.tjson) return json(res, 404, { error: 'unknown tournament' });
        return json(res, 200, { ok: legalSlots(info.tjson, q.get('cat'), q.get('id'), q.get('day'), +(q.get('gcd') || '15')) });
      }
      if (url === '/api/sideopts') {
        const q = new URL(req.url, 'http://x').searchParams;
        const info = state.repo.tournaments.get(q.get('slug') || state.slug);
        if (!info || !info.tjson) return json(res, 404, { error: 'unknown tournament' });
        return json(res, 200, { ok: sideOpts(info.tjson, q.get('cat'), q.get('id'), +(q.get('si') || '0')) });
      }
      if (url === '/api/pending') {
        const p = unpushed(state.root);
        const dirty = git(state.root, ['status', '--porcelain', '--', 'site/']);
        const top = state.redo && state.redo.length ? state.redo[state.redo.length - 1] : null;
        return json(res, 200, { ...p, dirty: dirty.code === 0 && dirty.out.trim().length > 0, slug: state.slug, redo: top ? { sha: top.sha.slice(0, 7), msg: top.msg } : null });
      }
      if (url === '/api/edit' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad JSON' }); }
        if (body.slug && body.slug !== state.slug) { state.slug = body.slug; reload(state); }
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
        const errs = gate(state.siteRoot);
        if (errs.length) return json(res, 400, { errors: errs });
        const p = unpushed(state.root);
        const push = p.hasRemote ? git(state.root, ['push']) : { code: 0 };
        if (push.code !== 0) return json(res, 400, { error: `push failed:\n${push.err}` });
        state.redo = []; // published — the undone edge is no longer the last act; undo/redo stay local to the unpushed window
        const s = ship(state.root);
        return json(res, s === 0 ? 200 : 400, s === 0 ? { text: 'published' } : { error: 'deploy failed — see the daemon output' });
      }
      return json(res, 404, { error: 'unknown api' });
    }
    // static: admin page files + the one shared domain module
    const rel = url.replace(/^\/+/, '') || 'index.html';
    const f = staticFile(rel === 'derive.js' ? state.siteRoot : pageRoot, rel);
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
  const state = { root, siteRoot, repo, slug: slug || defaultSlug(repo), redo: [] };
  const server = serve(state);
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`GitBracket admin — ${state.slug || '(pick a tournament)'} — ${url}  (ctrl-c quits; every edit validates and commits)`);
    if (process.platform === 'darwin' && !process.env.CI) {
      const { spawn } = require('child_process');
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  });
  return 0;
}

module.exports = { legalSlots, sideOpts, doEdit, unpushed, undo, redo, main };
