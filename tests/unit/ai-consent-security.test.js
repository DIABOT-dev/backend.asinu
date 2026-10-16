const { withAiUser, assertAiConsent, mayProcessAi, AI_CONSENT_VERSION } = require('../../src/services/ai/ai-consent.service');
const controller = require('../../src/controllers/ai-consent.controller');
const { onboardingNext } = require('../../src/controllers/onboarding.controller');
const medgemma = require('../../src/services/ai/providers/medgemma');

const res = () => ({ set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const originalEnforcement = process.env.AI_CONSENT_ENFORCEMENT;
beforeEach(() => { process.env.AI_CONSENT_ENFORCEMENT = 'true'; });
afterAll(() => {
  if (originalEnforcement === undefined) delete process.env.AI_CONSENT_ENFORCEMENT;
  else process.env.AI_CONSENT_ENFORCEMENT = originalEnforcement;
});
test('rollout keeps legacy accounts working, but cannot bypass an explicit revocation', async () => {
  process.env.AI_CONSENT_ENFORCEMENT = 'false';
  expect(await mayProcessAi({ query: async () => ({ rows: [] }) }, 1)).toBe(true);
  const revoked = { query: jest.fn().mockResolvedValueOnce({ rows: [{ revoked_at: new Date() }] }).mockResolvedValueOnce({ rows: [] }) };
  expect(await mayProcessAi(revoked, 1)).toBe(false);
});
test('unscoped callers and users without a current receipt cannot send data', async () => {
  await expect(assertAiConsent()).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  await expect(withAiUser({ query: async () => ({ rows: [] }) }, 1, assertAiConsent))
    .rejects.toMatchObject({ statusCode: 403 });
});
test('parallel user contexts and revocation are enforced per provider call', async () => {
  let granted = true;
  const pool = { query: jest.fn(async (_sql, params) => ({ rows: params[0] === 1 && granted ? [1] : [] })) };
  const results = await Promise.allSettled([withAiUser(pool, 1, assertAiConsent), withAiUser(pool, 2, assertAiConsent)]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  granted = false;
  await expect(withAiUser(pool, 1, assertAiConsent)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(pool.query.mock.calls[0][1][1]).toBe(AI_CONSENT_VERSION);
});
test('receipt identity comes from the session, not a user id or providers from the body', async () => {
  const pool = { query: jest.fn(async () => ({ rows: [1] })) };
  await controller.grantAiConsent(pool, { user: { id: 1 }, body: { version: AI_CONSENT_VERSION, granted: true, user_id: 2, providers: ['attacker'] } }, res());
  expect(pool.query.mock.calls[0][1][0]).toBe(1);
  expect(pool.query.mock.calls[0][1][2]).not.toContain('attacker');
});
test('old device grants cannot authorize a provider, and database failure fails closed', async () => {
  const fetch = global.fetch;
  global.fetch = jest.fn();
  try {
    await expect(medgemma.callMedGemma({ prompt: 'private synthetic fixture' })).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    await expect(withAiUser({ query: async () => { throw new Error('db offline'); } }, 1,
      () => medgemma.callMedGemma({ prompt: 'private synthetic fixture' }))).rejects.toThrow('db offline');
    expect(global.fetch).not.toHaveBeenCalled();
  } finally { global.fetch = fetch; }
});
test('legacy onboarding rejects arbitrary system roles and oversized histories before calling a provider', async () => {
  const response = res();
  await onboardingNext({}, { user: { id: 1 }, body: { messages: [{ role: 'system', content: 'x'.repeat(20000) }] } }, response);
  expect(response.status).toHaveBeenCalledWith(400);
});
