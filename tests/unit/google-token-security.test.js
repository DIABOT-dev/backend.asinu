const crypto = require('crypto');
process.env.JWT_SECRET = 'synthetic-google-test-session-secret';
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { verifySocialToken } = require('../../src/services/auth/auth.service');
const { SHIPPED_MOBILE_CLIENT_IDS } = require('../../src/services/auth/google-clients.policy');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const originalFetch = global.fetch;
const audience = 'asinu-security-test.apps.googleusercontent.com';
let certs;

beforeEach(() => {
  process.env.GOOGLE_WEB_CLIENT_ID = audience;
  certs = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
    certs: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) }, format: 'PEM',
  });
  global.fetch = jest.fn();
});
afterEach(() => { certs.mockRestore(); global.fetch = originalFetch; });
const idToken = (claims = {}, key = privateKey) => jwt.sign({
  sub: 'subject-1', email: 'owner@example.test', email_verified: true,
  iss: 'https://accounts.google.com', aud: audience, ...claims,
}, key, { algorithm: 'RS256', keyid: 'fixture', expiresIn: '5m' });
const response = data => ({ ok: true, status: 200, json: async () => data });

test('verifies an ID token signature, issuer, audience and verified email locally', async () => {
  const result = await verifySocialToken('google', idToken());
  expect(result).toMatchObject({ valid: true, profile: { sub: 'subject-1', email: 'owner@example.test' } });
  expect(global.fetch).not.toHaveBeenCalled();
});
test.each([
  { aud: 'another-app' }, { iss: 'https://attacker.example.test' },
  { azp: 'another-app' }, { exp: 1 },
])('rejects incorrect identity token claims %j', async claims => {
  const { exp, ...rest } = claims;
  const token = exp ? jwt.sign({ iss: 'https://accounts.google.com', aud: audience, sub: 'subject-1', iat: 1, exp }, privateKey,
    { algorithm: 'RS256', keyid: 'fixture' }) : idToken(rest);
  expect((await verifySocialToken('google', token)).valid).toBe(false);
});
test('rejects a token signed by a different key', async () => {
  const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  expect((await verifySocialToken('google', idToken({}, wrong))).valid).toBe(false);
});
test('unverified provider email cannot be used to merge an account', async () => {
  expect((await verifySocialToken('google', idToken({ email_verified: false }))).profile.email).toBeNull();
});
test('previously shipped Asinu mobile clients remain valid during OAuth configuration rotation', async () => {
  for (const client of SHIPPED_MOBILE_CLIENT_IDS) {
    expect((await verifySocialToken('google', idToken({ aud: client }))).valid).toBe(true);
  }
});
test('legacy access tokens require our audience, expiry and matching provider subject', async () => {
  global.fetch.mockResolvedValueOnce(response({ aud: 'another-app', expires_in: 3600 }));
  expect((await verifySocialToken('google', 'access-token-fixture')).valid).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  global.fetch.mockReset().mockResolvedValueOnce(response({ aud: audience, expires_in: 3600, sub: 'subject-1' }))
    .mockResolvedValueOnce(response({ id: 'subject-1', email: 'unverified@example.test', verified_email: false }));
  expect(await verifySocialToken('google', 'access-token-fixture')).toMatchObject({ valid: true, profile: { email: null } });
  expect(global.fetch.mock.calls[0][0]).not.toContain('access-token-fixture');
});
