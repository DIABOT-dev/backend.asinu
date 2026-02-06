/**
 * OpenAI Provider
 * Sử dụng OpenAI Chat Completions API để sinh câu hỏi thông minh
 */

const DEFAULT_TIMEOUT_MS = 10000; // 10 seconds for question generation
const DEFAULT_MODEL = 'gpt-4o-mini'; // Cost-effective model
const DEFAULT_TEMPERATURE = 0.7; // Balanced creativity

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
        content: 'Bạn là trợ lý y tế chuyên nghiệp, tạo câu hỏi ngắn gọn, thân thiện cho bệnh nhân cao tuổi tại Việt Nam. Chỉ trả về câu hỏi, không giải thích.'
      },
      {
        role: 'user',
        content: String(message || '')
      }
    ],
    temperature: selectedTemp,
    max_tokens: 150, // Câu hỏi ngắn gọn
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
 * Get chat reply for general conversation (existing chat feature)
 * @param {Object} params - { message, userId, sessionId, context }
 * @returns {Promise<Object>} - { reply, provider, meta }
 */
async function getOpenAIChatReply({ message, userId, sessionId, context }) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const temperature = process.env.OPENAI_CHAT_TEMPERATURE ? 
    parseFloat(process.env.OPENAI_CHAT_TEMPERATURE) : 0.8;

  const messages = [
    {
      role: 'system',
      content: context || 'Bạn là trợ lý sức khỏe thân thiện, giúp bệnh nhân quản lý sức khỏe. Trả lời ngắn gọn, dễ hiểu, thấu cảm.'
    },
    {
      role: 'user',
      content: String(message || '')
    }
  ];

  const payload = {
    model,
    messages,
    temperature,
    max_tokens: 500,
    top_p: 1,
    frequency_penalty: 0.3,
    presence_penalty: 0.3
  };

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
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const reply = data.choices[0].message.content;

  return {
    reply: reply.trim(),
    provider: 'openai',
    meta: {
      model: data.model,
      tokens_used: data.usage
    }
  };
}

module.exports = { 
  getOpenAIReply,
  getOpenAIChatReply 
};
