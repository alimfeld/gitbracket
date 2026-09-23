'use strict';

// Publish — the only thing that ships: validate, then upload site/ to the
// domain in site/CNAME. Tests are the dev gate (pre-commit), validate the data
// gate here — a bypassed hook can't ship. The deploy role follows the branch,
// never the operator's intent: production is the CNAME as origin/main has it,
// and without that anchor only main deploys.

const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const validate = require('./validate.js');
const { branchOf, git, cnameOf } = require('./tools.js');

// CLI entry (from gb.js): validate exits 1 on data errors, so nothing dirty ships.
function main(root) {
  validate.main(root);
  return ship(root);
}

// The production domain: site/CNAME as origin/main has it.
function productionCNAME(root) {
  const c = git(root, ['show', 'origin/main:site/CNAME']);
  return c.code === 0 ? c.out.trim() : null;
}

// The deploy decision: ok + the target domain, or a refusal that names the
// reason — shown by the CLI and the admin page.
function deployRole(root) {
  const branch = branchOf(root);
  if (!branch) return { ok: false, why: 'detached HEAD — checkout main or a sim branch first' };
  const cname = cnameOf(root);
  if (cname === null) return { ok: false, why: 'no site/CNAME — nothing to ship to' };
  const prod = productionCNAME(root);
  if (branch === 'main') {
    if (prod === null) {
      return { ok: false, why: 'no origin/main — the production domain is unanchored; push main once so publish can prove site/CNAME against it' };
    }
    if (cname !== prod) {
      return { ok: false, why: `site/CNAME (${cname}) is not the production domain (${prod}) — a scratch domain must not ride main; fix site/CNAME and commit` };
    }
    return { ok: true, domain: cname };
  }
  if (prod === null) {
    return { ok: false, why: 'no origin/main — only main deploys while the production domain is unanchored; push main once' };
  }
  if (cname === prod) {
    return { ok: false, why: `will not ship branch ${branch} to the production domain — its site/CNAME is production; switch to a scratch domain` };
  }
  return { ok: true, domain: cname };
}

// The one pre-deploy gate both ship paths run: the branch role and site/
// cleanliness. An error string, or null when the deploy may proceed.
function deployPreflight(root) {
  const role = deployRole(root);
  if (!role.ok) return `publish: ${role.why}`;
  // git is the record — ship only what the repo has, so a fresh clone + publish
  // reproduces live exactly; the daemon commits every edit, so a dirty site/
  // is a hand-edit history would never see.
  const st = git(root, ['status', '--porcelain', '--', 'site/']);
  const dirty = (st.code === 0 ? st.out : '').trim();
  if (dirty) {
    return `publish: site/ is dirty — commit it first:\n${dirty.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')}${dirty.split('\n').length > 5 ? '\n  …' : ''}`;
  }
  return null;
}

// A synchronous copy of a site root into a fresh temp dir, taken on the event
// loop before the async deploy — no edit can interleave with it, and the copy
// is the immutable thing surge uploads. Deploying the live tree instead would
// let a mid-deploy edit half-reach the CDN: live could get ahead of origin and
// the admin's pending list would lie. With a snapshot, live is always exactly
// what was pushed at publish time.
function snapshotSite(siteRoot) {
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'gbship-'));
  fs.cpSync(siteRoot, snap, { recursive: true });
  return snap;
}

// Upload site/ to the domain in site/CNAME. Split from main so the daemon's
// publish can ship without validate.main's process.exit.
function ship(root) {
  const pre = deployPreflight(root);
  if (pre !== null) { console.error(pre); return 1; }
  const snap = snapshotSite(path.join(root, 'site'));
  try {
    // surge ≥0.43: `surge <path> publish` reads the domain from <path>/CNAME.
    const r = spawnSync('surge', [snap, 'publish'], { cwd: root, stdio: 'inherit' });
    if (r.error) {
      console.error('publish: surge CLI not found — install once: npm install -g surge');
      return 1;
    }
    return r.status === null ? 1 : r.status;
  } finally {
    fs.rmSync(snap, { recursive: true, force: true });
  }
}

// The admin daemon's deploy — the same preflight, snapshot, and surge
// invocation as ship(), async so the server keeps answering while a
// multi-minute push+deploy runs. It owns the snapshot's lifecycle.
function shipAsync(root) {
  return new Promise((resolve) => {
    const pre = deployPreflight(root);
    if (pre !== null) { console.error(pre); return resolve(1); }
    const snap = snapshotSite(path.join(root, 'site'));
    // Cleanup first, then settle — a throw out of rmSync must not hang the daemon.
    const done = (code) => {
      try { fs.rmSync(snap, { recursive: true, force: true }); } finally { resolve(code); }
    };
    const r = spawn('surge', [snap, 'publish'], { cwd: root, stdio: 'inherit' });
    r.on('error', () => {
      console.error('publish: surge CLI not found — install once: npm install -g surge');
      done(1);
    });
    r.on('close', (code) => done(code === null ? 1 : code));
  });
}

module.exports = { main, ship, shipAsync, snapshotSite, deployPreflight, deployRole, productionCNAME };