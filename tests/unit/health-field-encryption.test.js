'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fields = require('../../src/security/health-field-encryption');

describe('per-owner authenticated health field encryption', () => {
  let directory, old;
  beforeEach(() => {
    old = { enabled: process.env.HEALTH_FIELD_ENCRYPTION_ENABLED, directory: process.env.HEALTH_FIELD_KEY_DIRECTORY };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-owner-keys-'));
    fs.chmodSync(directory, 0o700);
    process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.HEALTH_FIELD_KEY_DIRECTORY = directory;
  });
  afterEach(() => {
    if (old.enabled === undefined) delete process.env.HEALTH_FIELD_ENCRYPTION_ENABLED; else process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = old.enabled;
    if (old.directory === undefined) delete process.env.HEALTH_FIELD_KEY_DIRECTORY; else process.env.HEALTH_FIELD_KEY_DIRECTORY = old.directory;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  test('round trips Unicode, empty strings and prefix-like user text with randomized ciphertext', () => {
    for (const text of ['Tôi đau đầu, huyết áp 120/80', '', fields.PREFIX + 'user text']) {
      const first = fields.encryptHealthField(42, 'chat_histories.message', text);
      const second = fields.encryptHealthField(42, 'chat_histories.message', text);
      expect(first).not.toBe(second);
      expect(first).not.toContain(text || 'not-present');
      expect(fields.decryptHealthField(42, 'chat_histories.message', first)).toBe(text);
    }
    expect(fs.statSync(path.join(directory, '42.key')).mode & 0o077).toBe(0);
    expect(fields.encryptHealthField(42, 'chat_histories.message', null)).toBeNull();
  });
  test('rejects modified bytes, wrong user, wrong field, missing keys and removed configuration', () => {
    const cipher = fields.encryptHealthField(42, 'chat_histories.message', 'private');
    fields.encryptHealthField(43, 'chat_histories.message', 'other');
    expect(() => fields.decryptHealthField(43, 'chat_histories.message', cipher)).toThrow();
    expect(() => fields.decryptHealthField(42, 'doctor_task_messages.content', cipher)).toThrow();
    const bytes = Buffer.from(cipher.slice(fields.PREFIX.length), 'base64url'); bytes[28] ^= 1;
    expect(() => fields.decryptHealthField(42, 'chat_histories.message', fields.PREFIX + bytes.toString('base64url'))).toThrow();
    fs.unlinkSync(path.join(directory, '42.key'));
    expect(() => fields.decryptHealthField(42, 'chat_histories.message', cipher)).toThrow();
    expect(fs.existsSync(path.join(directory, '42.key'))).toBe(false);
    delete process.env.HEALTH_FIELD_ENCRYPTION_ENABLED;
    expect(() => fields.decryptHealthField(42, 'chat_histories.message', cipher)).toThrow();
  });
  test('rejects traversal, permissive key files and symlinks', () => {
    expect(() => fields.encryptHealthField('../escape', 'chat_histories.message', 'a')).toThrow();
    const key = path.join(directory, '42.key');fs.writeFileSync(key, crypto.randomBytes(32), { mode: 0o644 });
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'a')).toThrow();
    fs.unlinkSync(key);fs.symlinkSync('/etc/passwd', key);
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'a')).toThrow();
  });
  test('deletion removes the active key and prevents stale requests from recreating it', async () => {
    const cipher = fields.encryptHealthField(42, 'chat_histories.message', 'private');
    fields.retireHealthKey(42);
    expect(fs.existsSync(path.join(directory, '42.key'))).toBe(false);
    expect(() => fields.decryptHealthField(42, 'chat_histories.message', cipher)).toThrow();
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'stale request')).toThrow();
    fields.encryptHealthField(43, 'chat_histories.message', 'orphan');
    fields.encryptHealthField(44, 'chat_histories.message', 'active');
    expect(await fields.cleanupOrphanHealthKeys({ query: async () => ({ rows: [{ id: 44 }] }) })).toBe(1);
    expect(fs.existsSync(path.join(directory, '44.key'))).toBe(true);
  });
  test('simultaneous processes publish one complete owner key atomically', async () => {
    const modulePath = require.resolve('../../src/security/health-field-encryption');
    const commands = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(modulePath)}).encryptHealthField(42,'chat_histories.message','fixture'))`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';child.stdout.on('data', chunk => { output += chunk; });child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output) : reject(Error('Key creation raced')));
    }));
    for (const cipher of await Promise.all(commands)) expect(fields.decryptHealthField(42, 'chat_histories.message', cipher)).toBe('fixture');
    expect(fs.readdirSync(directory)).toEqual(['42.key']);
  });
});
