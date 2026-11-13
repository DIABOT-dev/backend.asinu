'use strict';

jest.mock('../../src/services/ai/ai-consent.service', () => ({ assertAiConsent: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/ai/providers/medgemma', () => ({ isConfigured: () => true, callMedGemmaWithRetry: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ warn: jest.fn() }));
// Keep the production abortable retry delay, with a fake clock in this suite.
jest.mock('node:timers/promises', () => ({
  setTimeout: (ms, value, { signal }) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(value); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  }),
}));

const { callTextAi } = require('../../src/services/ai/ai.service');
const provider = require('../../src/services/ai/providers/medgemma');
const { checkinAiWaitEnabled, withCheckinAiWait } = require('../../src/services/ai/checkin-wait-policy.service');
const reply = { reply: 'Synthetic valid result', meta: { model: 'test-model' } };
const params = { provider: 'medgemma', strictProvider: true, model: 'test-model', prompt: 'synthetic', timeoutMs: 5000, maxRetries: 0 };

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

test('non-check-in callers retain their own timeout and do not inherit waiting', async () => {
  provider.callMedGemmaWithRetry.mockResolvedValueOnce(reply);
  await callTextAi(params);
  expect(provider.callMedGemmaWithRetry.mock.calls[0][0].timeoutMs).toBe(5000);
  expect(checkinAiWaitEnabled()).toBe(false);
});

test('a slow result beyond the former 5s deadline waits up to three minutes without aborting', async () => {
  let release;
  provider.callMedGemmaWithRetry.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = withCheckinAiWait(() => callTextAi(params), async () => {});
  await jest.advanceTimersByTimeAsync(90000);
  const [options, retry] = provider.callMedGemmaWithRetry.mock.calls[0];
  expect(options.timeoutMs).toBe(180000);
  expect(retry).toEqual({ maxRetries: 0 });
  expect(options.signal.aborted).toBe(false);
  release(reply);
  await expect(pending).resolves.toMatchObject({ content: reply.reply });
});

test.each([
  Object.assign(new Error('synthetic timeout'), { name: 'AbortError' }),
  Object.assign(new Error('synthetic upstream timeout'), { status: 504 }),
  Object.assign(new Error('synthetic edge timeout'), { status: 524 }),
  Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }),
])('a provider timeout retries the SAME task and never returns a fallback', async error => {
  provider.callMedGemmaWithRetry.mockRejectedValueOnce(error).mockResolvedValueOnce(reply);
  const pending = withCheckinAiWait(() => callTextAi(params), async () => {});
  await jest.advanceTimersByTimeAsync(1001);
  await expect(pending).resolves.toMatchObject({ content: reply.reply });
  expect(provider.callMedGemmaWithRetry).toHaveBeenCalledTimes(2);
  expect(provider.callMedGemmaWithRetry.mock.calls[0]).toEqual(provider.callMedGemmaWithRetry.mock.calls[1]);
});

test('credit/authentication errors are not retried forever', async () => {
  const error = Object.assign(new Error('synthetic billing error'), { status: 402 });
  provider.callMedGemmaWithRetry.mockRejectedValueOnce(error);
  await expect(withCheckinAiWait(() => callTextAi(params), async () => {})).rejects.toBe(error);
  expect(provider.callMedGemmaWithRetry).toHaveBeenCalledTimes(1);
});

test('parallel patient tasks do not share their cancellation or wait context', async () => {
  const releases = new Map();
  provider.callMedGemmaWithRetry.mockImplementation(options => new Promise((resolve, reject) => {
    releases.set(options.prompt, () => resolve(reply));
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  let active = true;
  const changed = Object.assign(new Error('synthetic phase changed'), { code: 'TRIAGE_CHANGED' });
  const first = withCheckinAiWait(() => callTextAi({ ...params, prompt: 'fake patient one' }), async () => { if (!active) throw changed; });
  const checked = expect(first).rejects.toBe(changed);
  const second = withCheckinAiWait(() => callTextAi({ ...params, prompt: 'fake patient two' }), async () => {});
  await jest.advanceTimersByTimeAsync(1);
  active = false;
  await jest.advanceTimersByTimeAsync(10000);
  await checked;
  releases.get('fake patient two')();
  await expect(second).resolves.toMatchObject({ content: reply.reply });
  expect(provider.callMedGemmaWithRetry.mock.calls[1][0].signal.aborted).toBe(false);
});

test('phase cancellation aborts the provider and cannot be swallowed into an accepted fallback', async () => {
  let active = true;
  const changed = Object.assign(new Error('synthetic phase changed'), { code: 'TRIAGE_CHANGED' });
  provider.callMedGemmaWithRetry.mockImplementationOnce(options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const pending = withCheckinAiWait(async () => {
    try { return await callTextAi(params); } catch { return { source: 'fallback' }; }
  }, async () => { if (!active) throw changed; });
  const checked = expect(pending).rejects.toBe(changed);
  await jest.advanceTimersByTimeAsync(1);
  active = false;
  await jest.advanceTimersByTimeAsync(10000);
  await checked;
  expect(provider.callMedGemmaWithRetry).toHaveBeenCalledTimes(1);
});
