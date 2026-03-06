const { getDiaBrainReply } = require('./ai/providers/diabrain');
const { getOpenAIReply, getOpenAIChatReply } = require('./ai/providers/openai');
const { t } = require('../i18n');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

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

async function getChatReply(message, context, conversationHistory = [], systemPrompt = null) {
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();
  const userId = context?.user_id ?? context?.userId ?? null;
  
  // DiaBrain provider
  if (provider === 'diabrain') {
    const sessionId = context?.session_id ?? context?.sessionId ?? null;
    return getDiaBrainReply({ message, userId, sessionId });
  }

  // OpenAI provider (default)
  if (provider === 'openai' || provider === '') {
    if (!process.env.OPENAI_CHAT_MODEL || !process.env.OPENAI_API_KEY) {

      return { reply: buildMockReply(message), provider: 'mock' };
    }
    try {
      const result = await getOpenAIChatReply({ 
        message, 
        userId,
        context: systemPrompt
      });
      return result;
    } catch (err) {

      return { reply: buildMockReply(message), provider: 'mock' };
    }
  }

  // Gemini provider
  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      return { reply: buildMockReply(message), provider: 'mock' };
    }
    try {
      const reply = await callGemini(message, context);
      if (reply) {
        return { reply, provider: 'gemini' };
      }
    } catch (err) {

    }
    return { reply: buildMockReply(message), provider: 'mock' };
  }

  // Fallback
  return { reply: buildMockReply(message), provider: 'mock' };
}

module.exports = { getChatReply };
