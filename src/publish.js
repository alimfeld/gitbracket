'use strict';

// Publish — the only thing that ships: validate, then upload site/ to the domain in
// site/CNAME. The deploy role follows the branch: production is the CNAME as
// origin/main has it, and without that anchor only main deploys.

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const validate = require('./validate.js');
const { branchOf, git, cnameOf, loadRepo, unpushed } = require('./tools.js');

// CLI entry: syntactically broken data and unresolved semantic conflicts both stop the ship.
function main(root) {
  const { errs, conflicts } = validate.findings(loadRepo(path.join(root, 'site')));
  for (const e of errs) console.error(`error: ${e}`);
  for (const c of conflicts) console.error(`conflict: ${c}`);
  if (errs.length) { console.error(`publish: ${errs.length} error(s) — fix before publishing`); return 1; }
  if (conflicts.length) { console.error(`publish: ${conflicts.length} conflict(s) — resolve before publishing`); return 1; }
  // Mirror the admin's publish: push the branch when it has a remote, so the
  // deployed content is always the recorded one.
  const p = unpushed(root);
  const push = p.hasRemote ? git(root, ['push']) : { code: 0 };
  if (push.code !== 0) { console.error(`publish: push failed:\n${push.err}`); return 1; }
  return ship(root);
}

// The production domain: site/CNAME as origin/main has it.
function productionCNAME(root) {
  const c = git(root, ['show', 'origin/main:site/CNAME']);
  return c.code === 0 ? c.out.trim() : null;
}

// ok + target domain, or a refusal naming the reason.
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

// Pre-deploy gate: branch role and site/ cleanliness. Error string, else null.
function deployPreflight(root) {
  const role = deployRole(root);
  if (!role.ok) return `publish: ${role.why}`;
  // Ship only what the repo has: a dirty site/ is a hand-edit history would never see.
  const st = git(root, ['status', '--porcelain', '--', 'site/']);
  const dirty = (st.code === 0 ? st.out : '').trim();
  if (dirty) {
    return `publish: site/ is dirty — commit it first:\n${dirty.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')}${dirty.split('\n').length > 5 ? '\n  …' : ''}`;
  }
  return null;
}

// Snapshot site/ on the event loop before the async deploy, so a mid-deploy edit
// can't half-reach the CDN and live is exactly what was pushed.
function snapshotSite(siteRoot) {
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'gbship-'));
  fs.cpSync(siteRoot, snap, { recursive: true });
  return snap;
}

// Upload site/ to the domain in site/CNAME. Async keeps the server answering while
// a multi-minute deploy runs; split from main so the daemon avoids process.exit.
function ship(root) {
  return new Promise((resolve) => {
    const pre = deployPreflight(root);
    if (pre !== null) { console.error(pre); return resolve(1); }
    const snap = snapshotSite(path.join(root, 'site'));
    // Cleanup first, then settle — a throw out of rmSync must not hang the daemon.
    const done = (code) => {
      try { fs.rmSync(snap, { recursive: true, force: true }); } finally { resolve(code); }
    };
    // surge ≥0.43: `surge <path> publish` reads the domain from <path>/CNAME.
    const r = spawn('surge', [snap, 'publish'], { cwd: root, stdio: 'inherit' });
    r.on('error', () => {
      console.error('publish: surge CLI not found — install once: npm install -g surge');
      done(1);
    });
    r.on('close', (code) => done(code === null ? 1 : code));
  });
}

module.exports = { main, ship, snapshotSite, deployRole, productionCNAME };
