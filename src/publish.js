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
  // surge ≥0.43: `surge <path> publish` reads the domain from site/CNAME.
  const r = spawnSync('surge', ['site/', 'publish'], { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error('publish: surge CLI not found — install once: npm install -g surge');
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

module.exports = { main };
