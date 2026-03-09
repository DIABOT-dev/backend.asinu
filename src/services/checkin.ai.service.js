/**
 * Checkin AI Service
 * Sinh câu hỏi triage thích nghi (3–5 câu) để xác định vấn đề trọng tâm.
 * Mỗi lần gọi trả về 1 câu hỏi TIẾP THEO hoặc báo done + summary.
 */

const OpenAI = require('openai');

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Sinh câu hỏi triage kế tiếp.
 *
 * @param {Object} params
 * @param {'tired'|'very_tired'} params.status      - Trạng thái ban đầu
 * @param {Object}  params.profile                   - Profile onboarding (age, conditions, risk_score…)
 * @param {Array}   params.previousAnswers           - [{question, answer}] các câu đã hỏi
 * @returns {Promise<{isDone, question, options, summary, severity, recommendation}>}
 */
async function getNextTriageQuestion({ status, profile, previousAnswers = [] }) {
  const answerCount = previousAnswers.length;
  const maxQuestions = status === 'very_tired' ? 4 : 5;
  const remaining = maxQuestions - answerCount;

  // Tính tuổi từ birth_year
  const age = profile.birth_year
    ? new Date().getFullYear() - parseInt(profile.birth_year)
    : (profile.age ? parseInt(profile.age) : null);

  const conditions = Array.isArray(profile.medical_conditions)
    ? profile.medical_conditions.filter(c => c && c !== 'Không có').join(', ')
    : '';

  const statusLabel = status === 'tired' ? 'hơi mệt' : 'rất mệt';

  const historyText = previousAnswers.length
    ? previousAnswers.map((a, i) => `Câu ${i + 1}: "${a.question}"\nTrả lời: "${a.answer}"`).join('\n\n')
    : 'Chưa hỏi câu nào.';

  const systemPrompt = `Bạn là AI triage sức khoẻ của Asinu — hỗ trợ xác định nhanh vấn đề sức khoẻ.

Người dùng vừa báo trạng thái: "${statusLabel}".
Thông tin profile:
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
- Nhóm sức khoẻ: ${profile.user_group || 'wellness'}

Lịch sử triage:
${historyText}

Nhiệm vụ: Sinh câu hỏi TIẾP THEO (hoặc kết luận nếu đủ thông tin).

QUY TẮC:
- Tối đa ${maxQuestions} câu tổng cộng. Đã hỏi ${answerCount} câu, còn ${remaining} câu.
- Ưu tiên loại trừ nguy cơ NGHIÊM TRỌNG nhất trước (khó thở, đau ngực, mất ý thức…)
- Câu hỏi ngắn gọn, dễ hiểu, tự nhiên như người thân hỏi thăm
- Mỗi câu kèm 3–4 options ngắn để chọn nhanh (người dùng cũng có thể tự gõ)
- Không hỏi lại điều đã biết từ profile hoặc câu trước
- Nếu đã đủ thông tin (dù chưa đủ ${maxQuestions} câu) → kết luận luôn
${status === 'very_tired' ? '- Đây là "rất mệt" → ưu tiên phát hiện nguy hiểm cần đến viện hoặc báo người nhà' : ''}

Trả về JSON (không có markdown):

Khi còn câu hỏi:
{"isDone":false,"question":"...","options":["...","...","..."]}

Khi đủ thông tin:
{"isDone":true,"summary":"Tóm tắt 1 câu vấn đề trọng tâm","severity":"low|medium|high","recommendation":"Lời khuyên ngắn 1-2 câu","needsDoctor":true|false,"needsFamilyAlert":true|false}`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: systemPrompt }],
    max_completion_tokens: 300,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    const result = JSON.parse(raw);
    return result;
  } catch {
    // Fallback if JSON parsing fails
    return {
      isDone: true,
      summary: 'Không thể phân tích triệu chứng.',
      severity: 'medium',
      recommendation: 'Nghỉ ngơi và theo dõi. Nếu không cải thiện sau 2 tiếng, hãy liên hệ bác sĩ.',
      needsDoctor: false,
      needsFamilyAlert: false,
    };
  }
}

module.exports = { getNextTriageQuestion };
