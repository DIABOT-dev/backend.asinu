/**
 * Checkin AI Service — Asinu Health Companion
 *
 * Phases:
 *   initial  — buổi sáng/lần đầu trong ngày: clinical interview 9 bước, tối đa 8 câu
 *   followup — check-in định kỳ: 3-layer Q&A (Status / Symptoms / Actions), tối đa 3 câu
 */

const OpenAI = require('openai');
const { t } = require('../i18n');

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatGlucose(rows) {
  if (!rows.length) return null;
  return rows.map(r => {
    const d = new Date(r.occurred_at).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return `${r.value} ${r.unit}${r.context ? ' (' + r.context + ')' : ''} - ${d}`;
  }).join('; ');
}

function formatBP(rows) {
  if (!rows.length) return null;
  return rows.map(r => {
    const d = new Date(r.occurred_at).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return `${r.systolic}/${r.diastolic}${r.pulse ? ' nhịp ' + r.pulse : ''} - ${d}`;
  }).join('; ');
}

function formatPreviousCheckins(rows) {
  if (!rows.length) return null;
  return rows.map(r => {
    const d = new Date(r.session_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    const sev = r.triage_severity === 'high' ? 'nghiêm trọng' : r.triage_severity === 'medium' ? 'vừa' : 'nhẹ';
    const st = r.initial_status === 'very_tired' ? 'rất mệt'
      : r.initial_status === 'specific_concern' ? 'có triệu chứng'
      : 'hơi mệt';
    return `[${d}] ${st} → mức ${sev}: ${r.triage_summary || ''}`;
  }).join('\n');
}

// ─── Continuity message ───────────────────────────────────────────────────────

/**
 * Tạo câu mở đầu tham chiếu session hôm qua — "Hôm qua bạn đề cập..."
 * Trả về null nếu hôm qua ổn hoặc không có session.
 */
function buildContinuityMessage(yesterdaySession, lang = 'vi') {
  if (!yesterdaySession) return null;
  const { initial_status, triage_summary } = yesterdaySession;
  if (initial_status === 'fine') return null;

  const statusKey = initial_status === 'very_tired' ? 'checkinAi.status_very_unwell'
    : initial_status === 'specific_concern' ? 'checkinAi.status_specific_concern'
    : 'checkinAi.status_slightly_unwell';
  const statusLabel = t(statusKey, lang);

  if (triage_summary) {
    const short = triage_summary.length > 70 ? triage_summary.slice(0, 70) + '...' : triage_summary;
    return t('checkinAi.continuity_with_summary', lang, { status: statusLabel, summary: short });
  }
  return t('checkinAi.continuity_without_summary', lang, { status: statusLabel });
}

// ─── Follow-up hours calculation ──────────────────────────────────────────────

/**
 * Trả về số giờ đến lần check-in tiếp theo dựa theo severity.
 * Normal: 6–12h | Slightly unwell: 3–4h | Very unwell: 1–2h
 */
function calcFollowUpHours(severity, answerCount = 0) {
  if (severity === 'low') return answerCount === 0 ? 8 : 6;        // bình thường: 6-8h
  if (severity === 'medium') return answerCount === 0 ? 3 : 4;     // hơi mệt: 3-4h
  return answerCount === 0 ? 1 : 2;                                 // rất mệt: 1-2h
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Sinh câu hỏi triage kế tiếp, phase-aware.
 *
 * @param {Object} params
 * @param {'tired'|'very_tired'|'specific_concern'} params.status
 * @param {'initial'|'followup'} params.phase   - initial=buổi sáng, followup=check định kỳ
 * @param {Object} params.profile
 * @param {Object} params.healthContext
 * @param {Array}  params.previousAnswers
 * @param {Object|null} params.previousSessionSummary  - summary của lần triage trước (cho followup)
 */
async function getNextTriageQuestion({
  status,
  phase = 'initial',
  lang = 'vi',
  profile,
  healthContext = {},
  previousAnswers = [],
  previousSessionSummary = null,
}) {
  const answerCount = previousAnswers.length;
  const isVeryUnwell = status === 'very_tired';
  const isFollowUp = phase === 'followup';

  // Giới hạn câu hỏi theo phase
  const maxQuestions = isFollowUp ? 3 : (isVeryUnwell ? 6 : 8);

  const age = profile.birth_year
    ? new Date().getFullYear() - parseInt(profile.birth_year)
    : (profile.age ? parseInt(profile.age) : null);

  const conditions = Array.isArray(profile.medical_conditions)
    ? profile.medical_conditions.filter(c => c && c !== 'Không có').join(', ')
    : (profile.medical_conditions || '');

  // ── Health context ──
  const glucoseStr = formatGlucose(healthContext.recentGlucose || []);
  const bpStr      = formatBP(healthContext.recentBP || []);
  const weightStr  = healthContext.latestWeight ? `${healthContext.latestWeight.weight_kg} kg` : null;
  const prevCheckinsStr = formatPreviousCheckins(healthContext.previousCheckins || []);

  const healthDataLines = [
    glucoseStr && `- Glucose 7 ngày gần đây: ${glucoseStr}`,
    bpStr      && `- Huyết áp 7 ngày gần đây: ${bpStr}`,
    weightStr  && `- Cân nặng: ${weightStr}`,
  ].filter(Boolean);

  const healthDataSection = healthDataLines.length
    ? `Dữ liệu sức khoẻ gần đây:\n${healthDataLines.join('\n')}`
    : 'Chưa có dữ liệu sức khoẻ gần đây.';

  const prevCheckinsSection = prevCheckinsStr
    ? `Lịch sử check-in gần nhất:\n${prevCheckinsStr}`
    : 'Chưa có lịch sử check-in trước.';

  const historyText = previousAnswers.length
    ? previousAnswers.map((a, i) => `Q${i + 1}: "${a.question}" → "${a.answer}"`).join('\n')
    : '(Chưa hỏi câu nào)';

  // ── Tạo system prompt theo phase ──
  let systemPrompt;

  if (isFollowUp) {
    // PHASE 3 — Follow-up monitoring: 3 bước, tối đa 3 câu
    // Quy tắc early-exit: nếu bước 1 user đã đỡ → kết thúc ngay
    const prevSummary = previousSessionSummary
      ? `Tóm tắt buổi sáng: "${previousSessionSummary}"`
      : 'Không có tóm tắt trước.';

    const statusLabel = status === 'very_tired' ? 'rất không khoẻ'
      : status === 'specific_concern' ? 'có triệu chứng cụ thể'
      : 'hơi không khoẻ';

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ đang theo dõi định kỳ. Người dùng vừa báo cáo "${statusLabel}".

=== THÔNG TIN NGƯỜI DÙNG ===
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
${healthDataSection}
${prevSummary}

=== FOLLOW-UP NÀY (${answerCount}/${maxQuestions} câu đã hỏi) ===
${historyText}

=== NHIỆM VỤ: THEO DÕI DIỄN BIẾN ===
Hỏi lần lượt 3 bước — tối đa ${maxQuestions} câu — DỪNG NGAY khi đủ thông tin.

BƯỚC 1 — TRẠNG THÁI HIỆN TẠI (nếu chưa hỏi):
Mục tiêu: So sánh với lần check-in trước — đỡ hơn / vẫn vậy / nặng hơn?
Mẫu câu: "So với lúc trước bạn thấy thế nào rồi?" / "Tình trạng của bạn có cải thiện chưa?"
Options ví dụ: đã đỡ hơn / vẫn như cũ / mệt hơn trước
⚡ QUY TẮC: Nếu user trả lời ĐÃ ĐỠ → KẾT LUẬN NGAY, không hỏi tiếp (isDone=true, progression=improved)

BƯỚC 2 — TRIỆU CHỨNG MỚI (chỉ hỏi nếu bước 1 chưa đỡ):
Mục tiêu: Phát hiện triệu chứng mới xuất hiện thêm
Mẫu câu: "Bạn có thêm triệu chứng nào khác không?" / "Ngoài cảm giác trước, bạn còn gặp gì thêm không?"
Options ví dụ: chóng mặt / buồn nôn / run tay / không có gì thêm

BƯỚC 3 — HÀNH ĐỘNG ĐÃ LÀM (nếu chưa kết luận được):
Mục tiêu: Biết user đã làm gì để cải thiện
Mẫu câu: "Bạn đã nghỉ ngơi hoặc ăn uống gì chưa?" / "Từ lúc nãy bạn đã làm gì chưa?"
Options ví dụ: đã nghỉ ngơi / đã ăn uống / uống nước / đo chỉ số / chưa làm gì

=== XỬ LÝ SAU KHI ĐỦ THÔNG TIN ===
✓ ĐÃ ĐỠ (improved): isDone=true, progression=improved, followUpHours: 6–8 (dài hơn vì đang hồi phục)
✓ VẪN VẬY (same): isDone=true, progression=same, tiếp tục theo dõi sau 3–4h
✓ NẶNG HƠN (worsened): hỏi thêm red flag trước khi kết luận
  - Nếu có red flag (đau ngực / khó thở / vã mồ hôi nhiều / hoa mắt nặng): hasRedFlag=true, needsDoctor=true
  - isDone=true, progression=worsened, followUpHours: 1–2

NGUYÊN TẮC:
- Câu hỏi ngắn gọn, ấm áp, không lặp điều đã biết
- ⚠️ GIỚI HẠN CỨNG: Đã hỏi ${answerCount} câu. Tối đa ${maxQuestions} câu. ${answerCount >= maxQuestions - 1 ? '→ ĐÂY LÀ CÂU CUỐI CÙNG — BẮT BUỘC trả isDone=true!' : `Còn ${maxQuestions - answerCount} câu.`}
- Ưu tiên dừng sớm nếu đủ thông tin — KẾT LUẬN NGAY (isDone=true)
- AI hỏi → người dùng trả lời → AI HIỂU diễn biến → AI hỏi tiếp ĐÚNG câu dựa trên câu trả lời trước
- KHÔNG hỏi đoán mò, KHÔNG hỏi cứng nhắc — câu hỏi phải dựa trên tình trạng thực tế user vừa mô tả
- So sánh với lịch sử check-in trước để phát hiện pattern và diễn tiến bệnh

Format câu hỏi: {"isDone":false,"question":"...","options":["...","...","..."]}
Format kết luận follow-up: {"isDone":true,"progression":"improved|same|worsened","hasRedFlag":false,"summary":"1 câu tóm tắt","severity":"low|medium|high","recommendation":"lời khuyên ấm áp","needsDoctor":false,"needsFamilyAlert":false,"followUpHours":3}

LANGUAGE: All output (question, options, summary, recommendation) MUST be in ${lang === 'en' ? 'English' : 'Vietnamese'}.`;

  } else {
    // PHASE 2 — Initial clinical interview (buổi sáng, lần đầu báo cáo không khoẻ)
    // TYPE 1 (Chief Complaint) đã xác định: user chọn trạng thái → bắt đầu từ TYPE 2
    const statusLabel = status === 'very_tired' ? 'rất không khoẻ'
      : status === 'specific_concern' ? 'có triệu chứng cụ thể muốn chia sẻ'
      : 'hơi không khoẻ';

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ AI. Người dùng vừa cho biết họ "${statusLabel}" (Chief Complaint TYPE 1 đã xác định — không cần hỏi lại).

=== THÔNG TIN NGƯỜI DÙNG ===
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
- Nhóm: ${profile.user_group || 'wellness'}
${healthDataSection}
${prevCheckinsSection}

=== PHIÊN PHỎNG VẤN HIỆN TẠI (${answerCount}/${maxQuestions} câu đã hỏi) ===
${historyText}

=== NHIỆM VỤ: CLINICAL INTERVIEW (TYPE 2–9) ===
Tối đa ${maxQuestions} câu — DỪNG NGAY khi đủ thông tin, không cần hỏi hết.
${isVeryUnwell ? '⚡ NGƯỜI DÙNG RẤT MỆT → BẮT ĐẦU NGAY VỚI [TYPE 6] RED FLAG SCREENING trước tiên!' : ''}

Dùng 8 MẪU TƯ DUY sau để tạo câu hỏi tự nhiên (không lặp nguyên văn mẫu):

[TYPE 2] ĐỊNH LƯỢNG — Biết mức độ khó chịu
  Mục tiêu: mức nhẹ / vừa / nặng
  Mẫu câu: "Mức độ mệt của bạn như thế nào?" | Options: nhẹ / vừa / khá nặng / rất nặng

[TYPE 3] TRIỆU CHỨNG — Xác định loại triệu chứng đang gặp
  Mục tiêu: biết cụ thể user đang gặp gì
  Mẫu câu: "Bạn đang gặp tình trạng nào?" | Options: mệt mỏi / chóng mặt / đau đầu / buồn nôn / khát nhiều / không rõ

[TYPE 4] THỜI ĐIỂM — Biết triệu chứng bắt đầu khi nào
  Mục tiêu: onset giúp đánh giá mức độ
  Mẫu câu: "Tình trạng này bắt đầu từ khi nào?" | Options: vừa mới / vài tiếng trước / từ sáng / từ hôm qua

[TYPE 5] DIỄN TIẾN — Triệu chứng đang thay đổi thế nào
  Mục tiêu: đang cải thiện hay xấu đi
  Mẫu câu: "Sau khi xuất hiện, tình trạng có thay đổi không?" | Options: đang đỡ dần / vẫn như lúc đầu / có vẻ nặng hơn

[TYPE 6] RED FLAG ⚠️ — Phát hiện dấu hiệu nguy hiểm (BẮT BUỘC hỏi)
  Mục tiêu: phát hiện sớm dấu hiệu cần can thiệp y tế
  Mẫu câu: "Bạn có gặp tình trạng nào sau không?" | Options: run tay / vã mồ hôi / hoa mắt / khó thở / đau ngực / không có

[TYPE 7] NGUYÊN NHÂN — Giúp user tự nhận ra nguyên nhân
  Mục tiêu: hiểu bối cảnh, cá nhân hoá lời khuyên
  Mẫu câu: "Bạn nghĩ điều gì có thể gây ra tình trạng này?" | Options: ngủ ít / bỏ bữa / căng thẳng / quên thuốc / không rõ

[TYPE 8] HÀNH ĐỘNG — Biết user đã làm gì
  Mục tiêu: tránh đưa lời khuyên trùng với những gì đã làm
  Mẫu câu: "Bạn đã làm gì để cải thiện chưa?" | Options: nghỉ ngơi / ăn uống / uống thuốc / đo chỉ số / chưa làm gì

[TYPE 9] THEO DÕI — Thiết lập vòng theo dõi (tích hợp vào closeMessage)
  Kết thúc bằng câu ấm áp, ví dụ: "Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."

NGUYÊN TẮC BẮT BUỘC:
1. KHÔNG hỏi Chief Complaint (đã biết: "${statusLabel}")
2. KHÔNG hỏi thông tin đã có từ profile / dữ liệu sức khoẻ / lịch sử triage
3. KHÔNG lặp lại câu hỏi đã hỏi trong phiên này — kiểm tra lại history trước khi hỏi
4. Cá nhân hoá: ${conditions ? `có bệnh nền ${conditions} → hỏi phù hợp với bệnh nền` : 'hỏi tổng quát'}
5. ${glucoseStr ? 'Glucose bất thường → ưu tiên hỏi về ăn uống/insulin' : ''}${bpStr ? 'Huyết áp bất thường → hỏi đau đầu/chóng mặt' : ''}
6. Câu hỏi ngắn gọn, ấm áp, tự nhiên như người thân hỏi thăm
7. ⚠️ GIỚI HẠN CỨNG: Đã hỏi ${answerCount} câu. Tối đa ${maxQuestions} câu. ${answerCount >= maxQuestions - 1 ? '→ ĐÂY LÀ CÂU CUỐI CÙNG — BẮT BUỘC trả isDone=true với summary/severity/recommendation!' : `Còn ${maxQuestions - answerCount} câu.`}
8. Khi đã đủ thông tin để đánh giá → KẾT LUẬN NGAY (isDone=true), không cần hỏi hết quota

=== TƯ DUY Y KHOA — HỎI THÔNG MINH THEO CÂU TRẢ LỜI ===
⚡ NGUYÊN TẮC CỐT LÕI: AI hỏi → người dùng trả lời → AI HIỂU diễn biến → AI hỏi tiếp ĐÚNG câu.

CÁCH ÁP DỤNG:
- Đọc kỹ câu trả lời cuối cùng của user → xác định hướng hỏi tiếp theo dựa trên NỘI DUNG CÂU TRẢ LỜI, không theo thứ tự cố định TYPE 2→3→4...
- Ví dụ: nếu user nói "đau đầu từ sáng" → câu tiếp PHẢI hỏi về mức độ đau đầu hoặc triệu chứng kèm theo, KHÔNG hỏi lại "bạn bị gì?"
- Ví dụ: nếu user nói "chóng mặt + buồn nôn" → câu tiếp nên hỏi onset/red flag, KHÔNG hỏi lại triệu chứng
- KHÔNG hỏi đoán mò — mỗi câu hỏi phải có lý do y khoa rõ ràng dựa trên thông tin đã thu thập
- KHÔNG hỏi những câu cứng nhắc hàng ngày — câu hỏi phải phản ánh ĐÚNG tình trạng thực tế của user

SỬ DỤNG LỊCH SỬ:
${prevCheckinsStr ? `- User có lịch sử check-in → ĐỌC KỸ và so sánh: triệu chứng hôm nay giống/khác hôm trước? Có pattern lặp lại không?
- Nếu triệu chứng tương tự ngày trước → hỏi diễn tiến ("Tình trạng đau đầu hôm qua giờ thế nào rồi?")
- Nếu triệu chứng mới → tập trung vào triệu chứng mới, không lặp câu hỏi cũ` : '- Chưa có lịch sử → hỏi tổng quát nhưng vẫn theo logic y khoa'}
${conditions ? `- Bệnh nền ${conditions} → mỗi câu hỏi phải liên hệ với bệnh nền khi phù hợp` : ''}

Format câu hỏi tiếp: {"isDone":false,"question":"...","options":["...","...","..."]}
Format kết luận (JSON thuần, không markdown):
{"isDone":true,"summary":"1 câu tóm tắt vấn đề trọng tâm","severity":"low|medium|high","recommendation":"lời khuyên ấm áp 1-2 câu","needsDoctor":true|false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":3,"closeMessage":"Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."}

LANGUAGE: All output (question, options, summary, recommendation, closeMessage) MUST be in ${lang === 'en' ? 'English' : 'Vietnamese'}.`;
  }

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: systemPrompt }],
    max_completion_tokens: 350,
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    // Gắn followUpHours mặc định nếu AI không trả về
    if (parsed.isDone && !parsed.followUpHours) {
      parsed.followUpHours = calcFollowUpHours(parsed.severity || 'medium', answerCount);
    }
    return parsed;
  } catch {
    return {
      isDone: true,
      summary: t('checkinAi.fallback_summary', lang),
      severity: 'medium',
      recommendation: t('checkinAi.fallback_recommendation', lang),
      needsDoctor: false,
      needsFamilyAlert: false,
      hasRedFlag: false,
      followUpHours: 3,
    };
  }
}

module.exports = { getNextTriageQuestion, buildContinuityMessage, calcFollowUpHours };
