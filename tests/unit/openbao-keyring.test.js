'use strict';
const { Keyring } = require('../../src/security/openbao-keyring.cjs');

describe('OpenBao runtime key custody', () => {
  const entries = [{ id: 'first-key', ciphertext: 'vault:v1:AA==' },
    { id: 'second-key', ciphertext: 'vault:v1:BB==' }];
  const first = Buffer.alloc(32, 17);
  const second = Buffer.alloc(32, 29);
  let now, broken, partial, calls, ring;
  beforeEach(() => {
    now = 1000; broken = false; partial = false; calls = [];
    ring = new Keyring({ role: 'asinu-backend', transitKey: 'asinu-health',
      ttlMs: 30000, bundle: { entries } }, {
      now: () => now,
      request: async (path, body) => {
        calls.push({ path, body });
        if (broken) throw new Error('Provider diagnostic containing a secret');
        if (path === 'auth/cert/login') return { auth: { client_token: 'synthetic-token', lease_duration: 900 } };
        return { data: { batch_results: partial
          ? [{ plaintext: first.toString('base64') }, { error: 'secret provider detail' }]
          : [first, second].map(value => ({ plaintext: value.toString('base64') })) } };
      },
    });
  });
  afterEach(() => ring.stop());

  test('unwraps a complete ring and binds each key to its service and purpose', async () => {
    await ring.refresh();
    expect(ring.get('first-key')).toEqual(first);
    expect(ring.get('second-key')).toEqual(second);
    expect(calls[1].body.batch_input.map(item => Buffer.from(item.associated_data, 'base64').toString()))
      .toEqual(['asinu:keyring:v1:asinu-backend:first-key', 'asinu:keyring:v1:asinu-backend:second-key']);
    const copy = ring.get('first-key'); copy.fill(0);
    expect(ring.get('first-key')).toEqual(first);
    expect(() => ring.get('unknown-key')).toThrow();
  });

  test('short outages use the bounded memory cache, expiration fails closed, recovery restores access', async () => {
    await ring.refresh();
    broken = true;
    now += 10000;
    await expect(ring.refresh()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
    expect(ring.get('first-key')).toEqual(first);
    now += 21000;
    expect(() => ring.get('first-key')).toThrow('Encryption keys are temporarily unavailable.');
    expect(ring.keys.size).toBe(0);
    broken = false;
    await ring.refresh();
    expect(ring.get('first-key')).toEqual(first);
  });

  test('never commits partial responses or exposes provider details', async () => {
    await ring.refresh();
    partial = true;
    await expect(ring.refresh()).rejects.toThrow('Encryption keys are temporarily unavailable.');
    expect(ring.get('first-key')).toEqual(first);
    expect(ring.get('second-key')).toEqual(second);
  });

  test('deduplicates concurrent refreshes and wipes key memory on shutdown', async () => {
    await Promise.all(Array.from({ length: 20 }, () => ring.refresh()));
    expect(calls).toHaveLength(2);
    const internal = ring.keys.get('first-key');
    ring.stop();
    expect(internal).toEqual(Buffer.alloc(32));
    expect(() => ring.get('first-key')).toThrow();
  });
});

describe('startup configuration and shutdown boundaries', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let directory, environment, runtime;
  const key = Buffer.alloc(32, 42).toString('base64');
  beforeEach(() => {
    environment = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openbao-config-test-'));
    const files = { 'ca.crt': 'synthetic-ca', 'client.crt': 'synthetic-cert', 'client.key': 'synthetic-private-key',
      'ring.json': JSON.stringify({ version: 1, role: 'asinu-backend', transit_key: 'asinu-health',
        entries: [{ id: 'first-key', ciphertext: 'vault:v1:AA==' }] }) };
    for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 });
    Object.assign(process.env, { KEY_MANAGEMENT_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://127.0.0.1:8200',
      OPENBAO_ROLE: 'asinu-backend', OPENBAO_TRANSIT_KEY: 'asinu-health', OPENBAO_KEYRING_FILE: path.join(directory, 'ring.json'),
      OPENBAO_TLS_CA_FILE: path.join(directory, 'ca.crt'), OPENBAO_TLS_CERT_FILE: path.join(directory, 'client.crt'),
      OPENBAO_TLS_KEY_FILE: path.join(directory, 'client.key'), OPENBAO_KEY_CACHE_TTL_SECONDS: '30' });
    jest.resetModules();
    runtime = require('../../src/security/openbao-keyring.cjs');
  });
  afterEach(() => {
    runtime.stopKeyring(); jest.restoreAllMocks(); process.env = environment;
    fs.rmSync(directory, { recursive: true, force: true }); jest.resetModules();
  });
  const reply = path => path === 'auth/cert/login'
    ? { auth: { client_token: 'synthetic-token', lease_duration: 900 } }
    : { data: { batch_results: [{ plaintext: key }] } };

  test.each(['http:', 'https://user:password@localhost:8200', 'https://localhost:8200?query=1'])(
    'rejects an unsafe service URL before making a request: %s', async address => {
      process.env.OPENBAO_ADDR = address;
      const request = jest.spyOn(runtime.Keyring.prototype, 'httpRequest');
      await expect(runtime.initializeKeyring()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(request).not.toHaveBeenCalled();
    });

  test('rejects duplicate slots and a role mismatch before contacting the key service', async () => {
    const p = path.join(directory, 'ring.json'), bundle = JSON.parse(fs.readFileSync(p));
    bundle.entries.push({ ...bundle.entries[0] }); fs.writeFileSync(p, JSON.stringify(bundle));
    await expect(runtime.initializeKeyring()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    bundle.entries.pop(); bundle.role = 'doctor-backend'; fs.writeFileSync(p, JSON.stringify(bundle));
    await expect(runtime.initializeKeyring()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  test('requires a private TLS key, and refuses symlinks', async () => {
    const p = path.join(directory, 'client.key'); fs.chmodSync(p, 0o644);
    await expect(runtime.initializeKeyring()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    fs.chmodSync(p, 0o600); const link = path.join(directory, 'link.key'); fs.symlinkSync(p, link);
    process.env.OPENBAO_TLS_KEY_FILE = link;
    await expect(runtime.initializeKeyring()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  test('a failed cold start never falls back to legacy environment keys', async () => {
    process.env.DOCTOR_DATA_ENCRYPTION_KEY = 'legacy-key-must-not-be-used';
    jest.spyOn(runtime.Keyring.prototype, 'httpRequest').mockRejectedValue(new Error('provider secret diagnostic'));
    await expect(runtime.initializeKeyring()).rejects.toThrow('Encryption keys are temporarily unavailable.');
    expect(runtime.keyringReady()).toBe(false);
    expect(() => runtime.getKeyBytes('first-key')).toThrow();
  });

  test('stopping during an in-flight refresh cannot repopulate wiped key memory', async () => {
    let finish;
    const ring = new runtime.Keyring({ role: 'asinu-backend', transitKey: 'asinu-health', ttlMs: 30000,
      bundle: { entries: [{ id: 'first-key', ciphertext: 'vault:v1:AA==' }] } }, {
      request: async path => path === 'auth/cert/login' ? reply(path) : new Promise(resolve => { finish = resolve; }),
    });
    const refresh = ring.refresh();
    await Promise.resolve();
    ring.stop(); finish(reply('transit/decrypt/asinu-health'));
    await expect(refresh).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(ring.keys.size).toBe(0);
    await expect(ring.refresh()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  test('cancels a pending global initialization and permits a fresh initialization later', async () => {
    let finish;
    const request = jest.spyOn(runtime.Keyring.prototype, 'httpRequest').mockImplementation(async p =>
      p === 'auth/cert/login' ? reply(p) : new Promise(resolve => { finish = resolve; }));
    const pending = runtime.initializeKeyring(); await Promise.resolve();
    runtime.stopKeyring(); finish(reply('transit/decrypt/asinu-health'));
    await expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(runtime.keyringReady()).toBe(false);
    request.mockImplementation(async p => reply(p));
    await runtime.initializeKeyring(); expect(runtime.keyringReady()).toBe(true);
    expect(runtime.getSecret('first-key')).toBe(Buffer.alloc(32, 42).toString('utf8'));
  });
});
