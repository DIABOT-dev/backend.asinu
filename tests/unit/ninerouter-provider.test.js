'use strict';

const {
  getClinicalConfig,
  isClinicalConfigured,
} = require('../../src/services/ai/providers/clinical-config');
const { callTextAi } = require('../../src/services/ai/ai.service');
const { withPublicAiTemplate } = require('../../src/services/ai/ai-consent.service');
const client = require('../../src/services/ai/providers/medgemma');

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
beforeEach(() => {
  process.env.AI_PROVIDER_CLINICAL = '9router';
  process.env.NINEROUTER_ENDPOINT = 'https://router.example.test/v1/chat/completions';
  process.env.NINEROUTER_API_KEY = 'router-test-key';
  process.env.NINEROUTER_MODEL = 'ag/gemini-3.8-flash-low';
  // Leftover Dr7 secrets must never cause a fallback during migration.
  process.env.MEDGEMMA_ENDPOINT = 'https://dr7.ai/api/v1/medical/chat/completions';
  process.env.MEDGEMMA_API_KEY = 'old-dr7-test-key';
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      model: 'gemini-3.8-flash',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

test.each(['medgemma-4b-it', 'medgemma-27b-it', 'med-gemini', undefined])(
  'legacy model %s uses the configured router model and key',
  async (model) => {
    const result = await withPublicAiTemplate(() =>
      callTextAi({
        provider: 'medgemma',
        model,
        prompt: 'Synthetic integration probe.',
        maxRetries: 0,
      })
    );
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(process.env.NINEROUTER_ENDPOINT);
    expect(options.headers.Authorization).toBe('Bearer router-test-key');
    expect(JSON.parse(options.body).model).toBe(process.env.NINEROUTER_MODEL);
    expect(JSON.parse(options.body).stream).toBe(false);
    expect(result).toMatchObject({
      provider: '9router',
      model: 'gemini-3.8-flash',
      usage: { total: 15 },
    });
  }
);

test('explicit router selection preserves conversation roles and per-feature model overrides', async () => {
  const messages = [
    { role: 'user', content: 'Synthetic question.' },
    { role: 'assistant', content: 'Synthetic answer.' },
  ];
  await withPublicAiTemplate(() =>
    callTextAi({
      provider: '9router',
      model: 'ag/claude-sonnet-5-5',
      messages,
      system: 'Synthetic instructions.',
      preserveMessageRoles: true,
      maxRetries: 0,
    })
  );
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
    model: 'ag/claude-sonnet-5-5',
    messages: [{ role: 'system', content: 'Synthetic instructions.' }, ...messages],
  });
});

test.each(['NINEROUTER_ENDPOINT', 'NINEROUTER_API_KEY', 'NINEROUTER_MODEL'])(
  'missing %s fails closed even with Dr7 credentials available',
  async (key) => {
    delete process.env[key];
    expect(isClinicalConfigured('9router')).toBe(false);
    await expect(
      withPublicAiTemplate(() => callTextAi({ provider: '9router', prompt: 'Probe.' }))
    ).rejects.toThrow('9Router');
    await expect(
      withPublicAiTemplate(() => callTextAi({ provider: 'medgemma', prompt: 'Probe.' }))
    ).rejects.toThrow('9Router');
    expect(global.fetch).not.toHaveBeenCalled();
  }
);

test('scanning uses the configured vision model instead of the old med-gemini default', () => {
  process.env.NINEROUTER_VISION_MODEL = 'ag/gemini-4-carbon-low';
  expect(getClinicalConfig({ model: 'med-gemini', vision: true })).toMatchObject({
    provider: '9router',
    model: 'ag/gemini-4-carbon-low',
    apiKey: 'router-test-key',
  });
  expect(getClinicalConfig({ model: 'ag/claude-sonnet-5-5', vision: true }).model).toBe(
    'ag/claude-sonnet-5-5'
  );
});

test('router authentication errors are not retried or sent to a different provider', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 401 });
  await expect(
    withPublicAiTemplate(() => client.callMedGemmaWithRetry({ prompt: 'Probe.' }))
  ).rejects.toMatchObject({ code: 'NINEROUTER_HTTP_ERROR', status: 401 });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
