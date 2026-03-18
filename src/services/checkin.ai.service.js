/**
 * Checkin AI Service — Asinu Health Companion
 *
 * Daily Question Engine theo nguyên tắc y khoa:
 *   initial  — buổi sáng: Clinical Interview 9 TYPE, tối đa 8 câu, tối thiểu 3 câu
 *   followup — theo dõi định kỳ: 3-layer Q&A (Status / Symptoms / Actions), tối đa 3 câu, tối thiểu 2 câu
 *
 * 9 TYPE câu hỏi y khoa:
 *   1. Khoanh vùng (Chief Complaint) — đã xử lý bằng status select
 *   2. Định lượng nhanh (Severity Check)
 *   3. Xác định triệu chứng (Symptom Identification)
 *   4. Thời điểm xuất hiện (Onset Question)
 *   5. Diễn tiến (Progression Question)
 *   6. Phát hiện nguy cơ (Red Flag Question)
 *   7. Tìm nguyên nhân (Cause Exploration)
 *   8. Hành động đã làm (Action Taken)
 *   9. Thiết lập theo dõi (Monitoring Setup)
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
 */
async function getNextTriageQuestion({
  status,
  phase = 'initial',
  lang = 'vi',
  profile,
  healthContext = {},
  previousAnswers = [],
  previousSessionSummary = null,
  previousTriageMessages = [],
}) {
  const answerCount = previousAnswers.length;
  const isVeryUnwell = status === 'very_tired';
  const isFollowUp = phase === 'followup';

  // Giới hạn câu hỏi theo phase
  const maxQuestions = isFollowUp ? 3 : (isVeryUnwell ? 6 : 8);
  const minQuestions = isFollowUp ? 2 : 3; // TỐI THIỂU câu hỏi trước khi cho phép isDone

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

  const statusLabel = status === 'very_tired' ? 'rất không khoẻ'
    : status === 'specific_concern' ? 'có triệu chứng cụ thể'
    : 'hơi không khoẻ';

  const prevTriageDetail = previousTriageMessages.length
    ? `Chi tiết Q&A lần trước trong ngày:\n${previousTriageMessages.map((m, i) => `  Q${i + 1}: "${m.question}" → "${m.answer}"`).join('\n')}`
    : '';

  const prevSummary = previousSessionSummary
    ? `Tóm tắt lần trước: "${previousSessionSummary}"`
    : '';

  // ── Shared context block ──
  const contextBlock = `=== THÔNG TIN NGƯỜI DÙNG ===
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
- Nhóm: ${profile.user_group || 'wellness'}
${healthDataSection}
${prevCheckinsSection}
${prevSummary}
${prevTriageDetail}

=== PHIÊN HIỆN TẠI (${answerCount}/${maxQuestions} câu đã hỏi) ===
${historyText}`;

  // ── Minimum question enforcement ──
  const minQRule = answerCount < minQuestions
    ? `\n⛔ CHƯA ĐỦ CÂU HỎI: Mới hỏi ${answerCount}/${minQuestions} câu tối thiểu. BẮT BUỘC isDone=false. Phải hỏi thêm ít nhất ${minQuestions - answerCount} câu nữa trước khi kết luận (TRỪ KHI phát hiện red flag nguy hiểm).`
    : '';

  if (isFollowUp) {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 3: THEO DÕI DIỄN BIẾN (Symptom Progression)
    // Follow-up định kỳ: 3 lớp câu hỏi, 2-3 câu/lần
    // ══════════════════════════════════════════════════════════════════

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ đang theo dõi định kỳ trong ngày.
Người dùng trước đó báo "${statusLabel}".

${contextBlock}
${minQRule}

=== NHIỆM VỤ: ${status === 'fine' ? 'TỔNG KẾT CUỐI NGÀY' : 'THEO DÕI DIỄN BIẾN (SYMPTOM PROGRESSION)'} ===
${status === 'fine' ? `Người dùng cho biết họ ỔN. Đây là check-in tối — hỏi tổng kết ngày:
- Câu 1: "Hôm nay bạn cảm thấy thế nào?" (multiSelect=false, options: rất tốt / khá ổn / hơi mệt / không tốt lắm)
- Nếu user nói ổn → hỏi thêm 1 câu về thói quen rồi isDone=true
- Nếu user nói mệt → hỏi thêm 1-2 câu rồi kết luận` : ''}

=== CÁCH FOLLOW ĐÚNG CHUẨN Y KHOA ===
Bác sĩ khi follow bệnh nhân luôn hỏi: "Hiện tại bạn thấy thế nào so với lúc trước?"
Chỉ câu này thôi đã giúp hiểu diễn tiến bệnh.

AI hỏi theo 3 LỚP (mỗi lớp chỉ hỏi 1 lần, KHÔNG lặp):

LỚP 1 — TRẠNG THÁI HIỆN TẠI (multiSelect=false) — HỎI TRƯỚC TIÊN
  Nhắc lại triệu chứng CỤ THỂ từ lần trước (Perceived Care Loop)
  Ví dụ: "Tình trạng đau đầu và chóng mặt lúc sáng giờ thế nào rồi?"
  Options: đã đỡ hơn / vẫn như cũ / mệt hơn trước

LỚP 2 — TRIỆU CHỨNG MỚI (multiSelect=true) — CHỈ nếu chưa đỡ VÀ chưa hỏi
  Ví dụ: "Ngoài đau đầu, bạn có thêm triệu chứng nào khác không?"
  Options: triệu chứng MỚI + "không có gì thêm"
  ⚠️ Nếu có dấu hiệu nguy hiểm (khó thở, đau ngực, tức ngực, hoa mắt) → isDone=true, hasRedFlag=true NGAY

LỚP 3 — HÀNH ĐỘNG (multiSelect=true) — CHỈ nếu chưa kết luận VÀ chưa hỏi
  Ví dụ: "Bạn đã nghỉ ngơi hoặc ăn uống gì chưa?"

=== KẾT LUẬN (chỉ sau khi đã hỏi ít nhất ${minQuestions} câu, TRỪ red flag) ===
✓ ĐÃ ĐỠ: isDone=true, progression=improved, followUpHours: 6–8
✓ VẪN VẬY: isDone=true, progression=same, followUpHours: 3–4, recommendation: "Tôi sẽ tiếp tục theo dõi. Hỏi lại sau vài giờ nữa."
✓ NẶNG HƠN + CÓ RED FLAG: isDone=true, hasRedFlag=true, needsDoctor=true, severity=high, followUpHours: 1
✓ NẶNG HƠN + KHÔNG RED FLAG: isDone=true, progression=worsened, followUpHours: 1–2

=== NGUYÊN TẮC ===
- ĐỌC KỸ history trước khi tạo câu hỏi — KHÔNG hỏi lại điều đã biết
- KHÔNG đưa options trùng với câu trả lời trước
- Mỗi lớp chỉ hỏi TỐI ĐA 1 lần
- ${answerCount < minQuestions ? `⛔ MỚI HỎI ${answerCount} CÂU — CHƯA ĐỦ ${minQuestions} CÂU TỐI THIỂU → isDone=false BẮT BUỘC` : ''}
- ${answerCount >= maxQuestions - 1 ? `⚠️ CÂU CUỐI (${answerCount + 1}/${maxQuestions}) — BẮT BUỘC isDone=true!` : `Đã hỏi ${answerCount}/${maxQuestions} câu.`}
- Kết thúc bằng câu quan tâm: "Tôi sẽ hỏi lại bạn sau nhé."

Respond in JSON only.
⚠️ BẮT BUỘC: "options" phải là mảng có ít nhất 2 phần tử. KHÔNG BAO GIỜ trả options rỗng [].
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2","opt3"],"multiSelect":true|false}
Format kết luận: {"isDone":true,"progression":"improved|same|worsened","hasRedFlag":false,"summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"followUpHours":3}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;

  } else {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 2: LÀM RÕ TÌNH TRẠNG (Clinical Interview — 9 TYPE y khoa)
    // Hỏi theo tư duy bác sĩ — mỗi câu nối tiếp câu trước
    // Tối thiểu 3 câu, tối đa 8 câu
    // ══════════════════════════════════════════════════════════════════

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ AI, hỏi thăm như bác sĩ gia đình.
Người dùng vừa cho biết họ "${statusLabel}" (TYPE 1 — Chief Complaint đã xác định — KHÔNG hỏi lại).

${contextBlock}
${minQRule}

=== NHIỆM VỤ: LÀM RÕ TÌNH TRẠNG (Clinical Interview) ===
Hỏi tối thiểu ${minQuestions} câu, tối đa ${maxQuestions} câu.
${isVeryUnwell ? '⚡ RẤT MỆT → ưu tiên phát hiện dấu hiệu nguy hiểm, nhưng VẪN phải hỏi ít nhất 3 câu!' : ''}

⚡⚡⚡ TRƯỚC KHI TẠO CÂU HỎI MỚI — BẮT BUỘC ĐỌC HISTORY:
1. User đã trả lời những gì? Triệu chứng nào đã khai?
2. Có dấu hiệu nguy hiểm không? (đau ngực, khó thở, tức ngực, hoa mắt, vã mồ hôi)
3. Đã hỏi TYPE câu hỏi nào rồi? → chuyển sang TYPE tiếp theo

=== 9 TYPE CÂU HỎI Y KHOA (Question Templates) ===
Dạy AI cách suy nghĩ như bác sĩ, không đưa câu hỏi cố định.
Chọn TYPE phù hợp DỰA TRÊN câu trả lời trước. Mỗi TYPE chỉ hỏi TỐI ĐA 1 lần.

TYPE 1 — KHOANH VÙNG (Chief Complaint) — ĐÃ BIẾT: "${statusLabel}" → KHÔNG HỎI LẠI

TYPE 2 — ĐỊNH LƯỢNG NHANH (Severity Check) — dùng đầu tiên
  Mục tiêu: biết mức độ khó chịu
  multiSelect=false
  Ví dụ: "Mức độ mệt của bạn hiện tại thế nào?" | nhẹ / trung bình / khá nặng / rất nặng

TYPE 3 — XÁC ĐỊNH TRIỆU CHỨNG (Symptom Identification) — dùng sau severity
  Mục tiêu: biết user đang gặp triệu chứng gì cụ thể
  multiSelect=true (có thể gặp nhiều triệu chứng)
  Ví dụ: "Bạn đang gặp tình trạng nào?" | mệt mỏi / chóng mặt / đau đầu / buồn nôn / khát nước / không rõ

TYPE 4 — THỜI ĐIỂM XUẤT HIỆN (Onset Question) — dùng SAU khi biết triệu chứng
  Mục tiêu: biết triệu chứng bắt đầu khi nào
  multiSelect=false
  Ví dụ: "Tình trạng [triệu chứng cụ thể] bắt đầu từ khi nào?" | vừa mới / vài giờ trước / từ sáng / từ hôm qua

TYPE 5 — DIỄN TIẾN (Progression Question) — dùng khi đã biết onset
  Mục tiêu: triệu chứng đang cải thiện hay xấu đi
  multiSelect=false
  Ví dụ: "Từ [thời điểm] đến giờ, tình trạng [triệu chứng] có thay đổi không?" | đang đỡ dần / vẫn giống lúc đầu / có vẻ nặng hơn

TYPE 6 — PHÁT HIỆN NGUY CƠ (Red Flag Question) — dùng khi triệu chứng nặng hoặc xấu đi
  Mục tiêu: phát hiện dấu hiệu nguy hiểm LIÊN QUAN đến triệu chứng đã khai
  multiSelect=true
  Ví dụ: "Ngoài [triệu chứng], bạn có gặp tình trạng nào?" | hoa mắt / vã mồ hôi / khó thở / đau ngực / không có
  ⚠️ Nếu user báo red flag → isDone=true NGAY, hasRedFlag=true, needsDoctor=true, severity=high

TYPE 7 — TÌM NGUYÊN NHÂN (Cause Exploration) — dùng khi cần hiểu bối cảnh
  Mục tiêu: giúp user nhận ra nguyên nhân, cá nhân hoá lời khuyên
  multiSelect=true
  Ví dụ: "Bạn nghĩ điều gì có thể dẫn đến tình trạng này?" | ngủ ít / bỏ bữa / căng thẳng / quên uống thuốc / không rõ

TYPE 8 — HÀNH ĐỘNG ĐÃ LÀM (Action Taken) — dùng trước khi kết luận
  Mục tiêu: biết user đã xử lý gì, tránh lời khuyên trùng
  multiSelect=true
  Ví dụ: "Bạn đã làm gì để cải thiện chưa?" | nghỉ ngơi / ăn uống / uống nước / uống thuốc / chưa làm gì

TYPE 9 — THIẾT LẬP THEO DÕI (Monitoring Setup) — dùng khi kết luận
  Mục tiêu: thiết lập follow-up, tạo cảm giác AI đang theo dõi (Perceived Care Loop)
  Đây KHÔNG phải câu hỏi — đây là phần kết luận. Gắn vào "closeMessage" hoặc "recommendation".
  Ví dụ: "Tôi sẽ hỏi lại tình trạng của bạn sau X giờ nhé."

=== FLOW ĐÚNG CHUẨN (ví dụ user báo "hơi mệt") ===
Câu 1: TYPE 2 — "Mức độ mệt của bạn hiện tại thế nào?" (severity)
Câu 2: TYPE 3 — "Bạn đang gặp triệu chứng nào?" (symptoms) ← multiSelect=true
Câu 3: TYPE 4 — "Tình trạng mệt mỏi và đau đầu bắt đầu từ khi nào?" (onset) ← nhắc đúng triệu chứng
Câu 4: TYPE 5 — "Từ sáng đến giờ có nặng hơn không?" (progression)
Câu 5: TYPE 7 — "Bạn nghĩ nguyên nhân có thể là gì?" (cause)
→ Kết luận với TYPE 9 trong closeMessage

=== FLOW KHI "RẤT MỆT" ===
Câu 1: TYPE 3 — "Bạn đang gặp triệu chứng nào?" (ưu tiên biết triệu chứng trước)
Câu 2: TYPE 6 — "Ngoài [triệu chứng], bạn có hoa mắt, khó thở hoặc đau ngực không?" (red flag sớm)
Câu 3: TYPE 4 — "Tình trạng này bắt đầu từ khi nào?" (onset)
→ Nếu không có red flag: hỏi thêm TYPE 7/8 rồi kết luận
→ Nếu có red flag: isDone=true NGAY

=== VÍ DỤ SAI ===
❌ Hỏi 1 câu rồi isDone=true (PHẢI hỏi ít nhất ${minQuestions} câu!)
❌ User: "mệt mỏi" → AI isDone=true (thiếu onset, severity, progression!)
❌ User: "đau đầu" → AI: "Bạn nghĩ do gì?" (nhảy sang TYPE 7 khi chưa hỏi TYPE 4/5)
❌ Lặp lại triệu chứng user đã nói trong options

=== CONTINUITY CHECK (Perceived Care Loop) ===
${prevCheckinsStr ? `User có lịch sử check-in gần đây → ĐỌC KỸ:
- Nếu triệu chứng tương tự ngày trước → nhắc lại trong câu hỏi: "Hôm qua bạn có nói đau đầu. Hôm nay tình trạng thế nào?"
- Nếu triệu chứng mới → tập trung vào triệu chứng mới
- Tạo cảm giác AI đang thật sự theo dõi liên tục` : '- Chưa có lịch sử → hỏi tổng quát theo logic y khoa'}
${conditions ? `- Bệnh nền ${conditions} → câu hỏi liên hệ với bệnh nền khi phù hợp` : ''}

=== NGUYÊN TẮC BẮT BUỘC ===
1. KHÔNG hỏi Chief Complaint (đã biết: "${statusLabel}")
2. KHÔNG hỏi thông tin đã có từ profile / dữ liệu / lịch sử
3. KHÔNG lặp câu hỏi / TYPE đã hỏi trong phiên — ĐỌC KỸ history
4. KHÔNG đưa options trùng với câu trả lời đã chọn ở câu trước
5. Mỗi TYPE chỉ hỏi TỐI ĐA 1 lần
6. Mỗi câu PHẢI nhắc lại triệu chứng cụ thể user đã nói (nếu đã biết)
7. ⚡ Nếu user báo red flag → isDone=true NGAY, hasRedFlag=true, needsDoctor=true (ngoại lệ duy nhất cho min question)
8. Khi kết luận → TYPE 9: "Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."
9. ${answerCount < minQuestions ? `⛔ MỚI HỎI ${answerCount} CÂU — CHƯA ĐỦ ${minQuestions} CÂU TỐI THIỂU → isDone PHẢI là false (trừ red flag)!` : `Đã hỏi ${answerCount}/${maxQuestions} câu.`}
10. ${answerCount >= maxQuestions - 1 ? `⚠️ CÂU CUỐI (${answerCount + 1}/${maxQuestions}) — BẮT BUỘC isDone=true!` : 'Tiếp tục hỏi theo TYPE tiếp theo.'}

Respond in JSON only.
⚠️ BẮT BUỘC: "options" phải là mảng có ít nhất 2 phần tử. KHÔNG BAO GIỜ trả options rỗng [].
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2","opt3"],"multiSelect":true|false}
Format kết luận: {"isDone":true,"summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":3,"closeMessage":"Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;
  }

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: systemPrompt }],
    max_completion_tokens: 400,
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content || '{}';
  console.log(`[TriageAI] phase=${phase}, answers=${answerCount}/${maxQuestions}, min=${minQuestions}, raw:`, raw);
  try {
    let parsed = JSON.parse(raw);

    // ── Server-side enforcement: block early isDone ──
    if (parsed.isDone && answerCount < minQuestions && !parsed.hasRedFlag) {
      console.log(`[TriageAI] ⛔ Blocked early isDone (${answerCount}/${minQuestions} min). Forcing continue.`);
      // Force AI to continue — generate a fallback question
      parsed = {
        isDone: false,
        question: answerCount === 0
          ? (lang === 'en' ? "What symptoms are you experiencing?" : "Bạn đang gặp triệu chứng nào?")
          : (lang === 'en' ? "When did this start?" : "Tình trạng này bắt đầu từ khi nào?"),
        options: answerCount === 0
          ? (lang === 'en'
            ? ["fatigue", "dizziness", "headache", "nausea", "not sure"]
            : ["mệt mỏi", "chóng mặt", "đau đầu", "buồn nôn", "không rõ"])
          : (lang === 'en'
            ? ["just now", "a few hours ago", "since morning", "since yesterday"]
            : ["vừa mới", "vài giờ trước", "từ sáng", "từ hôm qua"]),
        multiSelect: answerCount === 0,
      };
    }

    // Gắn followUpHours mặc định nếu AI không trả về
    if (parsed.isDone && !parsed.followUpHours) {
      parsed.followUpHours = calcFollowUpHours(parsed.severity || 'medium', answerCount);
    }
    console.log(`[TriageAI] isDone=${parsed.isDone}, question=${parsed.question || 'N/A'}`);
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
