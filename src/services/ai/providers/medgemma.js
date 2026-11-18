const { assertAiConsent } = require('../ai-consent.service');
const { getClinicalConfig, isClinicalConfigured } = require('./clinical-config');
/**
 * OpenAI-compatible clinical HTTP client. The legacy module/function names
 * remain for existing callers; clinical-config selects Dr7 or 9Router and
 * resolves the actual model. Consent, role validation and retries are shared.
 */

const logger = require('../../../lib/logger');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
function isContextLimit(detail) {
  const error = detail?.error;
  return ['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'].includes(error?.code)
    || typeof error?.message === 'string' && /maximum context length|context window.{0,55}(exceed|too (?:long|many))|too many input tokens|prompt is too long/iu.test(error.message);
}
function isConfigured(provider) {
  return isClinicalConfigured(provider);
}

async function callMedGemma({
  prompt,
  system,
  messages,
  provider,
  model: requestedModel,
  maxTokens = 800,
  temperature = 0.3,
  jsonMode = false,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  await assertAiConsent();
  if (!isConfigured(provider)) {
    throw new Error(
      getClinicalConfig({ provider }).provider === '9router'
        ? '9Router endpoint, API key and model must be configured'
        : 'MEDGEMMA_ENDPOINT is not set'
    );
  }

  // Resolve this at request time so a process manager/container can inject or
  // rotate the model setting before the next request without relying on the
  // module import order.
  const config = getClinicalConfig({ provider, model: requestedModel });
  const { endpoint, apiKey, model } = config;
  if (
    messages !== undefined &&
    (!Array.isArray(messages) ||
      !messages.length ||
      messages.some(
        (turn) =>
          !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string'
      ))
  )
    throw new Error('MedGemma conversation must contain user/assistant text messages');

  // Body shape mirrors the OpenAI Chat Completions schema since Vertex
  // AI accepts it and most self-hosted serving frameworks do too. Adapt
  // here if a specific endpoint needs a different layout.
  const body = JSON.stringify({
    model,
    stream: false,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...(messages || [{ role: 'user', content: String(prompt || '') }]),
    ],
    temperature,
    max_tokens: maxTokens,
    // Dr7 documents the standard chat-completions fields but does not require
    // OpenAI's response_format extension. The prompt still requests JSON and
    // the caller validates/parses it, while this opt-in keeps the default body
    // compatible with Dr7 and other OpenAI-compatible medical endpoints.
    ...(jsonMode && config.supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller passed their own signal, forward its abort.
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  let data;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) {
      // Keep provider failures machine-readable without logging its raw body,
      // which may echo clinical input. Credit/auth failures cannot be retried.
      const error = new Error(
        `${config.provider === '9router' ? '9Router' : 'MedGemma'} API ${response.status}`
      );
      error.status = response.status;
      const prefix = config.provider === '9router' ? 'NINEROUTER' : 'MEDGEMMA';
      // Classify a context rejection without exposing the provider payload.
      // Some providers include part of the user's prompt in error messages.
      const contextLimit = response.status === 413 || [400, 422].includes(response.status) && typeof response.json === 'function'
        && isContextLimit(await response.json().catch(() => null));
      error.code =
        contextLimit ? 'AI_CONTEXT_LIMIT'
          : response.status === 402 ? `${prefix}_INSUFFICIENT_CREDIT` : `${prefix}_HTTP_ERROR`;
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    data = await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
  const reply =
    data.choices?.[0]?.message?.content ?? data.predictions?.[0]?.content ?? data.text ?? '';

  if (!reply || !reply.trim()) {
    throw new Error('MedGemma returned empty response');
  }

  const usage = data.usage || {};
  return {
    reply: reply.trim(),
    provider: config.provider,
    meta: {
      model: data.model || model,
      finish_reason: data.choices?.[0]?.finish_reason || null,
      credits_remaining: response.headers?.get?.('x-dr7-credit-remaining') || null,
      tokens_used: {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      },
    },
  };
}

async function callMedGemmaWithRetry(opts, { maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.pow(2, attempt) * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      return await callMedGemma(opts);
    } catch (err) {
      lastErr = err;
      if (opts?.signal?.aborted) throw opts.signal.reason || err;
      logger.warn('medgemma.attempt_failed', { attempt, err });
      if (err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) throw err;
    }
  }
  throw lastErr;
}

/**
 * Drop-in shape that matches getOpenAIChatReply() so chat.provider.service
 * can swap providers without other callsites changing.
 */
async function getMedGemmaChatReply({ message, userId: _userId, context, history = [] }) {
  if (!isConfigured()) return null;

  // Same window-trim convention as the OpenAI path: caller already
  // truncates `history` to HISTORY_LIMIT_*; we just stringify it.
  const turns = history
    .map((t) => `${t.sender === 'user' ? 'User' : 'Assistant'}: ${t.message}`)
    .join('\n');
  const prompt = turns ? `${turns}\nUser: ${String(message || '')}` : String(message || '');

  return callMedGemmaWithRetry({ prompt, system: context });
}

module.exports = {
  isConfigured,
  callMedGemma,
  callMedGemmaWithRetry,
  getMedGemmaChatReply,
};
