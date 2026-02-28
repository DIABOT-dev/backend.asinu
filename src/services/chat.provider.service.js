const { getDiaBrainReply } = require('./ai/providers/diabrain');
const { t } = require('../i18n');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const buildMockReply = (message) => {
  const trimmed = String(message || '').slice(0, 240).trim();
  const prefix = trimmed ? t('chat.mock_reply', 'vi', { message: trimmed }) : '';
  return `${prefix}${t('chat.mock_support')}`;
};

async function callGemini(message, context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(message) }]
      }
    ]
  };

  if (context?.lang) {
    payload.contents[0].parts.push({ text: `Language: ${context.lang}` });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Gemini error ${response.status}`);
  }

  const data = await response.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
  return reply || null;
}

async function getChatReply(message, context) {
  const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (provider === 'diabrain') {
    const userId = context?.user_id ?? context?.userId ?? null;
    const sessionId = context?.session_id ?? context?.sessionId ?? null;
    return getDiaBrainReply({ message, userId, sessionId });
  }

  if (!process.env.GEMINI_API_KEY) {
    return { reply: buildMockReply(message), provider: 'mock' };
  }

  try {
    const reply = await callGemini(message, context);
    if (reply) {
      return { reply, provider: 'gemini' };
    }
  } catch (err) {
    console.warn('Gemini call failed, fallback to mock:', err?.message || err);
  }

  return { reply: buildMockReply(message), provider: 'mock' };
}

module.exports = { getChatReply };
