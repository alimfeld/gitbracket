'use strict';

// Shared plumbing for the admin suites: a scratch git repo in the real
// deployment shape and the deploy-role anchor. Split out so each admin suite
// runs on its own test-runner worker.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRepo } = require('../src/tools.js');
const { FIX } = require('./helpers.js');

const git = (root, args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return { ...r, out: r.stdout || '' }; };
// the admin daemon's own git() renames stdout → out; the helper aliases it so
// tests read the same shape the daemon does

// A scratch repo: site copy from the sample fixture + git, with an origin so
// unpushed() can see a base to measure against (the real deployment shape).
// main is pushed without -u, so the daemon's @{upstream} window falls back to
// origin/main here — exactly the shape a director's own clone has.
function scratchWithRemote() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbadmin-'));
  const siteRoot = path.join(tmp, 'site');
  fs.mkdirSync(siteRoot, { recursive: true });
  fs.cpSync(FIX('sample'), siteRoot, { recursive: true });
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.email', 't@t']);
  git(tmp, ['config', 'user.name', 'test']);
  git(tmp, ['add', '-A']);
  git(tmp, ['commit', '-qm', 'init']);
  git(tmp, ['branch', '-M', 'main']);
  const origin = path.join(tmp, 'origin.git');
  git(tmp, ['init', '-q', '--bare', origin]);
  // the bare origin lives inside the scratch repo — exclude it so the working
  // tree stays clean for the undo assertions
  fs.appendFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'origin.git/\n');
  git(tmp, ['remote', 'add', 'origin', origin]);
  git(tmp, ['push', '-q', 'origin', 'main']);
  const repo = loadRepo(siteRoot);
  return { tmp, siteRoot, state: { root: tmp, siteRoot, repo, slug: 'sample', redo: [] } };
}

const PROD = 'bracket.surge.sh';
// the deploy role's anchor is origin/main's CNAME — stage + commit + push it, or the anchor never exists
const anchorCNAME = (root, siteRoot) => {
  fs.writeFileSync(path.join(siteRoot, 'CNAME'), PROD + '\n');
  git(root, ['add', 'site/CNAME']);
  git(root, ['commit', '-qm', 'cname']);
  git(root, ['push', '-q', 'origin', 'main']);
};

module.exports = { git, scratchWithRemote, PROD, anchorCNAME };
