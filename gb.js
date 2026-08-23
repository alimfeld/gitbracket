#!/usr/bin/env node
'use strict';

// GitBracket CLI — the single entry point; every command dispatches into src/.
// Run from anywhere under the repo root (the root is found by walking up).

const { findRoot } = require('./src/tools.js');
const repl = require('./src/repl.js');
const validate = require('./src/validate.js');
const schedule = require('./src/schedule.js');
const publish = require('./src/publish.js');

const USAGE = 'usage: node gb.js [validate [slug]] [schedule <specs/xxx.json>] [publish]';

function main(argv) {
  const root = findRoot();
  const [verb, ...args] = argv;
  if (verb === 'validate') return validate.main(root, args[0]);
  if (verb === 'schedule') return schedule.main(root, args[0]);
  if (verb === 'publish') return publish.main(root);
  if (verb === undefined) return repl.main(root);
  console.error(`unknown command ${verb} — ${USAGE}`);
  process.exit(1);
}

const code = main(process.argv.slice(2));
if (code) process.exitCode = code;
