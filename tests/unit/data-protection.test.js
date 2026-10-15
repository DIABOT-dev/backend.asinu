'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { databaseOptions } = require('../../src/lib/database-options');
const distillation = require('../../src/core/ai/distillation');

describe('data protection defaults', () => {
  test('does not collect or reuse patient content as training examples', async () => {
    const pool = { query: jest.fn(() => { throw new Error('No training DB access allowed'); }) };
    expect(await distillation.collectOutput(pool, 'triage', 'gpt-4o', [{ content: 'private' }], {})).toBeNull();
    expect(await distillation.getFewShotExamples(pool, 'triage')).toEqual([]);
    expect(await distillation.enhanceWithFewShot(pool, 'triage', [{ role: 'user', content: 'hello' }])).toEqual({ messages: [{ role: 'user', content: 'hello' }], enhancedWith: 0 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('verified TLS fails closed without a CA or with URI overrides', () => {
    const uri = 'postgres://runtime:test@db:5432/test';
    expect(databaseOptions(uri, {})).toEqual({ connectionString: uri });
    expect(() => databaseOptions(uri, { DB_TLS_REQUIRE: 'tru' })).toThrow(/true or false/);
    expect(() => databaseOptions(uri, { DB_TLS_REQUIRE: 'true' })).toThrow(/CA_FILE/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-ca-'));
    try {
      const file = path.join(dir, 'ca.pem'); fs.writeFileSync(file, 'fixture CA');
      const env = { DB_TLS_REQUIRE: 'true', DB_TLS_CA_FILE: file };
      const ssl = databaseOptions(uri, env).ssl;
      expect(ssl).toMatchObject({ ca: 'fixture CA', rejectUnauthorized: true });
      expect(ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:localhost' })).toBeDefined();
      expect(ssl.checkServerIdentity('ignored', { subjectaltname: 'DNS:db' })).toBeUndefined();
      for (const param of ['sslmode=disable', 'sslmode=no-verify', 'sslrootcert=bad']) expect(() => databaseOptions(`${uri}?${param}`, env)).toThrow(/SSL URI/);
      expect(() => databaseOptions(uri, { ...env, DB_TLS_CA_FILE: file + '-missing' })).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
