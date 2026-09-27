'use strict';

// admin.js: the HTTP layer — serve() is the daemon's one untrusted surface:
// the request body and the Origin header are the only foreign input. A
// malformed request must be answered, never thrown — an unhandled rejection
// out of the async handler kills the match-day daemon mid-tournament.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo } = require('../src/tools.js');
const admin = require('../src/admin.js');
const { scratchWithRemote, anchorCNAME } = require('./admin-helpers.js');

// The guarantee that matters: publish uploads a frozen copy taken at publish
// time, never the live tree — a mid-deploy edit stays pending (un-pushed, not
// live) instead of half-reaching the CDN. A fake surge on PATH records what it
// was asked to upload, and the snapshot must be gone once the deploy ends.
// Put a fake `surge` on PATH for one test; a successful publish runs it with
// the snapshot dir as its first argument. PATH is restored when the test ends.
function withFakeSurge(t, tmp, script) {
  const fakebin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakebin);
  fs.writeFileSync(path.join(fakebin, 'surge'), `#!/bin/sh\n${script}\n`);
  fs.chmodSync(path.join(fakebin, 'surge'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = fakebin + path.delimiter + PATH;
  t.after(() => { process.env.PATH = PATH; });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

const postJson = (base, path, body, origin) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body,
});

function withServer(t, state) {
  const server = admin.serve(state);
  return listen(server).then(base => {
    t.after(() => { server.closeAllConnections(); server.close(); });
    return base;
  });
}

test('admin HTTP: publish deploys a snapshot, never the live tree — the fake surge logs a temp copy, cleaned up after', async t => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  anchorCNAME(tmp, siteRoot);
  const log = path.join(tmp, 'surge.log');
  withFakeSurge(t, tmp, `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nexit 0`);
  const base = await withServer(t, state);
  const r = await postJson(base, '/api/publish', '{}');
  assert.equal(r.status, 200, 'the publish lands');
  assert.equal((await r.json()).text, 'published');
  const args = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(args.length, 2, 'surge got exactly a directory and the publish verb');
  assert.equal(args[1], 'publish');
  const snap = args[0];
  assert.notEqual(snap, siteRoot, 'the deployed dir is a snapshot, not the live tree');
  assert(snap.startsWith(os.tmpdir()), 'the snapshot lives in the temp dir');
  assert(!fs.existsSync(snap), 'the snapshot is cleaned up after the deploy — no litter');
});

// A deploy can fail after its push already landed, leaving nothing pending —
// the retry must still deploy, and the badge must not read "clean".
test('admin HTTP: a publish retry after a failed deploy needs no pending commits', async t => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  anchorCNAME(tmp, siteRoot);
  const marker = path.join(tmp, 'deployed-once');
  withFakeSurge(t, tmp, `[ -f "${marker}" ] && exit 0\ntouch "${marker}"\nexit 1`); // first deploy fails, later ones succeed
  const base = await withServer(t, state);
  const pend = () => fetch(base + '/api/pending').then(r => r.json());
  const failed = await postJson(base, '/api/publish', '{}');
  assert.equal(failed.status, 400, 'the failed deploy is reported, not swallowed');
  assert.equal(admin.unpushed(tmp).commits.length, 0, 'the push already landed — nothing pending to gate the retry on');
  assert.equal((await pend()).deployFailed, true, 'the badge can tell "not live" from "clean"');
  const retry = await postJson(base, '/api/publish', '{}');
  assert.equal(retry.status, 200, 'the retry deploys with nothing pending');
  assert.equal((await retry.json()).text, 'published');
  assert.equal((await pend()).deployFailed, false, 'a successful ship clears the stale flag');
});


test('admin HTTP: an unknown slug is refused, the daemon survives, and state is never repointed', async t => {
  const { tmp, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = await withServer(t, state);
  const bad = await postJson(base, '/api/edit', JSON.stringify({ slug: 'does-not-exist', verb: 'result', cat: 'md40', matchId: '8', value: 'wo a' }));
  assert.equal(bad.status, 400, 'an unknown slug is a refusal, not a crash');
  assert(/unknown tournament/.test((await bad.json()).error), 'the refusal names the slug');
  assert.equal(state.slug, 'sample', 'a bogus slug never repoints the daemon');
  assert.equal((await fetch(base + '/api/pending')).status, 200, 'the daemon still answers');
});


test('admin HTTP: a null or non-object JSON body is refused before any field is read', async t => {
  const { tmp, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = await withServer(t, state);
  for (const body of ['null', '"x"', '[]']) {
    assert.equal((await postJson(base, '/api/edit', body)).status, 400, `body ${body} is refused`);
  }
  assert.equal((await fetch(base + '/api/pending')).status, 200, 'the daemon still answers');
});


test('admin HTTP: a non-object edit value is refused with a 400 — never a hang or a crash', async t => {
  const { tmp, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = await withServer(t, state);
  // the old crash: null/undefined value threw TypeError out of the async
  // handler — an unhandled rejection that killed the match-day daemon
  for (const value of [null, 5, 'x', []]) {
    const r = await postJson(base, '/api/edit', JSON.stringify({ slug: 'sample', verb: 'move', cat: 'md40', matchId: '8', value }));
    assert.equal(r.status, 400, `value ${JSON.stringify(value)} is refused with a response, not hung`);
    assert(/value object/.test((await r.json()).error), 'the refusal names the required shape');
  }
  assert.equal((await fetch(base + '/api/pending')).status, 200, 'the daemon still answers');
});


test('admin HTTP: a cross-origin POST is refused, a same-origin edit still commits', async t => {
  const { tmp, siteRoot, state } = scratchWithRemote();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = await withServer(t, state);
  const edit = JSON.stringify({ slug: 'sample', verb: 'result', cat: 'md40', matchId: '8', value: 'wo a' });
  // Origin: null (a sandboxed iframe, a file:// page) is a cross-origin page
  // like any other — the null string matches neither self, so the one gate
  // refuses it with the rest.
  for (const origin of ['http://evil.example', 'null']) {
    assert.equal((await postJson(base, '/api/edit', edit, origin)).status, 403, `origin ${origin} is refused`);
  }
  const good = await postJson(base, '/api/edit', edit, base);
  assert.equal(good.status, 200, 'the same-origin path is unaffected');
  assert.equal((await good.json()).ok, true);
  const m = loadRepo(siteRoot).tournaments.get('sample').tjson.matches.md40.find(x => x.id === 8);
  assert.equal(m.result.status, 'walkover', 'the edit really reached the funnel');
});
