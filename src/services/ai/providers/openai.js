/**
 * OpenAI Provider
 * Sử dụng OpenAI Chat Completions API để sinh câu hỏi thông minh
 */

const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const OPENAI_MAX_RETRIES = 3;
const DEFAULT_MODEL = 'gpt-4o-mini'; // Cost-effective model
const DEFAULT_TEMPERATURE = 0.7; // Balanced creativity
const { t } = require('../../../i18n');

/**
 * Get OpenAI chat completion for question generation
 * @param {Object} params - { message, userId, sessionId, model, temperature }
 * @returns {Promise<Object>} - { reply, provider, meta }
 */
async function getOpenAIReply({ message, userId, sessionId, model, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  const selectedModel = model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const selectedTemp = temperature !== undefined ? temperature : 
    (process.env.OPENAI_TEMPERATURE ? parseFloat(process.env.OPENAI_TEMPERATURE) : DEFAULT_TEMPERATURE);

  const payload = {
    model: selectedModel,
    messages: [
      {
        role: 'system',
        content: t('prompt.system_question')
      },
      {
        role: 'user',
        content: String(message || '')
      }
    ],
    temperature: selectedTemp,
    max_completion_tokens: 150, // Câu hỏi ngắn gọn
    top_p: 1,
    frequency_penalty: 0.3, // Tránh lặp từ
    presence_penalty: 0.3
  };

  // Optional: Add user identifier for better tracking
  if (userId) {
    payload.user = `user_${userId}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `OpenAI API error ${response.status}`;
    
    try {
      const errorData = JSON.parse(errorText);
      errorMessage = errorData.error?.message || errorMessage;
    } catch (e) {
      errorMessage = errorText || errorMessage;
    }
    
    throw new Error(errorMessage);
  }

  const data = await response.json();
  
  // Validate response structure
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Invalid OpenAI response structure');
  }

  const reply = data.choices[0].message.content;
  
  if (!reply || reply.trim().length === 0) {
    throw new Error('OpenAI returned empty response');
  }

  // Extract metadata
  const meta = {
    model: data.model,
    finish_reason: data.choices[0].finish_reason,
    tokens_used: data.usage ? {
      prompt: data.usage.prompt_tokens,
      completion: data.usage.completion_tokens,
      total: data.usage.total_tokens
    } : undefined
  };

  return {
    reply: reply.trim(),
    provider: 'openai',
    meta
  };
}

/**
 * Get chat reply for general conversation.
 * Sends full conversation history so the AI has context to avoid repeating questions.
 * Retries with exponential backoff on 429 rate-limit errors.
 * @param {Object} params - { message, userId, context, history }
 * @param {Array<{message: string, sender: string}>} params.history - Prior conversation turns
 * @returns {Promise<Object>} - { reply, provider, meta }
 */
async function getOpenAIChatReply({ message, userId, context, history = [] }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const temperature = process.env.OPENAI_CHAT_TEMPERATURE
    ? parseFloat(process.env.OPENAI_CHAT_TEMPERATURE)
    : 0.75; // Giảm từ 0.8 → 0.75: bớt ngẫu nhiên, kiểm soát hơn

  // Build messages: system → conversation history → current user message
  const messages = [{ role: 'system', content: context || t('prompt.system_chat') }];

  for (const turn of history) {
    messages.push({
      role: turn.sender === 'user' ? 'user' : 'assistant',
      content: turn.message
    });
  }

  messages.push({ role: 'user', content: String(message || '') });

  const payload = {
    model,
    messages,
    temperature,
    max_completion_tokens: 500,
    top_p: 0.95,
    frequency_penalty: 0.6, // Tăng từ 0.3 → 0.6: mạnh tay chống lặp từ/pattern
    presence_penalty: 0.5,  // Tăng từ 0.3 → 0.5: tránh lặp chủ đề/câu hỏi
    ...(userId && { user: `user_${userId}` })
  };

  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s

      await new Promise((r) => setTimeout(r, backoffMs));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      if (attempt < OPENAI_MAX_RETRIES) continue;
      const text = await response.text();
      throw new Error(text || 'OpenAI rate limit exceeded');
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const reply = data.choices[0].message.content;

    return {
      reply: reply.trim(),
      provider: 'openai',
      meta: { model: data.model, tokens_used: data.usage }
    };
  }

  return null;
}

async function getWhisperTranscription(audioBuffer, filename = 'audio.m4a', lang = 'vi') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const { Blob } = require('buffer');
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/m4a' }), filename);
  formData.append('model', 'whisper-1');
  // Không truyền language → Whisper tự detect, tránh lỗi khi UI dùng tiếng Anh nhưng người dùng nói tiếng Việt

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.text || '';
}

module.exports = {
  getOpenAIReply,
  getOpenAIChatReply,
  getWhisperTranscription
};
