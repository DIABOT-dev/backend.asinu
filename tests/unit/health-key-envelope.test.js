'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('health keys protected by OpenBao', () => {
  const kek = crypto.randomBytes(32);
  let directory, environment, fields, envelope, available;
  beforeEach(() => {
    environment = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-wrapped-key-'));
    fs.chmodSync(directory, 0o700);
    process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.HEALTH_FIELD_KEY_DIRECTORY = directory;
    available = true;
    jest.resetModules();
    jest.doMock('../../src/security/openbao-keyring.cjs', () => ({
      keyringEnabled: () => true, keyringReady: () => available,
      getKeyBytes: () => { if (!available) throw new Error('Key service unavailable'); return Buffer.from(kek); },
    }));
    fields = require('../../src/security/health-field-encryption');
    envelope = require('../../src/security/health-key-envelope');
  });
  afterEach(() => {
    process.env = environment;
    fs.rmSync(directory, { recursive: true, force: true });
    jest.dontMock('../../src/security/openbao-keyring.cjs');
    jest.resetModules();
  });

  test('reads old database ciphertext after protecting the original user key', () => {
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('asinu-health-v1\0' + '42\0chat_histories.message'));
    const ciphertext = Buffer.concat([cipher.update('Dữ liệu cũ', 'utf8'), cipher.final()]);
    const legacy = fields.PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    const protectedKey = envelope.protectHealthKey(42, key);
    expect(protectedKey.length).toBe(93);
    expect(protectedKey.includes(key)).toBe(false);
    fs.writeFileSync(path.join(directory, '42.key'), protectedKey, { mode: 0o600 });
    expect(fields.decryptHealthField(42, 'chat_histories.message', legacy)).toBe('Dữ liệu cũ');
    const next = fields.encryptHealthField(42, 'chat_histories.message', 'Dữ liệu mới');
    expect(fields.decryptHealthField(42, 'chat_histories.message', next)).toBe('Dữ liệu mới');
  });

  test('new users have only protected keys on disk and swapping or tampering keys fails', () => {
    const text = fields.encryptHealthField(42, 'chat_histories.message', 'fixture');
    const key = fs.readFileSync(path.join(directory, '42.key'));
    expect(key.toString().startsWith(envelope.KEY_PREFIX)).toBe(true);
    fs.writeFileSync(path.join(directory, '43.key'), key, { mode: 0o600 });
    expect(() => fields.encryptHealthField(43, 'chat_histories.message', 'other')).toThrow();
    key[25] ^= 1;
    fs.writeFileSync(path.join(directory, '42.key'), key);
    expect(() => fields.decryptHealthField(42, 'chat_histories.message', text)).toThrow();
  });

  test('rejects legacy plaintext key files, expired caches, and incomplete temporary files', () => {
    fs.writeFileSync(path.join(directory, '42.key'), crypto.randomBytes(32), { mode: 0o600 });
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'fixture')).toThrow();
    fs.unlinkSync(path.join(directory, '42.key'));
    available = false;
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'fixture')).toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  test('deleted owners cannot recreate a wrapped key', () => {
    fields.encryptHealthField(42, 'chat_histories.message', 'fixture');
    fields.retireHealthKey(42);
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'stale')).toThrow();
    expect(fs.readdirSync(directory)).toEqual(['42.key.deleted']);
  });

  test('OpenBao deployments cannot silently disable health field encryption', () => {
    process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'false';
    expect(() => fields.encryptHealthField(42, 'chat_histories.message', 'fixture')).toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
