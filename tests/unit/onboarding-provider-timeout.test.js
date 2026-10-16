const { getNextQuestion } = require('../../src/services/onboarding/onboarding.ai.service');

test.each(['openai', 'gemini'])('%s timeout includes a stalled response body and releases its timer', async provider => {
  const keys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_PROVIDER', 'AI_CONSENT_ENFORCEMENT'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oldFetch = global.fetch;
  delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;
  process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'] = 'synthetic-provider-fixture';
  process.env.AI_PROVIDER = provider;
  process.env.AI_CONSENT_ENFORCEMENT = 'false';
  jest.useFakeTimers();
  global.fetch = jest.fn(async (_url, options) => ({ ok: true,
    json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('fixture aborted')))),
  }));
  try {
    const rejected = expect(getNextQuestion([], 'vi')).rejects.toThrow('AI provider unavailable');
    await jest.advanceTimersByTimeAsync(20001);
    await rejected;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    global.fetch = oldFetch; jest.useRealTimers();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});
