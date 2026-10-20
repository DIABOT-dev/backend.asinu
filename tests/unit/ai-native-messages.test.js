jest.mock('../../src/services/ai/ai-consent.service', () => ({ assertAiConsent: jest.fn() }));
jest.mock('../../src/services/ai/providers/medgemma', () => ({
  isConfigured: jest.fn(() => true),
  callMedGemmaWithRetry: jest.fn(async () => ({
    reply: 'synthetic',
    meta: {
      model: 'medgemma-27b-it',
      tokens_used: { prompt: 100, completion: 10 },
      credits_remaining: '5',
    },
  })),
}));
const provider = require('../../src/services/ai/providers/medgemma');
const { callTextAi } = require('../../src/services/ai/ai.service');

beforeEach(() => jest.clearAllMocks());

test('passes native consultation roles and a per-request model through the shared adapter', async () => {
  const messages = [
    { role: 'user', content: 'Tôi khó ngủ.' },
    { role: 'assistant', content: 'Từ khi nào?' },
    { role: 'user', content: 'Hôm qua.' },
  ];
  const result = await callTextAi({
    provider: 'medgemma',
    system: 'Expert review only.',
    prompt: 'Legacy fallback',
    messages,
    preserveMessageRoles: true,
    model: 'medgemma-27b-it',
  });
  expect(provider.callMedGemmaWithRetry).toHaveBeenCalledWith(
    expect.objectContaining({ messages, model: 'medgemma-27b-it', system: 'Expert review only.' }),
    undefined
  );
  expect(result).toMatchObject({ credits_remaining: '5', usage: { prompt: 100, completion: 10 } });
});

test('preserves the established adapter behaviour for legacy message callers', async () => {
  await callTextAi({
    provider: 'medgemma',
    messages: [
      { role: 'system', content: 'Existing system' },
      { role: 'user', content: 'Existing text' },
    ],
  });
  const request = provider.callMedGemmaWithRetry.mock.calls[0][0];
  expect(request.system).toBe('Existing system');
  expect(request.prompt).toBe('User: Existing text');
  expect(request).not.toHaveProperty('messages');
});
