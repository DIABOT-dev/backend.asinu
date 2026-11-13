'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const logger = require('../../lib/logger');

const context = new AsyncLocalStorage();
const CHECKIN_AI_ATTEMPT_MS = 180_000;

function checkinAiWaitEnabled() {
  return Boolean(context.getStore());
}

function isAiTimeout(error) {
  return ['AbortError', 'TimeoutError', 'RequestTimeoutError'].includes(error?.name) ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.code) ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code) ||
    [408, 504, 522, 524].includes(error?.status);
}

// A slow provider is not an unclear patient answer. Keep the same AI task
// pending, while the HTTP caller polls the existing triage operation.
async function waitForCheckinAi(options, invoke) {
  const state = context.getStore();
  if (!state) return invoke(options);
  let attempt = 0;
  for (;;) {
    state.signal.throwIfAborted();
    await state.assertActive();
    try {
      const result = await invoke({ ...options, timeoutMs: CHECKIN_AI_ATTEMPT_MS, maxRetries: 0, signal: state.signal });
      state.signal.throwIfAborted();
      return result;
    } catch (error) {
      state.signal.throwIfAborted();
      if (!isAiTimeout(error)) throw error;
      logger.warn('checkin.ai_wait_retry', { attempt: ++attempt, model: options.model || 'default', timeoutMs: CHECKIN_AI_ATTEMPT_MS });
      await delay(Math.min(5000, attempt * 1000), undefined, { signal: state.signal });
    }
  }
}

async function withCheckinAiWait(work, assertActive) {
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    controller.signal.throwIfAborted();
    try {
      await assertActive();
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  // Stop retries and an in-flight provider request when this phase is cancelled
  // or replaced, including when the app is no longer polling it.
  const timer = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try { await check(); } catch { /* propagated through the scoped signal */ }
    finally { checking = false; }
  }, 10000);
  timer.unref?.();
  try {
    return await context.run({ signal: controller.signal, assertActive: check }, async () => {
      await check();
      const result = await work();
      await check();
      return result;
    });
  } finally {
    clearInterval(timer);
  }
}

module.exports = { CHECKIN_AI_ATTEMPT_MS, checkinAiWaitEnabled, isAiTimeout, waitForCheckinAi, withCheckinAiWait };
