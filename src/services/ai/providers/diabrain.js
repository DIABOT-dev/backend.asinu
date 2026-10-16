const { assertAiConsent } = require('../ai-consent.service');
const DEFAULT_TIMEOUT_MS = 5000;

const buildUrl = (baseUrl, path) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

const pickOptional = (value) => (value === undefined ? undefined : value);

async function getDiaBrainReply({ message, userId, sessionId }) {
  await assertAiConsent();
  const baseUrl = process.env.DIABRAIN_BASE_URL;
  const chatPath = process.env.DIABRAIN_CHAT_PATH;
  if (!baseUrl || !chatPath) {
    throw new Error('DIABRAIN_BASE_URL or DIABRAIN_CHAT_PATH is not set');
  }

  const payload = {
    msg: String(message || ''),
    user_id: userId !== null && userId !== undefined ? String(userId) : null,
    session_id: sessionId !== null && sessionId !== undefined ? String(sessionId) : null,
    model: null,
  };

  const headers = { 'Content-Type': 'application/json' };
  const authToken = process.env.DIABRAIN_BEARER_TOKEN;
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(buildUrl(baseUrl, chatPath), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dia Brain error ${response.status}: ${text || 'empty response'}`);
  }

  const data = await response.json();
  const reply = data?.reply;
  if (!reply) {
    throw new Error('Dia Brain response missing reply');
  }

  const meta = {
    version: pickOptional(data?.version),
    confidence: pickOptional(data?.confidence),
    tone: pickOptional(data?.tone),
  };

  const hasMeta = Object.values(meta).some((value) => value !== undefined && value !== null);

  return {
    reply,
    provider: 'diabrain',
    meta: hasMeta ? meta : undefined,
  };
}

module.exports = { getDiaBrainReply };
