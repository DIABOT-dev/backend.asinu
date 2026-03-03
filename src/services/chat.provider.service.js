const { getDiaBrainReply } = require('./ai/providers/diabrain');
const { getOpenAIChatReply } = require('./ai/providers/openai');
const { t } = require('../i18n');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const buildMockReply = (message) => {
  const trimmed = String(message || '').slice(0, 240).trim();
  const prefix = trimmed ? t('chat.mock_reply', 'vi', { message: trimmed }) : '';
  return `${prefix}${t('chat.mock_support')}`;
};

const GEMINI_MAX_RETRIES = 3;

/**
 * Call Gemini API with system prompt and conversation history.
 * Retries with exponential backoff on 429 rate-limit errors.
 * @param {string} message - Current user message
 * @param {Object} context - Request context
 * @param {Array<{message: string, sender: string}>} history - Recent conversation turns
 * @param {string|null} systemPrompt - System instruction for the AI
 */
async function callGemini(message, context, history = [], systemPrompt = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Build conversation history in Gemini format (user/model alternating)
  const contents = [];
  for (const msg of history) {
    contents.push({
      role: msg.sender === 'user' ? 'user' : 'model',
      parts: [{ text: msg.message }]
    });
  }
  // Append current user message
  contents.push({
    role: 'user',
    parts: [{ text: String(message) }]
  });

  const payload = { contents };

  // Gemini systemInstruction — AI gets full profile context and conversation guidelines
  if (systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.warn(`[chat] Gemini rate limited — waiting ${backoffMs}ms before retry ${attempt}/${GEMINI_MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (response.status === 429) {
      if (attempt < GEMINI_MAX_RETRIES) continue; // wait and retry
      const text = await response.text();
      throw new Error(text || 'Gemini rate limit exceeded');
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Gemini error ${response.status}`);
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
    return reply || null;
  }

  return null;
}

/**
 * Get AI reply from the configured provider.
 * @param {string} message - Current user message
 * @param {Object} context - Request context
 * @param {Array} history - Conversation history (for Gemini)
 * @param {string|null} systemPrompt - System prompt (for Gemini)
 */
async function getChatReply(message, context, history = [], systemPrompt = null) {
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();

  if (provider === 'diabrain') {
    const userId = context?.user_id ?? context?.userId ?? null;
    const sessionId = context?.session_id ?? context?.sessionId ?? null;
    return getDiaBrainReply({ message, userId, sessionId });
  }

  if (provider === 'openai' || provider === '') {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('[chat] OPENAI_API_KEY not set, falling back to mock');
      return { reply: buildMockReply(message), provider: 'mock' };
    }
    try {
      const userId = context?.user_id ?? context?.userId ?? null;
      const result = await getOpenAIChatReply({ message, userId, context: systemPrompt, history });
      if (result) return result;
    } catch (err) {
      console.warn('OpenAI call failed, fallback to mock:', err?.message || err);
    }
    return { reply: buildMockReply(message), provider: 'mock' };
  }

  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      return { reply: buildMockReply(message), provider: 'mock' };
    }
    try {
      const reply = await callGemini(message, context, history, systemPrompt);
      if (reply) {
        return { reply, provider: 'gemini' };
      }
    } catch (err) {
      console.warn('Gemini call failed, fallback to mock:', err?.message || err);
    }
    return { reply: buildMockReply(message), provider: 'mock' };
  }

  return { reply: buildMockReply(message), provider: 'mock' };
}

module.exports = { getChatReply };
