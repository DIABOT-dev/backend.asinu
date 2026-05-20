const medgemma = require('../../src/services/ai/providers/medgemma');

describe('medgemma provider', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MEDGEMMA_ENDPOINT = 'https://example.test/predict';
    process.env.MEDGEMMA_API_KEY = 'test-key';
    process.env.MEDGEMMA_MODEL = 'medgemma-27b-text-it';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  test('isConfigured() reflects MEDGEMMA_ENDPOINT', () => {
    expect(medgemma.isConfigured()).toBe(true);
    delete process.env.MEDGEMMA_ENDPOINT;
    expect(medgemma.isConfigured()).toBe(false);
  });

  test('callMedGemma parses OpenAI-shaped response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'medgemma-27b-text-it',
        choices: [{ message: { content: '   hello world   ' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    const r = await medgemma.callMedGemma({ prompt: 'hi' });
    expect(r.reply).toBe('hello world');
    expect(r.provider).toBe('medgemma');
    expect(r.meta.tokens_used.total).toBe(15);
  });

  test('callMedGemma falls back to predictions[].content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ predictions: [{ content: 'from vertex' }] }),
    });
    const r = await medgemma.callMedGemma({ prompt: 'hi' });
    expect(r.reply).toBe('from vertex');
  });

  test('callMedGemma throws on empty reply', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    });
    await expect(medgemma.callMedGemma({ prompt: 'hi' })).rejects.toThrow(/empty/i);
  });

  test('callMedGemma throws on HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'upstream down',
    });
    await expect(medgemma.callMedGemma({ prompt: 'hi' })).rejects.toThrow(/502/);
  });

  test('getMedGemmaChatReply returns null when not configured', async () => {
    delete process.env.MEDGEMMA_ENDPOINT;
    const r = await medgemma.getMedGemmaChatReply({ message: 'hi' });
    expect(r).toBeNull();
  });
});
