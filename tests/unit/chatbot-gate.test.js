/**
 * Behavior tests for the chatbot feature gate. We mock the usage service
 * and subscription lookup so the middleware can be exercised without DB.
 */

jest.mock('../../src/services/chat/chatbot-usage.service', () => ({
  getDailyMessageCount: jest.fn(),
  getMonthlyTokenCount: jest.fn(),
}));
jest.mock('../../src/services/payment/subscription.service', () => ({
  isPremium: jest.fn(),
}));

const { chatbotGate } = require('../../src/middleware/chatbot.gate.middleware');
const usage = require('../../src/services/chat/chatbot-usage.service');
const sub = require('../../src/services/payment/subscription.service');

function makeReqRes(userId = 1) {
  const req = { user: { id: userId }, headers: {} };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

const POOL = {};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: everything permissive
  process.env.CHATBOT_ENABLED = 'true';
  process.env.CHATBOT_PREMIUM_ONLY = 'false';
  process.env.CHATBOT_DAILY_LIMIT_FREE = '5';
  process.env.CHATBOT_DAILY_LIMIT_PREMIUM = '20';
  process.env.CHATBOT_MONTHLY_TOKEN_LIMIT_FREE = '1000';
  process.env.CHATBOT_MONTHLY_TOKEN_LIMIT_PREMIUM = '200000';
  sub.isPremium.mockResolvedValue(false);
  usage.getDailyMessageCount.mockResolvedValue(0);
  usage.getMonthlyTokenCount.mockResolvedValue(0);
});

describe('chatbotGate', () => {
  test('blocks when CHATBOT_ENABLED=false', async () => {
    process.env.CHATBOT_ENABLED = 'false';
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHATBOT_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('blocks non-premium when PREMIUM_ONLY=true', async () => {
    process.env.CHATBOT_PREMIUM_ONLY = 'true';
    sub.isPremium.mockResolvedValue(false);
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUBSCRIPTION_REQUIRED' }));
  });

  test('blocks when daily limit reached', async () => {
    sub.isPremium.mockResolvedValue(false);
    usage.getDailyMessageCount.mockResolvedValue(5);
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHATBOT_DAILY_LIMIT_EXCEEDED' }));
  });

  test('blocks when daily limit is zero (free tier off)', async () => {
    process.env.CHATBOT_DAILY_LIMIT_FREE = '0';
    sub.isPremium.mockResolvedValue(false);
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHATBOT_DAILY_LIMIT_EXCEEDED' }));
  });

  test('blocks when monthly token limit reached', async () => {
    usage.getMonthlyTokenCount.mockResolvedValue(1500);
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHATBOT_TOKEN_LIMIT_EXCEEDED' }));
  });

  test('passes through when below all limits', async () => {
    sub.isPremium.mockResolvedValue(true);
    usage.getDailyMessageCount.mockResolvedValue(2);
    usage.getMonthlyTokenCount.mockResolvedValue(100);
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.chatbotDailyUsage).toEqual({ used: 2, limit: 20 });
    expect(req.chatbotMonthlyUsage).toEqual({ used: 100, limit: 200000 });
  });

  test('treats subscription lookup error as not-premium', async () => {
    process.env.CHATBOT_PREMIUM_ONLY = 'true';
    sub.isPremium.mockRejectedValue(new Error('db down'));
    const { req, res, next } = makeReqRes();
    await chatbotGate(POOL)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUBSCRIPTION_REQUIRED' }));
  });
});
