'use strict';

// sim.js teardown — the destructive side of the practice pipeline: the surge
// domain goes down first, then the branch (local, then remote). Exercised
// through the real CLI in a scratch repo with a fake `surge` on PATH (the
// hook.test.js pattern: the fake logs invocations and exits 0). The direction
// that matters: a failed `checkout main` aborts before anything is deleted —
// the old code kept going, pushed the remote delete, and claimed success.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const GB = path.join(__dirname, '..', 'gb.js');
const FIX = name => path.join(__dirname, '..', 'fixtures', name);

// A scratch repo in the deployment shape: site/ from the sample fixture,
// production CNAME on main, pushed to a bare origin — origin/main is the
// deploy gate's anchor.
function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbsim-'));
  const siteRoot = path.join(tmp, 'site');
  fs.mkdirSync(siteRoot, { recursive: true });
  fs.cpSync(FIX('sample'), siteRoot, { recursive: true });
  const git = (args) => { const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' }); return { ...r, out: r.stdout || '' }; };
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  git(['branch', '-M', 'main']);
  const origin = path.join(tmp, 'origin.git');
  git(['init', '-q', '--bare', origin]);
  // origin.git and the fake bin live inside tmp — keep them out of the tree so
  // teardown's clean check sees a pristinely committed repo
  fs.appendFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'origin.git/\nbin/\n');
  git(['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(siteRoot, 'CNAME'), 'prod.surge.sh\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'cname']);
  git(['push', '-q', 'origin', 'main']);
  return { tmp, git };
}

// A sim branch off main: scratch CNAME committed and pushed, tree clean.
function toSimBranch(tmp, git) {
  git(['checkout', '-qb', 'sim/x1', 'main']);
  fs.writeFileSync(path.join(tmp, 'site', 'CNAME'), 'bracket-sim-x1.surge.sh\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'scratch cname']);
  git(['push', '-qu', 'origin', 'sim/x1']);
}

// fake surge on PATH — the real CLI spawns 'surge'; the log proves the domain
// teardown was actually requested
function envWithFakeSurge(tmp) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'surge'), `#!/bin/sh\necho "$*" >> "${path.join(tmp, 'surge.log')}"\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'surge'), 0o755);
  return { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
}

const runTeardown = (tmp, env) => spawnSync(process.execPath, [GB, 'sim', '--teardown'], { cwd: tmp, encoding: 'utf8', env });

test('sim teardown: happy path — domain down first, branch deleted locally and on origin', () => {
  const { tmp, git } = scratch();
  try {
    toSimBranch(tmp, git);
    const env = envWithFakeSurge(tmp);
    const r = runTeardown(tmp, env);
    assert.equal(r.status, 0, r.stderr);
    assert(fs.readFileSync(path.join(tmp, 'surge.log'), 'utf8').includes('teardown bracket-sim-x1.surge.sh'), 'the fake surge was asked for the scratch domain');
    assert.equal(git(['branch', '--list', '--format=%(refname:short)']).out.trim(), 'main', 'the sim branch is gone, main is checked out');
    assert(!git(['branch', '-r']).out.includes('sim/x1'), 'the remote branch is deleted too');
    assert(/deleted \(local \+ origin\)/.test(r.stdout), r.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sim teardown: checkout main failure aborts before anything is deleted', () => {
  const { tmp, git } = scratch();
  try {
    toSimBranch(tmp, git);
    // main gone locally AND its tracking ref — plain `checkout main` scans
    // local refs only, so nothing can resurrect it (DWIM included)
    git(['branch', '-D', 'main']);
    git(['update-ref', '-d', 'refs/remotes/origin/main']);
    const env = envWithFakeSurge(tmp);
    const r = runTeardown(tmp, env);
    assert.equal(r.status, 1, 'a failed checkout refuses the teardown');
    assert(/checkout main failed/.test(r.stderr), r.stderr);
    assert.equal(git(['branch', '--list', '--format=%(refname:short)']).out.trim(), 'sim/x1', 'the sim branch still exists locally');
    assert(git(['branch', '-r']).out.includes('origin/sim/x1'), 'the remote branch was never push-deleted');
    assert.equal(fs.readFileSync(path.join(tmp, 'site', 'CNAME'), 'utf8').trim(), 'bracket-sim-x1.surge.sh', 'the scratch CNAME stays readable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});