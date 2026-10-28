'use strict';
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { initializeKeyring } = require('./openbao-keyring.cjs');

async function start() {
  const entry = process.argv[2];
  if (!entry) throw new Error('An application entry point is required.');
  await initializeKeyring();
  // Keep argv compatible with the original migration/server command.
  process.argv.splice(1, 1);
  require(path.resolve(entry));
}
start().catch(() => {
  console.error('Application startup stopped: encryption keys are unavailable.');
  process.exitCode = 1;
});
