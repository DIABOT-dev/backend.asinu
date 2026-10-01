/** Chat and voice are free in Asinu V2; only the global kill switch remains. */

const { chatbotGate } = require('../../src/middleware/chatbot.gate.middleware');

function makeReqRes(userId = 1) {
  const req = { user: userId ? { id: userId } : null, headers: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return { req, res, next: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CHATBOT_ENABLED = 'true';
});

describe('chatbotGate', () => {
  test('blocks when the operational kill switch is off', async () => {
    process.env.CHATBOT_ENABLED = 'false';
    const { req, res, next } = makeReqRes();
    await chatbotGate({})(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHATBOT_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('requires an authenticated user', async () => {
    const { req, res, next } = makeReqRes(null);
    await chatbotGate({})(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows every authenticated account without subscription or quota checks', async () => {
    process.env.CHATBOT_PREMIUM_ONLY = 'true';
    process.env.CHATBOT_DAILY_LIMIT_FREE = '0';
    process.env.CHATBOT_MONTHLY_TOKEN_LIMIT_FREE = '0';
    const { req, res, next } = makeReqRes();
    await chatbotGate({})(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
