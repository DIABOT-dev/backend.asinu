'use strict';

process.env.JWT_SECRET = 'social-identity-security-test-only';

jest.mock('../../src/services/integrations/crm-event.service', () => ({
  emitCrmEventAsync: jest.fn().mockResolvedValue(undefined),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const authRoutes = require('../../src/routes/auth.routes');
const authService = require('../../src/services/auth/auth.service');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function database(existingProviderUser = null) {
  const victim = { id: 9001, email: 'victim@example.test', full_name: 'Victim' };
  const own = { id: 9002, email: null, full_name: 'Own user' };
  return {
    query: jest.fn(async (sql) => {
      if (/WHERE (zalo|google|apple)_id = \$1/.test(sql)) {
        return {
          rows: existingProviderUser ? [existingProviderUser] : [],
          rowCount: existingProviderUser ? 1 : 0,
        };
      }
      if (sql.includes('SELECT id, email, full_name, auth_token_version FROM users WHERE email')) {
        return { rows: [victim], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO users (')) return { rows: [own], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function appFor(pool) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(pool));
  return app;
}

function providerResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

function expectNoEmailLink(pool) {
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM users WHERE email'))).toBe(false);
  expect(pool.query.mock.calls.some(([sql]) => /UPDATE users SET (zalo|apple)_id/.test(sql))).toBe(
    false
  );
}

test('Zalo token plus another account email cannot issue a victim token', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue(providerResponse({ id: 'own-zalo-id', name: 'Own user' }));
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/zalo').send({
    token: 'synthetic-valid-token',
    email: 'victim@example.test',
    provider_id: 'victim-zalo-id',
  });
  expect(res.status).toBe(200);
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET).id).toBe(9002);
  expectNoEmailLink(pool);
  const insert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users ('));
  expect(insert[1].slice(0, 2)).toEqual(['own-zalo-id', null]);
});

test('existing Zalo login remains tied to its verified provider id without accepting a client email', async () => {
  global.fetch = jest.fn().mockResolvedValue(providerResponse({ id: 'own-zalo-id' }));
  const pool = database({ id: 9002, email: null, full_name: 'Own user' });
  const res = await request(appFor(pool)).post('/api/auth/zalo').send({
    token: 'synthetic-valid-token',
    email: 'victim@example.test',
  });
  expect(res.status).toBe(200);
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET).id).toBe(9002);
  expectNoEmailLink(pool);
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE users SET email'))).toBe(
    false
  );
});

test('Zalo service cannot auto-link an email even if a future caller supplies one', async () => {
  const pool = database();
  const result = await authService.loginByProvider(
    pool,
    'zalo_id',
    'own-zalo-id',
    'zalo',
    'victim@example.test',
    null,
    null
  );
  expect(result.ok).toBe(true);
  expect(jwt.verify(result.token, process.env.JWT_SECRET).id).toBe(9002);
  expectNoEmailLink(pool);
});

test('Zalo authorization-code flow ignores client email and provider id too', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(providerResponse({ access_token: 'synthetic-zalo-token' }))
    .mockResolvedValueOnce(providerResponse({ id: 'own-zalo-id' }));
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/zalo').send({
    code: 'synthetic-code',
    code_verifier: 'synthetic-verifier',
    email: 'victim@example.test',
    provider_id: 'victim-zalo-id',
  });
  expect(res.status).toBe(200);
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET).id).toBe(9002);
  expectNoEmailLink(pool);
});

test('invalid Zalo token cannot reach account lookup even with a supplied identity', async () => {
  global.fetch = jest.fn().mockResolvedValue(providerResponse({ error: -1 }));
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/zalo').send({
    token: 'invalid-provider-token',
    email: 'victim@example.test',
    provider_id: 'victim-zalo-id',
  });
  expect(res.status).toBe(401);
  expect(pool.query).not.toHaveBeenCalled();
});

test('Google continues linking the provider-returned email, never the different client email', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    providerResponse({
      id: 'own-google-id',
      email: 'verified@example.test',
      verified_email: true,
    })
  );
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/google').send({
    token: 'synthetic-google-token',
    email: 'other-client@example.test',
    provider_id: 'other-google-id',
  });
  expect(res.status).toBe(200);
  const lookup = pool.query.mock.calls.find(([sql]) =>
    sql.includes('SELECT id, email, full_name, auth_token_version FROM users WHERE email')
  );
  expect(lookup[1]).toEqual(['verified@example.test']);
  const link = pool.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users SET google_id'));
  expect(link[1]).toEqual(['own-google-id', 9001]);
});

test('Apple token without an email cannot fall back to a client-supplied victim email', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = jwt.sign({ sub: 'own-apple-id' }, privateKey, {
    algorithm: 'RS256',
    keyid: 'test-apple-key',
    issuer: 'https://appleid.apple.com',
    audience: process.env.APPLE_BUNDLE_ID || 'com.asinu.lite',
    expiresIn: '5m',
  });
  global.fetch = jest.fn().mockResolvedValue(
    providerResponse({
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-apple-key' }],
    })
  );
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/apple').send({
    token,
    email: 'victim@example.test',
    provider_id: 'victim-apple-id',
  });
  expect(res.status).toBe(200);
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET).id).toBe(9002);
  expectNoEmailLink(pool);
});

test('provider response without verified subject cannot use the client provider_id', async () => {
  global.fetch = jest.fn().mockResolvedValue(providerResponse({ email: 'verified@example.test' }));
  const pool = database();
  const res = await request(appFor(pool)).post('/api/auth/google').send({
    token: 'synthetic-token',
    provider_id: 'victim-google-id',
    email: 'victim@example.test',
  });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});
