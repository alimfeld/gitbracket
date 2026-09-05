'use strict';

// Publish — the only thing that ships. git is the record, surge is the
// transport: validate the data, then upload site/ to the domain named in
// site/CNAME. The gate is validate only — tests are the dev gate (pre-commit),
// validate is the data gate (this); a bypassed hook can't ship.

const { spawnSync } = require('child_process');
const validate = require('./validate.js');

// CLI entry (dispatched from gb.js): root is the repo root. validate.main
// exits 1 on data errors, so nothing dirty ever reaches the upload.
function main(root) {
  validate.main(root);
  return ship(root);
}

// Upload site/ to the domain in site/CNAME. Split from main so the editor's
// publish command can ship without validate.main's process.exit.
// Ships only from main: makes the TESTING.md branch/probe recipes harmless
// even when the probe goes wrong — a scratch checkout can't reach the live
// domain by accident.
function ship(root) {
  const b = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const branch = (b.status === 0 ? b.stdout : '').trim();
  if (branch !== 'main') {
    console.error(`publish: will not ship from ${branch ? `branch ${branch}` : 'a detached HEAD'} — checkout main first`);
    return 1;
  }
  // git is the record — ship only what the repo has, so a fresh clone +
  // publish reproduces live exactly. The editor commits every edit, so a
  // dirty site/ is a hand-edit (or a staged file) history would never see.
  const st = spawnSync('git', ['status', '--porcelain', '--', 'site/'], { cwd: root, encoding: 'utf8' });
  const dirty = (st.status === 0 ? st.stdout : '').trim();
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

module.exports = { main, ship };
