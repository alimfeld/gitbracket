#!/usr/bin/env node
'use strict';

// GitBracket CLI — the single entry point; every command dispatches into src/.
// Run from anywhere under the repo root (the root is found by walking up).
// The bare `node gb.js` is the admin daemon — the one match-day interface.

const { findRoot } = require('./src/tools.js');
const validate = require('./src/validate.js');
const schedule = require('./src/schedule.js');
const publish = require('./src/publish.js');
const sim = require('./src/sim.js');
const admin = require('./src/admin.js');

const USAGE = 'usage: node gb.js [admin [slug]] [validate [slug]] [schedule <specs/xxx.json>] [publish] [sim [--teardown|slug]]';

function main(argv) {
  const root = findRoot();
  const [verb, ...args] = argv;
  if (verb === 'validate') return validate.main(root, args[0]);
  if (verb === 'schedule') return schedule.main(root, args[0]);
  if (verb === 'publish') return publish.main(root);
  if (verb === 'sim') return sim.main(root, args);
  if (verb === 'admin' || verb === undefined) return admin.main(root, args);
  console.error(`unknown command ${verb} — ${USAGE}`);
  process.exit(1);
}

const code = main(process.argv.slice(2));
if (code) process.exitCode = code;
