'use strict';

// Publish — the only thing that ships: validate, then upload site/ to the
// domain in site/CNAME. Tests are the dev gate (pre-commit), validate the data
// gate here — a bypassed hook can't ship. The deploy role follows the branch,
// never the operator's intent: production is the CNAME as origin/main has it,
// and without that anchor only main deploys.

const { spawnSync } = require('child_process');
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
    if (prod !== null && cname !== prod) {
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

// Upload site/ to the domain in site/CNAME. Split from main so the daemon's
// publish can ship without validate.main's process.exit.
function ship(root) {
  const role = deployRole(root);
  if (!role.ok) { console.error(`publish: ${role.why}`); return 1; }
  // git is the record — ship only what the repo has, so a fresh clone + publish
  // reproduces live exactly; the daemon commits every edit, so a dirty site/
  // is a hand-edit history would never see.
  const st = git(root, ['status', '--porcelain', '--', 'site/']);
  const dirty = (st.code === 0 ? st.out : '').trim();
  if (dirty) {
    console.error(`publish: site/ is dirty — commit it first:\n${dirty.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')}${dirty.split('\n').length > 5 ? '\n  …' : ''}`);
    return 1;
  }
  // surge ≥0.43: `surge <path> publish` reads the domain from site/CNAME.
  const r = spawnSync('surge', ['site/', 'publish'], { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error('publish: surge CLI not found — install once: npm install -g surge');
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

module.exports = { main, ship, deployRole, productionCNAME };