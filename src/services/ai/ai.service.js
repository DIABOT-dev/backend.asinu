'use strict';

/**
 * Unified AI Service
 *
 * Centralized adapter for text-based AI tasks (Triage, Analysis, Memory extraction, R&D).
 * Routes calls to MedGemma or OpenAI based on environmental configuration.
 * Normalizes input/output structure to prevent tight coupling to specific vendor SDKs.
 */

const openaiProvider = require('./providers/openai');
const medgemmaProvider = require('./providers/medgemma');

const CLINICAL_PROVIDER = (process.env.AI_PROVIDER_CLINICAL || 'openai').toLowerCase();

/**
 * Call the configured text-based LLM.
 *
 * @param {Object} params
 *   - system: string (optional system prompt)
 *   - prompt: string (optional user prompt, used if messages is not defined)
 *   - messages: Array<{role: string, content: string}> (optional, full conversation messages)
 *   - temperature: number (optional)
 *   - maxTokens: number (optional)
 *   - jsonMode: boolean (optional, OpenAI only)
 * @returns {Promise<{ content: string, usage: Object, provider: string, model: string }>}
 */
async function callTextAi({ system, prompt, messages, temperature, maxTokens, jsonMode = false }) {
  // ─── 1. MedGemma Route ───────────────────────────────────────────────────
  if (CLINICAL_PROVIDER === 'medgemma' && medgemmaProvider.isConfigured()) {
    let finalPrompt = prompt || '';
    let finalSystem = system || '';

    // If messages array is provided, flatten it to a single prompt (MedGemma format)
    if (messages && messages.length > 0) {
      const systemMsg = messages.find(m => m.role === 'system');
      if (systemMsg) {
        finalSystem = systemMsg.content;
      }

      const nonSystemMsgs = messages.filter(m => m.role !== 'system');
      finalPrompt = nonSystemMsgs.map(m => {
        const roleName = m.role === 'user' ? 'User' : 'Assistant';
        return `${roleName}: ${m.content}`;
      }).join('\n');
    }

    const res = await medgemmaProvider.callMedGemmaWithRetry({
      system: finalSystem,
      prompt: finalPrompt,
      temperature: temperature !== undefined ? temperature : 0.3,
      maxTokens: maxTokens || 800,
    });

    return {
      content: res.reply,
      usage: res.meta?.tokens_used || { prompt: 0, completion: 0, total: 0 },
      provider: 'medgemma',
      model: res.meta?.model || 'medgemma',
    };
  }

  // ─── 2. OpenAI Route (Default / Fallback) ───────────────────────────────
  let openaiMessages = messages;
  if (!openaiMessages) {
    openaiMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: String(prompt || '') },
    ];
  }

  const OpenAI = require('openai');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    temperature: temperature !== undefined ? temperature : 0.7,
    max_tokens: maxTokens || 500,
    ...(jsonMode && { response_format: { type: 'json_object' } }),
  });

  const content = response.choices?.[0]?.message?.content || '';
  const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    content: content.trim(),
    usage: {
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    },
    provider: 'openai',
    model,
  };
}

module.exports = {
  callTextAi,
};
