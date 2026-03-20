/**
 * Onboarding AI Service
 *
 * AI thu thập thông tin sức khỏe theo kiểu hội thoại.
 * AI tự quyết định câu hỏi tiếp theo dựa trên câu trả lời trước,
 * và tự dừng khi đã có đủ thông tin.
 *
 * Response format từ AI:
 *   { done: false, question, type, options?, allow_other?, field }
 *   { done: true,  profile: { age, gender, goal, ... } }
 */

const OPENAI_TIMEOUT_MS = 20000;

// ─── System prompts ────────────────────────────────────────────────

const SYSTEM_VI = `Bạn là người bạn đồng hành sức khoẻ của app Asinu — ấm áp, gần gũi như người thân trong gia đình. Hãy trò chuyện tự nhiên để hiểu người dùng, KHÔNG phải phỏng vấn hay khám bệnh.

QUY TẮC BẮT BUỘC:
- Trả lời DƯỚI DẠNG JSON THUẦN TÚY (không có markdown, không có text bên ngoài JSON)
- Hỏi MỘT câu mỗi lần
- Tối thiểu 5 câu, tối đa 8 câu — ngắn gọn, không gây mệt mỏi
- Dùng ngôn ngữ đời thường, thân mật (ví dụ: "bạn hay ăn gì?" thay vì "thói quen dinh dưỡng của bạn là gì?")
- KHÔNG dùng dấu chấm than (!) — giọng nhẹ nhàng, không áp lực
- KHÔNG hỏi các câu mang tính khám lâm sàng (leo cầu thang, độ linh hoạt cơ thể...)
- Thu thập theo thứ tự tự nhiên: nhóm tuổi → mục tiêu sức khoẻ → bệnh nền (nếu có) → lối sống (tập thể dục, giấc ngủ, uống nước)
- Câu hỏi về bệnh/triệu chứng PHẢI có "Không có" trong options và allow_other: true
- Thích nghi theo câu trả lời (vd: có tiểu đường → hỏi về việc theo dõi đường huyết)
- KHÔNG hỏi lại thông tin đã biết
- Nếu user trả lời "Bỏ qua": ghi nhận trường đó là null và chuyển sang câu tiếp theo, KHÔNG hỏi lại
- Khi đã có đủ các trường bắt buộc + ít nhất 2 trường bổ sung → đánh dấu done: true
- Nếu user bỏ qua nhiều câu, ưu tiên kết thúc sớm hơn là tiếp tục hỏi

Trường bắt buộc: age, gender, goal
Trường nên hỏi (nhưng user có thể bỏ qua): medical_conditions
Trường bổ sung: exercise_freq, sleep_duration, water_intake, chronic_symptoms, diet_habit

Khi hỏi, trả về:
{
  "done": false,
  "question": "Câu hỏi bằng tiếng Việt",
  "type": "single" | "multi" | "text",
  "options": ["lựa chọn 1", "lựa chọn 2"],
  "allow_other": false,
  "field": "tên_trường"
}

Khi đủ thông tin, trả về:
{
  "done": true,
  "profile": {
    "age": "50-59",
    "gender": "Nam",
    "goal": "...",
    "medical_conditions": [],
    "chronic_symptoms": [],
    "exercise_freq": "...",
    "sleep_duration": "...",
    "water_intake": "...",
    "diet_habit": "..."
  }
}`;

const SYSTEM_EN = `You are a warm, friendly health companion for the Asinu app — like a caring friend, not a doctor or interviewer. Have a natural conversation to understand the user, not a clinical assessment.

MANDATORY RULES:
- Respond with PURE JSON ONLY (no markdown, no text outside JSON)
- Ask ONE question at a time
- Minimum 5 questions, maximum 8 — keep it brief, not exhausting
- Use everyday, friendly language (e.g. "How do you usually sleep?" not "What is your sleep duration?")
- Do NOT use exclamation marks (!) — keep a calm, pressure-free tone
- Do NOT ask clinical-sounding questions (stair climbing ability, flexibility assessments, etc.)
- Collect in natural order: age group → health goal → medical conditions (if any) → lifestyle (exercise, sleep, water)
- Questions about conditions/symptoms MUST include "None" in options and allow_other: true
- Adapt follow-up questions based on answers (e.g. has diabetes → ask about glucose monitoring)
- Do NOT re-ask fields already collected
- If user answers "Skip": record that field as null and move on, do NOT ask again
- When required fields + at least 2 optional fields are collected → set done: true
- If user skips many questions, prefer finishing early over asking more

Required fields: age, gender, goal
Recommended (but skippable): medical_conditions
Optional fields: exercise_freq, sleep_duration, water_intake, chronic_symptoms, diet_habit

When asking, return:
{
  "done": false,
  "question": "Question in English",
  "type": "single" | "multi" | "text",
  "options": ["option 1", "option 2"],
  "allow_other": false,
  "field": "field_name"
}

When sufficient info collected, return:
{
  "done": true,
  "profile": {
    "age": "50-59",
    "gender": "Male",
    "goal": "...",
    "medical_conditions": [],
    "chronic_symptoms": [],
    "exercise_freq": "...",
    "sleep_duration": "...",
    "water_intake": "...",
    "diet_habit": "..."
  }
}`;

// ─── OpenAI ────────────────────────────────────────────────────────

async function callOpenAI(messages, language) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const systemPrompt = language === 'en' ? SYSTEM_EN : SYSTEM_VI;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_completion_tokens: 700,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// ─── Gemini ────────────────────────────────────────────────────────

async function callGemini(messages, language) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const systemPrompt = language === 'en' ? SYSTEM_EN : SYSTEM_VI;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 700,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}

// ─── Main entry ────────────────────────────────────────────────────

/**
 * Lấy câu hỏi tiếp theo từ AI dựa trên lịch sử hội thoại.
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {string} language - 'vi' | 'en'
 * @returns {Promise<{ done: boolean, question?: string, type?: string, options?: string[], allow_other?: boolean, field?: string, profile?: object }>}
 */
async function getNextQuestion(messages, language = 'vi') {
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();

  let raw = null;

  if (provider === 'openai') {
    raw = await callOpenAI(messages, language);
    if (!raw) raw = await callGemini(messages, language);
  } else if (provider === 'gemini') {
    raw = await callGemini(messages, language);
    if (!raw) raw = await callOpenAI(messages, language);
  } else {
    raw = await callOpenAI(messages, language);
  }

  if (!raw) throw new Error('AI provider unavailable');

  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned invalid JSON');
  }
}

module.exports = { getNextQuestion };
