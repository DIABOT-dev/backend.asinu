'use strict';

/**
 * Streaming Service — SSE cho AI responses
 *
 * Giảm perceived latency bằng cách trả từng chunk text cho client.
 *
 * Hai chế độ:
 *   1. streamOpenAI() — pipe trực tiếp từ OpenAI stream → SSE
 *   2. streamChunked() — chia text có sẵn thành chunks → SSE (cho cached responses)
 */

const OpenAI = require('openai');

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── SSE helpers ────────────────────────────────────────────────────────────

/**
 * Setup SSE headers cho Express response.
 */
function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx
  });
}

/**
 * Send one SSE event.
 * @param {object} res - Express response
 * @param {string} event - event name
 * @param {any} data - JSON-serializable data
 */
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Stream from OpenAI ─────────────────────────────────────────────────────

/**
 * Stream OpenAI completion directly to SSE.
 *
 * @param {object} res - Express response (SSE)
 * @param {object} options
 *   - model: string
 *   - messages: Array
 *   - temperature: number (default 0.3)
 *   - max_tokens: number (default 500)
 *   - onChunk: (chunk: string) => void (optional callback per chunk)
 * @returns {Promise<string>} full accumulated text
 */
async function streamOpenAI(res, options = {}) {
  const {
    model = 'gpt-4o-mini',
    messages = [],
    temperature = 0.3,
    max_tokens = 500,
    onChunk = null,
  } = options;

  setupSSE(res);
  sendSSE(res, 'start', { model, timestamp: Date.now() });

  let fullText = '';

  try {
    const stream = await getClient().chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content || '';
      if (content) {
        fullText += content;
        sendSSE(res, 'chunk', { text: content });
        if (onChunk) onChunk(content);
      }
    }

    sendSSE(res, 'done', { fullText, tokens: fullText.length });
  } catch (err) {
    sendSSE(res, 'error', { error: err.message });
  }

  res.end();
  return fullText;
}

// ─── Stream from cached text ────────────────────────────────────────────────

/**
 * Stream pre-existing text as SSE chunks.
 * Used when response is from cache but we still want streaming UX.
 *
 * @param {object} res - Express response
 * @param {string} text - full text to stream
 * @param {object} options
 *   - chunkSize: number of chars per chunk (default 20)
 *   - delayMs: ms between chunks (default 30)
 *   - metadata: extra data for 'done' event
 */
async function streamChunked(res, text, options = {}) {
  const { chunkSize = 20, delayMs = 30, metadata = {} } = options;

  setupSSE(res);
  sendSSE(res, 'start', { cached: true, timestamp: Date.now() });

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.substring(i, i + chunkSize);
    sendSSE(res, 'chunk', { text: chunk });
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  sendSSE(res, 'done', { fullText: text, cached: true, ...metadata });
  res.end();
}

// ─── Non-streaming fallback ─────────────────────────────────────────────────

/**
 * Call OpenAI without streaming (for when SSE not needed).
 * Returns full response at once.
 */
async function callOpenAI(options = {}) {
  const {
    model = 'gpt-4o-mini',
    messages = [],
    temperature = 0.3,
    max_tokens = 500,
  } = options;

  const response = await getClient().chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
  });

  return {
    text: response.choices?.[0]?.message?.content || '',
    usage: response.usage || {},
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  setupSSE,
  sendSSE,
  streamOpenAI,
  streamChunked,
  callOpenAI,
};
