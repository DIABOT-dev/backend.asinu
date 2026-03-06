/**
 * Voice Service — mic → Whisper transcription → AI chat → text reply
 * Premium only feature.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o';

// ─── transcribeAudio ────────────────────────────────────────────

/**
 * Transcribe audio buffer using OpenAI Whisper.
 * @param {Buffer} audioBuffer
 * @param {string} mimeType - e.g. 'audio/m4a', 'audio/webm', 'audio/mp4'
 * @param {string} filename  - e.g. 'audio.m4a'
 * @returns {Promise<string>} transcript text
 */
async function transcribeAudio(audioBuffer, mimeType, filename = 'audio.m4a') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  // Use native FormData (Node.js 18+) + Blob
  const blob = new Blob([audioBuffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('language', 'vi'); // Ưu tiên tiếng Việt

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();

    throw new Error(`Whisper API error: ${response.status}`);
  }

  const data = await response.json();
  return data.text || '';
}

// ─── voiceChat ───────────────────────────────────────────────────

/**
 * Full voice chat pipeline: audio → transcript → AI reply → text
 * @param {object} pool
 * @param {number} userId
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {{ transcript: string, reply: string }}
 */
async function voiceChat(pool, userId, audioBuffer, mimeType, filename) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  // 1. Transcribe
  const transcript = await transcribeAudio(audioBuffer, mimeType, filename);

  if (!transcript.trim()) {
    return { transcript: '', reply: 'Tôi không nghe thấy gì. Bạn có thể nói lại không?' };
  }

  // 2. Get user profile for context
  const { rows } = await pool.query(
    `SELECT full_name, display_name FROM users WHERE id = $1`,
    [userId]
  );
  const userName = rows[0]?.display_name || rows[0]?.full_name || 'bạn';

  // 3. Chat with AI
  const chatResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `Bạn là Asinu, trợ lý sức khỏe AI thông minh và thân thiện. Người dùng tên ${userName}.
Hãy trả lời ngắn gọn, rõ ràng bằng tiếng Việt. Tập trung vào sức khỏe, dinh dưỡng, lối sống lành mạnh.
Không cung cấp chẩn đoán y tế. Khuyến khích gặp bác sĩ khi cần.`,
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  if (!chatResponse.ok) {
    const errText = await chatResponse.text();

    throw new Error(`Chat API error: ${chatResponse.status}`);
  }

  const chatData = await chatResponse.json();
  const reply = chatData.choices?.[0]?.message?.content || 'Xin lỗi, tôi không thể trả lời lúc này.';

  return { transcript, reply };
}

module.exports = { transcribeAudio, voiceChat };
