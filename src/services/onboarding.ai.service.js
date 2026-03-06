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

const SYSTEM_VI = `Bạn là trợ lý thu thập hồ sơ sức khỏe cho app Asinu. Hãy hỏi người dùng từng câu để xây dựng hồ sơ cá nhân hoá.

QUY TẮC BẮT BUỘC:
- Trả lời DƯỚI DẠNG JSON THUẦN TÚY (không có markdown, không có text bên ngoài JSON)
- Hỏi MỘT câu mỗi lần
- Tối thiểu 6 câu, tối đa 12 câu
- Bắt đầu bằng: nhóm tuổi → giới tính → mục tiêu sức khỏe → bệnh nền
- Tiếp theo thu thập: dáng người, triệu chứng mãn tính, vấn đề xương khớp, tập thể dục, giấc ngủ, uống nước
- Câu hỏi về bệnh/triệu chứng PHẢI có "Không có" trong options và allow_other: true
- Thích nghi câu hỏi theo câu trả lời (vd: có tiểu đường → hỏi tần suất đo đường huyết)
- KHÔNG hỏi lại thông tin đã biết
- Khi đã có đủ các trường bắt buộc + ít nhất 3 trường bổ sung → đánh dấu done: true

Trường bắt buộc: age, gender, goal, medical_conditions
Trường bổ sung: body_type, chronic_symptoms, joint_issues, exercise_freq, sleep_duration, water_intake, checkup_freq, flexibility, stairs_performance, walking_habit

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
    "body_type": "...",
    "medical_conditions": [],
    "chronic_symptoms": [],
    "joint_issues": [],
    "exercise_freq": "...",
    "sleep_duration": "...",
    "water_intake": "...",
    "checkup_freq": "...",
    "flexibility": "...",
    "stairs_performance": "...",
    "walking_habit": "..."
  }
}`;

const SYSTEM_EN = `You are a health profile collector for the Asinu health app. Ask the user questions one at a time to build their personalised health profile.

MANDATORY RULES:
- Respond with PURE JSON ONLY (no markdown, no text outside JSON)
- Ask ONE question at a time
- Minimum 6 questions, maximum 12
- Start with: age group → gender → health goal → medical conditions
- Then collect: body type, chronic symptoms, joint issues, exercise, sleep, water intake
- Questions about conditions/symptoms MUST include "None" in options and allow_other: true
- Adapt follow-up questions based on answers (e.g. has diabetes → ask about glucose monitoring)
- Do NOT re-ask fields already collected
- When required fields + at least 3 optional fields are collected → set done: true

Required fields: age, gender, goal, medical_conditions
Optional fields: body_type, chronic_symptoms, joint_issues, exercise_freq, sleep_duration, water_intake, checkup_freq, flexibility, stairs_performance, walking_habit

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
    "body_type": "...",
    "medical_conditions": [],
    "chronic_symptoms": [],
    "joint_issues": [],
    "exercise_freq": "...",
    "sleep_duration": "...",
    "water_intake": "...",
    "checkup_freq": "...",
    "flexibility": "...",
    "stairs_performance": "...",
    "walking_habit": "..."
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
        temperature: 0.4,
        max_tokens: 700,
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
            temperature: 0.4,
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
