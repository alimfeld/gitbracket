'use strict';

// publish.js: the deploy gate (role / CNAME anchor), the frozen snapshot, and
// ship's preflight. Run against a scratch git repo (see admin-helpers.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const publish = require('../src/publish.js');
const { FIX } = require('./helpers.js');
const { git, scratchWithRemote, PROD, anchorCNAME } = require('./admin-helpers.js');

test('publish ship: the one deploy path shares the preflight gate — a role refusal resolves fast without spawning anything', async () => {
  const { tmp } = scratchWithRemote();
  // the sample fixture has no CNAME, so deployRole refuses before any surge call
  assert.equal(await publish.ship(tmp), 1, 'the deploy resolves the refusal as a failure');
});


test('publish snapshotSite: a frozen copy of site/ — CNAME included, live tree untouched', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    const snap = publish.snapshotSite(siteRoot);
    try {
      assert.notEqual(snap, siteRoot, 'the snapshot is a fresh directory, not site/ itself');
      const expected = fs.readFileSync(path.join(siteRoot, 'tournaments.json'), 'utf8');
      assert.equal(fs.readFileSync(path.join(snap, 'tournaments.json'), 'utf8'), expected, 'the index rides along byte-identical');
      assert(fs.existsSync(path.join(snap, 'tournaments', 'sample.json')), 'tournament files ride along');
      assert.equal(fs.readFileSync(path.join(snap, 'CNAME'), 'utf8').trim(), PROD, 'the CNAME rides along — surge reads its domain from the deployed dir');
    } finally {
      fs.rmSync(snap, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish deployRole: main ships production, refuses any other CNAME', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    assert.deepEqual(publish.deployRole(tmp), { ok: true, domain: PROD }, 'main ships its production CNAME');
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), 'bracket-sim-x.surge.sh\n'); // uncommitted — the role reads the file, not the tree
    const r = publish.deployRole(tmp);
    assert.equal(r.ok, false, 'a scratch CNAME on main is refused');
    assert(/not the production domain/.test(r.why), 'the refusal names the mismatch');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('publish deployRole: off main ships only its own scratch CNAME, never production', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    git(tmp, ['checkout', '-qb', 'sim/sample-x']);
    assert.equal(publish.deployRole(tmp).ok, false, 'a branch still carrying production is refused');
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), 'bracket-sim-x.surge.sh\n');
    assert.deepEqual(publish.deployRole(tmp), { ok: true, domain: 'bracket-sim-x.surge.sh' }, 'its own scratch domain ships');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('publish deployRole: no origin/main anchor — a branch cannot prove itself scratch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbpub-'));
  try {
    const siteRoot = path.join(tmp, 'site');
    fs.mkdirSync(siteRoot, { recursive: true });
    fs.cpSync(FIX('sample'), siteRoot, { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), PROD + '\n');
    git(tmp, ['init', '-q']);
    git(tmp, ['config', 'user.email', 't@t']);
    git(tmp, ['config', 'user.name', 'test']);
    git(tmp, ['add', '-A']);
    git(tmp, ['commit', '-qm', 'init']);
    git(tmp, ['branch', '-M', 'main']); // never pushed — no origin/main
    assert.equal(publish.deployRole(tmp).ok, false, 'without the anchor even main cannot prove its CNAME is production');
    const fresh = publish.deployRole(tmp);
    assert(/origin\/main/.test(fresh.why), 'the refusal names the missing anchor');
    git(tmp, ['checkout', '-qb', 'sim/x']);
    const r = publish.deployRole(tmp);
    assert.equal(r.ok, false, 'without the anchor a branch cannot prove its domain is scratch');
    assert(/origin\/main/.test(r.why), 'the refusal names the missing anchor');
    git(tmp, ['checkout', '-q', 'main']);
    git(tmp, ['checkout', '-q', '--detach']);
    assert.equal(publish.deployRole(tmp).ok, false, 'a detached HEAD never ships');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('publish deployRole: a blank CNAME reads as missing, not as a scratch domain', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    git(tmp, ['checkout', '-qb', 'sim/blank']);
    fs.writeFileSync(path.join(siteRoot, 'CNAME'), '\n'); // blank and uncommitted
    const r = publish.deployRole(tmp);
    assert.equal(r.ok, false, 'a blank CNAME is not a domain to ship to');
    assert(/no site\/CNAME/.test(r.why), 'the refusal is the missing-CNAME one, never a downstream surge failure');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish main: a semantic conflict stops the ship at the gate', () => {
  const { tmp, siteRoot } = scratchWithRemote();
  try {
    anchorCNAME(tmp, siteRoot);
    const file = path.join(siteRoot, 'tournaments', 'sample.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ms = d.matches.md40;
    ms.find(m => m.id === 9).venue = ms.find(m => m.id === 10).venue; // shares m10's court and time
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    assert.equal(publish.main(tmp), 1, 'a conflict refuses before any deploy');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
