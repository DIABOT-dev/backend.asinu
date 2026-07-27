'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const suites = [
  'tests/phase1-lifecycle.test.js',
  'tests/hard-cases-p1p2.test.js',
  'tests/hard-cases-p3p4.test.js',
  'tests/hard-cases-p5p6.test.js',
  'tests/phase2-deep.test.js',
  'tests/phase2-notification.test.js',
  'tests/phase3-illusion.test.js',
  'tests/phase4-companion.test.js',
  'tests/phase4-deep.test.js',
  'tests/phase5-reengagement.test.js',
  'tests/phase6-cache-priority.test.js',
  'tests/cross-phase-integration.test.js',
  'tests/llm-optimization.test.js',
];

for (const suite of suites) {
  console.log(`\n[legacy-test-runner] ${suite}`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', suite)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n[legacy-test-runner] ${suites.length} suites passed`);
