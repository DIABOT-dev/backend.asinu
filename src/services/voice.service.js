/**
 * Voice Service — mic → Whisper transcription → AI chat → text reply
 * Premium only feature.
 */

const { t } = require('../i18n');

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
    return { transcript: '', reply: t('voice.no_audio') };
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
      max_completion_tokens: 500,
      temperature: 0.7,
    }),
  });

  if (!chatResponse.ok) {
    const errText = await chatResponse.text();

    throw new Error(`Chat API error: ${chatResponse.status}`);
  }

  const chatData = await chatResponse.json();
  const reply = chatData.choices?.[0]?.message?.content || t('voice.fallback_reply');

  return { transcript, reply };
}

// ─── parseLogVoice ───────────────────────────────────────────────
// Whisper transcribe → GPT-4o JSON parse → structured health data
// Returns: { ok, transcript, parsed, error }

const GLUCOSE_SYSTEM = `Bạn là AI chuyên trích xuất chỉ số đường huyết từ văn bản tiếng Việt.

Nhiệm vụ: Phân tích văn bản người dùng nói và trả về JSON.

Format JSON bắt buộc:
{
  "ok": true,
  "log_type": "glucose",
  "value": <số mg/dL, ví dụ 120>,
  "context": "<fasting|pre_meal|post_meal|before_sleep|random>",
  "notes": "<ghi chú nếu có, hoặc null>"
}

Hoặc nếu KHÔNG nhận ra chỉ số hợp lệ:
{
  "ok": false,
  "error": "<giải thích rõ bằng tiếng Việt, ví dụ: 'Không tìm thấy chỉ số đường huyết. Vui lòng nói rõ số, ví dụ: đường huyết 120 sau ăn'>"
}

Quy tắc context (kể cả câu dài, nói dài dòng):
- "lúc đói" / "đói bụng" / "sáng dậy chưa ăn" / "buổi sáng chưa ăn gì" → fasting
- "trước ăn" / "trước bữa" / "chưa ăn" → pre_meal
- "sau ăn" / "sau bữa" / "sau khi ăn" / "ăn xong khoảng ... tiếng" → post_meal
- "trước ngủ" / "trước khi đi ngủ" / "tối trước khi ngủ" → before_sleep
- Không xác định được → random
Trích xuất số liệu dù người dùng nói dài dòng hay kể lể, miễn là có số liệu rõ ràng.

Phạm vi hợp lệ: 20 - 800 mg/dL.
Nếu số ngoài phạm vi hoặc không rõ ràng → ok: false, giải thích lý do.
Chỉ trả về JSON thuần, không markdown, không giải thích thêm.`;

const BP_SYSTEM = `Bạn là AI chuyên trích xuất chỉ số huyết áp từ văn bản tiếng Việt.

Nhiệm vụ: Phân tích văn bản người dùng nói và trả về JSON.

Format JSON bắt buộc:
{
  "ok": true,
  "log_type": "blood_pressure",
  "systolic": <số tâm thu mmHg, ví dụ 120>,
  "diastolic": <số tâm trương mmHg, ví dụ 80>,
  "pulse": <nhịp tim bpm nếu có, hoặc null>,
  "notes": "<ghi chú nếu có, hoặc null>"
}

Hoặc nếu KHÔNG nhận ra chỉ số hợp lệ:
{
  "ok": false,
  "error": "<giải thích rõ bằng tiếng Việt, ví dụ: 'Không tìm thấy chỉ số huyết áp. Vui lòng nói dạng: huyết áp 120/80'>"
}

Cách nhận dạng huyết áp (kể cả câu dài, nói dài dòng):
- "120/80", "một hai mươi trên tám mươi", "một trăm hai mươi trên tám mươi" → systolic=120, diastolic=80
- "tâm thu 130 tâm trương 85" → systolic=130, diastolic=85
- "huyết áp 125 85" (2 số liên tiếp) → systolic=125, diastolic=85
- "Hôm nay đo được huyết áp là 130 trên 85, nhịp tim 72" → systolic=130, diastolic=85, pulse=72
- Trích xuất số liệu dù người dùng nói dài dòng hay kể lể, miễn là có số liệu rõ ràng.

Phạm vi hợp lệ: systolic 60-300, diastolic 30-200.
Systolic phải lớn hơn diastolic. Nếu ngược lại → hỏi lại.
Chỉ trả về JSON thuần, không markdown, không giải thích thêm.`;

/**
 * Transcribe audio + parse health log data using GPT-4o JSON mode.
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {string} filename
 * @param {'glucose'|'blood_pressure'} logType
 * @returns {Promise<{ ok: boolean, transcript: string, parsed: object|null, error: string|null }>}
 */
async function parseLogVoice(audioBuffer, mimeType, filename, logType) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  // Step 1: Whisper transcription
  const transcript = await transcribeAudio(audioBuffer, mimeType, filename);

  if (!transcript || !transcript.trim()) {
    return {
      ok: false,
      transcript: '',
      parsed: null,
      error: t('voice.no_content')
    };
  }

  // Step 2: GPT-4o parse transcript → structured JSON
  const systemPrompt = logType === 'glucose' ? GLUCOSE_SYSTEM : BP_SYSTEM;

  const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ],
      temperature: 0.1,
      max_completion_tokens: 300,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(`GPT parse error ${chatRes.status}: ${errText}`);
  }

  const chatData = await chatRes.json();
  let parsed;
  try {
    parsed = JSON.parse(chatData.choices?.[0]?.message?.content || '{}');
  } catch {
    return {
      ok: false,
      transcript,
      parsed: null,
      error: t('voice.ai_parse_error')
    };
  }

  if (!parsed.ok) {
    return {
      ok: false,
      transcript,
      parsed: null,
      error: parsed.error || t('voice.invalid_data')
    };
  }

  return {
    ok: true,
    transcript,
    parsed,
    error: null
  };
}

module.exports = { transcribeAudio, voiceChat, parseLogVoice };
