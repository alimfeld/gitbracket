'use strict';

// Sim launcher — the whole pipeline practiced end to end: a sim/<rand> branch
// off clean main, a scratch surge CNAME (the deploy gate derives production
// from origin/main, so the scratch can never reach it), and one push. Practice,
// never merged — teardown deletes branch and domain, then the real day happens
// on main. The daemon is the operator's to start: `node gb.js admin`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { branchOf, isSimBranch, cleanTree, git, cnameOf } = require('./tools.js');
const { productionCNAME } = require('./publish.js');

const rand = () => Date.now().toString(36).slice(-5);

// Teardown, the mirror of setup: the surge domain first (it stays hosted until
// torn down), the branch last — it must outlive the domain so the CNAME stays
// readable.
function teardown(root) {
  const branch = branchOf(root);
  if (!isSimBranch(branch)) {
    console.error(`sim: not on a sim branch (on ${branch || 'a detached HEAD'}) — nothing to tear down`);
    process.exit(1);
  }
  if (!cleanTree(root)) {
    console.error('sim: the tree is dirty — commit or stash before tearing down');
    process.exit(1);
  }
  const cname = cnameOf(root);
  if (cname === null || cname === productionCNAME(root)) {
    console.error(`sim: site/CNAME (${cname || 'missing'}) does not name a scratch domain — refusing teardown`);
    process.exit(1);
  }
  const s = spawnSync('surge', ['teardown', cname], { cwd: root, stdio: 'inherit' });
  if (s.error || s.status) {
    console.error(`sim: surge teardown ${cname} failed — the domain stays hosted until it succeeds; the branch stays so its CNAME stays readable`);
    process.exit(1);
  }
  git(root, ['checkout', 'main']);
  git(root, ['branch', '-D', branch]);
  git(root, ['push', 'origin', '--delete', branch]);
  console.log(`sim: ${cname} torn down; ${branch} deleted (local + origin)`);
}

// CLI entry (dispatched from gb.js): args = ['--teardown'] | anything, ignored —
// a sim covers the whole site, not one tournament.
function main(root, args) {
  if (args.includes('--teardown')) return teardown(root);
  if (!productionCNAME(root)) {
    console.error('sim: no origin/main — push main once so the production domain exists as the deploy anchor');
    process.exit(1);
  }
  const branch = branchOf(root);
  if (branch !== 'main') {
    console.error(`sim: start from main — on ${branch} right now`);
    process.exit(1);
  }
  if (!cleanTree(root)) {
    console.error('sim: the tree is dirty — commit or stash before branching');
    process.exit(1);
  }
  const name = `sim/${rand()}`;
  const cname = `bracket-sim-${rand()}.surge.sh`;
  const checkout = git(root, ['checkout', '-b', name]);
  if (checkout.code !== 0) { console.error(`sim: checkout ${name} failed:\n${checkout.err}`); process.exit(1); }
  fs.writeFileSync(path.join(root, 'site', 'CNAME'), cname + '\n');
  git(root, ['add', 'site/CNAME']);
  const c = git(root, ['commit', '-m', `chore(sim): scratch domain ${cname} on ${name}`]);
  if (c.code !== 0) { console.error(`sim: CNAME commit failed:\n${c.err}`); process.exit(1); }
  const p = git(root, ['push', '-u', 'origin', name]);
  if (p.code !== 0) console.warn('sim: branch push failed (offline?) — admin publish will refuse until it has an upstream:\n' + p.err);
  console.log(`sim: ${name} — the real pipeline: commits, pushes, and publish to a scratch site`);
  console.log('  start the daemon yourself: node gb.js admin (every edit validates and commits)');
  console.log(`  publish from it ships ${cname} (never the production domain: the gate proves it from origin/main)`);
  console.log(`  kiosk: after publishing, open https://${cname}/ then press sim in a venue board's corner to run its clock`);
  console.log(`  done: node gb.js sim --teardown tears ${cname} down and deletes ${name}`);
  return 0;
}

module.exports = { main };
