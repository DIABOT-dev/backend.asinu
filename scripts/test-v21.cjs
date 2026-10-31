'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dotenv = require('dotenv');
const local = fs.existsSync(path.join(root, '.env'))
  ? dotenv.parse(fs.readFileSync(path.join(root, '.env')))
  : {};
const connection = process.env.CHECKIN_TEST_DATABASE_URL || local.DATABASE_URL;
try {
  const hostname = new URL(connection).hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) throw new Error();
} catch {
  console.error('V2.1 integration tests require a local PostgreSQL database. No test was run.');
  process.exit(1);
}
// Each suite creates and drops its own isolated schema. Runtime secrets, remote
// integrations and the production keyring are not passed into the fixtures.
const child = spawn(process.execPath, [
  path.join(root, 'node_modules/jest/bin/jest.js'),
  'tests/unit/v21-policy.test.js', 'tests/integration/v21.test.js',
  'tests/integration/checkin-gifts.test.js', '--runInBand',
], {
  cwd: root,
  env: {
    ...process.env, CHECKIN_TEST_DATABASE_URL: connection,
    NODE_ENV: 'test', KEY_MANAGEMENT_PROVIDER: 'file',
    REDIS_URL: '', SENTRY_DSN: '', AI_CONSENT_ENFORCEMENT: 'false',
    CRM_INTEGRATION_URL: '', DOCTOR_INTEGRATION_URL: '',
  },
  stdio: 'inherit',
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
