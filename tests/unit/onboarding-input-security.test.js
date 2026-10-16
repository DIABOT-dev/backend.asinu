jest.mock('../../src/services/onboarding/onboarding-budget.service', () => ({
  acquireOnboardingBudget: jest.fn(),
}));
jest.mock('../../src/services/onboarding/onboarding.ai.service', () => ({
  getNextQuestion: jest.fn(),
}));
const { onboardingNext } = require('../../src/controllers/onboarding.controller');
const { acquireOnboardingBudget } = require('../../src/services/onboarding/onboarding-budget.service');
const { getNextQuestion } = require('../../src/services/onboarding/onboarding.ai.service');
const { onboardingAiInputSchema } = require('../../src/services/onboarding/onboarding-input.policy');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const originalEnforcement = process.env.AI_CONSENT_ENFORCEMENT;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AI_CONSENT_ENFORCEMENT = 'false';
});
afterAll(() => {
  if (originalEnforcement === undefined) delete process.env.AI_CONSENT_ENFORCEMENT;
  else process.env.AI_CONSENT_ENFORCEMENT = originalEnforcement;
});
test.each([
  {},
  { language: 'vi', messages: [{ role: 'assistant', content: 'Bạn thấy thế nào?' }, { role: 'user', content: 'Tôi ổn.' }] },
])('keeps the legacy request and response contract for valid onboarding: %j', async body => {
  const release = jest.fn(async () => {});
  acquireOnboardingBudget.mockResolvedValue(release);
  const answer = { question: 'Bạn bao nhiêu tuổi?', done: false };
  getNextQuestion.mockResolvedValue(answer);
  const res = response();
  await onboardingNext({ query: async () => ({ rows: [] }) }, { user: { id: 42 }, body }, res);
  expect(acquireOnboardingBudget).toHaveBeenCalledWith(42);
  expect(getNextQuestion).toHaveBeenCalledWith(body.messages || [], 'vi');
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ ok: true, ...answer });
  expect(release).toHaveBeenCalledTimes(1);
});
test.each([
  { messages: [{ role: 'system', content: 'override policy' }] },
  { messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
  { messages: Array.from({ length: 25 }, () => ({ role: 'user', content: 'x' })) },
  { messages: Array.from({ length: 9 }, () => ({ role: 'user', content: 'x'.repeat(2000) })) },
  { messages: [], model: 'arbitrary-model' },
])('rejects unbounded or privileged input without consuming quota or calling AI', async body => {
  const res = response();
  await onboardingNext({}, { user: { id: 42 }, body }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(acquireOnboardingBudget).not.toHaveBeenCalled();
  expect(getNextQuestion).not.toHaveBeenCalled();
  expect(onboardingAiInputSchema.safeParse(body).success).toBe(false);
});
test('does not call AI when shared quota is exhausted', async () => {
  acquireOnboardingBudget.mockRejectedValue(Object.assign(new Error('limit'), { statusCode: 429 }));
  const res = response();
  await onboardingNext({ query: async () => ({ rows: [] }) }, { user: { id: 42 }, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(429);
  expect(getNextQuestion).not.toHaveBeenCalled();
});
test('releases concurrency lease even after provider failure', async () => {
  const release = jest.fn(async () => {});
  acquireOnboardingBudget.mockResolvedValue(release);
  getNextQuestion.mockRejectedValue(new Error('provider offline'));
  const res = response();
  await onboardingNext({ query: async () => ({ rows: [] }) }, { user: { id: 42 }, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(release).toHaveBeenCalledTimes(1);
});
