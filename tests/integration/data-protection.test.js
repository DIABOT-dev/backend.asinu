'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { provisionRuntimeRole } = require('../../scripts/provision-runtime-role');

const uri = process.env.DATA_PROTECTION_TEST_DATABASE_URL;
const suite = uri ? describe : describe.skip;
suite('isolated data protection integration', () => {
  let client, runtime, dir, role, recoveryDb, initialized = false;
  const cli = (command, args, env = {}) => spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  beforeAll(async () => {
    const parsed = new URL(uri);
    if (!['', 'localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_security_test')) throw Error('Use a local isolated *_security_test database');
    client = new Client({ connectionString: uri }); await client.connect();
    const { rows: [count] } = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
    if (count.n) throw Error('Test database must be empty');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-data-protection-'));
    role = 'asinu_test_' + crypto.randomBytes(6).toString('hex');
    recoveryDb = role + '_recovery';
    initialized = true;
    await client.query('CREATE TABLE fixture(id serial primary key, value text); CREATE TABLE schema_migrations(version text); CREATE TABLE distillation_data(id serial primary key, input_data jsonb)');
    await client.query("INSERT INTO fixture(value) VALUES ('synthetic health fixture')");
    const password = crypto.randomBytes(32).toString('hex');
    await provisionRuntimeRole(client, role, password);
    parsed.hostname = parsed.hostname || 'localhost'; parsed.username = role; parsed.password = password;
    runtime = new Client({ connectionString: parsed.toString() }); await runtime.connect();
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    if (client) {
      if (recoveryDb) await client.query(`DROP DATABASE IF EXISTS "${recoveryDb}" WITH (FORCE)`);
      if (initialized) await client.query('DROP TABLE IF EXISTS fixture, schema_migrations, distillation_data');
      if (role) { await client.query(`DROP OWNED BY "${role}"`); await client.query(`DROP ROLE "${role}"`); }
      await client.end();
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  test('runtime can operate data without superuser, role escalation, DDL or training writes', async () => {
    await runtime.query("INSERT INTO fixture(value) VALUES ('runtime fixture')");
    await runtime.query("UPDATE fixture SET value='updated' WHERE id=2");
    expect((await runtime.query('SELECT count(*)::int AS n FROM fixture')).rows[0].n).toBe(2);
    await runtime.query('DELETE FROM fixture WHERE id=2');
    for (const sql of ['CREATE TABLE forbidden(id int)', 'ALTER TABLE fixture ADD COLUMN forbidden text', 'DROP TABLE fixture', 'CREATE ROLE forbidden', "INSERT INTO schema_migrations VALUES ('bad')", "INSERT INTO distillation_data(input_data) VALUES ('{}')"]) await expect(runtime.query(sql)).rejects.toBeDefined();
    expect((await runtime.query('SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  });
  test('encrypted dump restores exactly and corrupted ciphertext cannot partially restore', async () => {
    const identity = path.join(dir, 'identity.txt');
    expect(cli('age-keygen', ['-o', identity]).status).toBe(0);
    const recipient = cli('age-keygen', ['-y', identity]).stdout.trim();
    const env = { DATABASE_URL: uri, BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: recipient };
    const backedUp = cli('bash', ['scripts/backup-db.sh'], env);
    expect({ status: backedUp.status, stderr: backedUp.stderr }).toEqual({ status: 0, stderr: '' });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.age'));
    expect(files).toHaveLength(1);
    const backup = path.join(dir, files[0]);
    expect(fs.readFileSync(backup).includes(Buffer.from('synthetic health fixture'))).toBe(false);
    expect(cli('age', ['-d', backup]).status).not.toBe(0);
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
    await client.query(`CREATE DATABASE "${recoveryDb}"`);
    const target = new URL(uri); target.pathname = '/' + recoveryDb;
    const restoreEnv = { DATABASE_URL: target.toString(), BACKUP_AGE_IDENTITY: identity, RESTORE_TARGET_DATABASE: recoveryDb };
    const corrupt = path.join(dir, 'corrupt.sql.gz.age');
    const bytes = fs.readFileSync(backup); fs.writeFileSync(corrupt, bytes.subarray(0, bytes.length - 25));
    expect(cli('bash', ['scripts/restore-db.sh', corrupt], restoreEnv).status).not.toBe(0);
    const recovery = new Client({ connectionString: target.toString() }); await recovery.connect();
    try {
      expect((await recovery.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n).toBe(0);
      const restored = cli('bash', ['scripts/restore-db.sh', backup], restoreEnv);
      expect({ status: restored.status, stderr: restored.stderr }).toEqual({ status: 0, stderr: '' });
      expect((await recovery.query('SELECT value FROM fixture')).rows).toEqual([{ value: 'synthetic health fixture' }]);
      expect(cli('bash', ['scripts/restore-db.sh', backup], restoreEnv).status).not.toBe(0);
      expect(cli('bash', ['scripts/restore-db.sh', backup], { ...restoreEnv, RESTORE_TARGET_DATABASE: 'wrong' }).status).not.toBe(0);
      expect(cli('bash', ['scripts/backup-db.sh'], { ...env, BACKUP_AGE_RECIPIENT: '' }).status).not.toBe(0);
      expect(fs.readdirSync(dir).some(f => f.startsWith('.asinu-backup.'))).toBe(false);
    } finally { await recovery.end(); }
  }, 20000);
});
