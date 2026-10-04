'use strict';

const crypto = require('crypto');
const provider = require('../../src/services/auth/oauth-provider.service');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test('Zalo code flow exchanges a code then loads the provider profile', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({ json: async () => ({ access_token: 'zalo-token' }) })
    .mockResolvedValueOnce({ json: async () => ({ id: 'zalo-42', phone: '0338617203' }) });

  const result = await provider.fetchZaloProfile('auth-code', { codeVerifier: 'verifier' });
  expect(result.profile.id).toBe('zalo-42');
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[0][1].body).toContain('code_verifier=verifier');
});

test('Google callback preserves token-exchange failure without requesting a profile', async () => {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => ({}) });
  await expect(
    provider.fetchGoogleProfile('bad-code', 'https://example.test/callback')
  ).resolves.toEqual({ error: 'token_exchange_failed' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('Facebook limited-login rejects malformed tokens before a network call', async () => {
  const oldAppId = process.env.FACEBOOK_APP_ID;
  process.env.FACEBOOK_APP_ID = 'test-app';
  global.fetch = jest.fn();
  try {
    await expect(provider.verifyFacebookNativeToken({ idToken: 'bad-token' })).resolves.toEqual({
      error: 'INVALID_TOKEN',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    if (oldAppId === undefined) delete process.env.FACEBOOK_APP_ID;
    else process.env.FACEBOOK_APP_ID = oldAppId;
  }
});

test('Facebook limited-login verifies a signed provider JWT', async () => {
  const oldAppId = process.env.FACEBOOK_APP_ID;
  process.env.FACEBOOK_APP_ID = 'test-app';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: 'test-app',
      iss: 'https://limited.facebook.com',
      sub: 'facebook-user-7',
      email: 'person@example.test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  const signature = crypto
    .sign('SHA256', Buffer.from(`${header}.${payload}`), privateKey)
    .toString('base64url');
  const token = `${header}.${payload}.${signature}`;
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1' }] }),
  });
  try {
    await expect(provider.verifyFacebookNativeToken({ idToken: token })).resolves.toEqual({
      userId: 'facebook-user-7',
      email: 'person@example.test',
      limited: true,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  } finally {
    if (oldAppId === undefined) delete process.env.FACEBOOK_APP_ID;
    else process.env.FACEBOOK_APP_ID = oldAppId;
  }
});

test('Facebook standard-login refuses missing server credentials before a network call', async () => {
  const oldAppId = process.env.FACEBOOK_APP_ID;
  const oldSecret = process.env.FACEBOOK_APP_SECRET;
  process.env.FACEBOOK_APP_ID = 'test-app';
  delete process.env.FACEBOOK_APP_SECRET;
  global.fetch = jest.fn();
  try {
    await expect(
      provider.verifyFacebookNativeToken({ accessToken: 'opaque-token' })
    ).resolves.toEqual({ error: 'NOT_CONFIGURED' });
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    if (oldAppId === undefined) delete process.env.FACEBOOK_APP_ID;
    else process.env.FACEBOOK_APP_ID = oldAppId;
    if (oldSecret === undefined) delete process.env.FACEBOOK_APP_SECRET;
    else process.env.FACEBOOK_APP_SECRET = oldSecret;
  }
});
