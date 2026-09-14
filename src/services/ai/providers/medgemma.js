/**
 * MedGemma provider.
 *
 * Per the MVP audit, clinical reasoning (check-in triage, symptom
 * analysis, alert filtering, script generation) should run on Google's
 * MedGemma rather than a general chat model. This file is the thin HTTP
 * client; routing (which call goes to which provider) lives in
 * chat.provider.service.
 *
 * Deployment options the env supports:
 *   1. Vertex AI                     — set MEDGEMMA_ENDPOINT to the
 *                                       prediction URL + a service-account
 *                                       bearer in MEDGEMMA_API_KEY
 *   2. Self-hosted (HF/Replicate/own) — same shape, just a different URL
 *
 * Everything is no-op if MEDGEMMA_ENDPOINT is not set — the chat provider
 * will fall back to the script/rule path so the app stays usable while
 * we wire production access.
 */

const logger = require('../../../lib/logger');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
// Dr7's medical chat endpoint documents this model id. Keep it as the safe
// default while allowing production to select another MedGemma variant.
const DEFAULT_MODEL = 'medgemma-4b-it';

function isConfigured() {
  return Boolean(process.env.MEDGEMMA_ENDPOINT);
}

async function callMedGemma({
  prompt,
  system,
  maxTokens = 800,
  temperature = 0.3,
  jsonMode = false,
  signal,
} = {}) {
  if (!isConfigured()) {
    throw new Error('MEDGEMMA_ENDPOINT is not set');
  }

  const endpoint = process.env.MEDGEMMA_ENDPOINT;
  const apiKey = process.env.MEDGEMMA_API_KEY || '';
  // Resolve this at request time so a process manager/container can inject or
  // rotate the model setting before the next request without relying on the
  // module import order.
  const model = process.env.MEDGEMMA_MODEL || DEFAULT_MODEL;

  // Body shape mirrors the OpenAI Chat Completions schema since Vertex
  // AI accepts it and most self-hosted serving frameworks do too. Adapt
  // here if a specific endpoint needs a different layout.
  const body = JSON.stringify({
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: String(prompt || '') },
    ],
    temperature,
    max_tokens: maxTokens,
    // Dr7 documents the standard chat-completions fields but does not require
    // OpenAI's response_format extension. The prompt still requests JSON and
    // the caller validates/parses it, while this opt-in keeps the default body
    // compatible with Dr7 and other OpenAI-compatible medical endpoints.
    ...(jsonMode && process.env.MEDGEMMA_SUPPORTS_JSON_MODE === 'true'
      ? { response_format: { type: 'json_object' } }
      : {}),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  // If the caller passed their own signal, forward its abort.
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`MedGemma API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const reply =
    data.choices?.[0]?.message?.content ?? data.predictions?.[0]?.content ?? data.text ?? '';

  if (!reply || !reply.trim()) {
    throw new Error('MedGemma returned empty response');
  }

  const usage = data.usage || {};
  return {
    reply: reply.trim(),
    provider: 'medgemma',
    meta: {
      model: data.model || model,
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
      logger.warn('medgemma.attempt_failed', { attempt, err });
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
