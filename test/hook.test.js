'use strict';

// The pre-commit hook: always validate, run the suite unless every staged
// path is tournament data (the suite reads fixtures only — never live data —
// so a data-only commit can't change its outcome). Exercised against a scratch
// repo with a fake `node` on PATH that logs invocations — the real hook file
// runs, the real suite never does. The direction that matters: a code commit
// must still reach node --test; a data-only commit must not.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const HOOK_DIR = path.join(__dirname, '..', '.githooks');

function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbhook-'));
  fs.mkdirSync(path.join(tmp, 'site', 'tournaments'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'site', 'tournaments.json'), '[]\n');
  fs.writeFileSync(path.join(tmp, 'site', 'tournaments', 'a.json'), '{}\n');
  const git = (args, env) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'init']); // unhooked — the scratch site is not a valid repo
  return { tmp, git };
}

test('pre-commit: data-only commits skip the suite, anything else runs it', () => {
  const { tmp, git } = scratch();
  const fake = path.join(tmp, 'fakebin');
  const log = path.join(tmp, 'node.log');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'node'), `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`);
  fs.chmodSync(path.join(fake, 'node'), 0o755);
  const env = { ...process.env, PATH: fake + path.delimiter + process.env.PATH };
  try {
    git(['config', 'core.hooksPath', HOOK_DIR]);
    // only tournament data staged → the fast lane
    fs.writeFileSync(path.join(tmp, 'site', 'tournaments', 'b.json'), '{}\n');
    git(['add', 'site/tournaments/b.json']);
    assert.equal(git(['commit', '-qm', 'data'], env).status, 0, 'data-only commit lands');
    let calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert(calls.includes('gb.js validate'), 'the disk validate always runs');
    assert(!calls.includes('--test'), 'the suite is skipped for data-only commits');
    // a code change → the full gate
    fs.writeFileSync(path.join(tmp, 'README.md'), '# scratch\n');
    git(['add', 'README.md']);
    assert.equal(git(['commit', '-qm', 'code'], env).status, 0, 'code commit lands');
    calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert(calls.includes('--test'), 'a non-data commit still runs the suite');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});