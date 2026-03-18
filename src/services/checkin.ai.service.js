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
  previousTriageMessages = [],
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

  if (isFollowUp) {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 3: THEO DÕI DIỄN BIẾN (Symptom Progression)
    // Mỗi lần follow chỉ hỏi 2–3 câu theo 3 lớp cố định
    // ══════════════════════════════════════════════════════════════════

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ đang theo dõi định kỳ trong ngày.
Người dùng trước đó báo "${statusLabel}".

${contextBlock}

=== NHIỆM VỤ: ${status === 'fine' ? 'TỔNG KẾT CUỐI NGÀY' : 'THEO DÕI DIỄN BIẾN (SYMPTOM PROGRESSION)'} ===
${status === 'fine' ? `Người dùng cho biết họ ỔN. Đây là check-in tối — hỏi tổng kết ngày:
- Câu 1: "Hôm nay bạn cảm thấy thế nào?" hoặc "Ngày hôm nay của bạn thế nào?" (multiSelect=false, options: rất tốt / khá ổn / hơi mệt / không tốt lắm)
- Nếu user nói ổn → isDone=true, severity=low, recommendation ấm áp
- Nếu user nói mệt → hỏi thêm 1 câu rồi kết luận` : ''}
Tối đa ${maxQuestions} câu. Mỗi câu phải NỐI TIẾP câu trả lời trước.

⚡⚡⚡ TRƯỚC KHI TẠO CÂU HỎI MỚI — BẮT BUỘC ĐỌC HISTORY:
Đọc kỹ toàn bộ "PHIÊN HIỆN TẠI" ở trên. Kiểm tra:
1. User đã trả lời những gì? Đã khai triệu chứng nào?
2. Có dấu hiệu nguy hiểm không? (đau ngực, khó thở, hoa mắt, tức ngực, run tay, vã mồ hôi)
3. User đã nói "đã đỡ" chưa?

⚡ QUY TẮC CỨNG — PHẢI TUÂN THỦ:
- Nếu user ĐÃ báo BẤT KỲ dấu hiệu nguy hiểm nào (đau ngực, khó thở, tức ngực, hoa mắt nặng) → BẮT BUỘC isDone=true, hasRedFlag=true, needsDoctor=true, severity=high. KHÔNG HỎI THÊM.
- Nếu user nói ĐÃ ĐỠ → BẮT BUỘC isDone=true, progression=improved. KHÔNG HỎI THÊM.
- Nếu user đã trả lời triệu chứng ở câu trước → KHÔNG hỏi lại triệu chứng. Chuyển sang lớp tiếp theo.
- KHÔNG BAO GIỜ đưa ra options trùng với câu trả lời user đã chọn trước đó.

AI hỏi theo 3 LỚP (mỗi lớp chỉ hỏi 1 lần, KHÔNG lặp):

LỚP 1 — TRẠNG THÁI HIỆN TẠI (multiSelect=false) — HỎI TRƯỚC TIÊN
  Nhắc lại triệu chứng CỤ THỂ từ lần trước
  Ví dụ: "Tình trạng đau đầu và chóng mặt lúc sáng giờ thế nào rồi?"
  Options: đã đỡ hơn / vẫn như cũ / mệt hơn trước

LỚP 2 — TRIỆU CHỨNG MỚI (multiSelect=true) — CHỈ nếu chưa đỡ VÀ chưa hỏi
  Ví dụ: "Ngoài đau đầu, bạn có thêm triệu chứng nào khác không?"
  Options: triệu chứng MỚI (KHÔNG lặp lại triệu chứng đã biết) + "không có gì thêm"

LỚP 3 — HÀNH ĐỘNG (multiSelect=true) — CHỈ nếu chưa kết luận VÀ chưa hỏi
  Ví dụ: "Bạn đã nghỉ ngơi hoặc ăn uống gì chưa?"

=== KẾT LUẬN ===
✓ ĐÃ ĐỠ: isDone=true, progression=improved, followUpHours: 6–8
✓ VẪN VẬY: isDone=true, progression=same, followUpHours: 3–4
✓ NẶNG HƠN + CÓ RED FLAG: isDone=true, progression=worsened, hasRedFlag=true, needsDoctor=true, followUpHours: 1
✓ NẶNG HƠN + KHÔNG RED FLAG: isDone=true, progression=worsened, followUpHours: 1–2

=== NGUYÊN TẮC ===
- ĐỌC KỸ history trước khi tạo câu hỏi — KHÔNG hỏi lại điều đã biết
- KHÔNG đưa options trùng với câu trả lời trước
- Mỗi lớp chỉ hỏi TỐI ĐA 1 lần — nếu đã hỏi lớp đó rồi → chuyển sang lớp tiếp hoặc kết luận
- ⚠️ GIỚI HẠN: ${answerCount}/${maxQuestions} câu. ${answerCount >= maxQuestions - 1 ? '→ CÂU CUỐI — BẮT BUỘC isDone=true!' : ''}
- Kết thúc bằng câu quan tâm: "Tôi sẽ hỏi lại bạn sau nhé."

Respond in JSON only.
⚠️ BẮT BUỘC: "options" phải là mảng có ít nhất 2 phần tử. KHÔNG BAO GIỜ trả options rỗng [].
Ví dụ cho câu hỏi thời điểm: "options":["vừa mới","vài giờ trước","từ sáng","từ hôm qua"]
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2","opt3"],"multiSelect":true|false}
Format kết luận: {"isDone":true,"progression":"improved|same|worsened","hasRedFlag":false,"summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"followUpHours":3}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;

  } else {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 2: LÀM RÕ TÌNH TRẠNG (Clinical Interview)
    // Hỏi theo tư duy bác sĩ — mỗi câu nối tiếp câu trước
    // ══════════════════════════════════════════════════════════════════

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ AI, hỏi thăm như bác sĩ gia đình.
Người dùng vừa cho biết họ "${statusLabel}" (đã xác định — KHÔNG hỏi lại).

${contextBlock}

=== NHIỆM VỤ: LÀM RÕ TÌNH TRẠNG ===
Tối đa ${maxQuestions} câu. DỪNG NGAY khi đủ thông tin.
${isVeryUnwell ? '⚡ RẤT MỆT → ưu tiên phát hiện dấu hiệu nguy hiểm sớm!' : ''}

⚡⚡⚡ TRƯỚC KHI TẠO CÂU HỎI MỚI — BẮT BUỘC ĐỌC HISTORY:
Đọc kỹ toàn bộ "PHIÊN HIỆN TẠI" ở trên. Kiểm tra:
1. User đã trả lời những gì? Triệu chứng nào đã khai?
2. Có dấu hiệu nguy hiểm trong câu trả lời không? (đau ngực, khó thở, tức ngực, hoa mắt, run tay, vã mồ hôi)
3. Đã hỏi loại câu hỏi nào rồi? (triệu chứng / onset / diễn tiến / red flag / nguyên nhân / hành động)

⚡ QUY TẮC CỨNG — BẮT BUỘC TUÂN THỦ:
- Nếu user ĐÃ báo BẤT KỲ dấu hiệu nguy hiểm nào (đau ngực, khó thở, tức ngực, hoa mắt nặng, đau ngực lan ra cánh tay) → BẮT BUỘC trả isDone=true, hasRedFlag=true, needsDoctor=true, severity=high, needsFamilyAlert=true. KHÔNG HỎI THÊM.
- Nếu user đã trả lời triệu chứng ở câu trước → KHÔNG hỏi lại triệu chứng. Chuyển sang khai thác sâu.
- KHÔNG BAO GIỜ đưa options trùng với câu trả lời user đã chọn ở câu trước.
- Mỗi loại câu hỏi chỉ hỏi TỐI ĐA 1 lần — nếu đã hỏi triệu chứng rồi → KHÔNG hỏi lại triệu chứng.

AI hỏi → user trả lời → AI hiểu → AI hỏi tiếp ĐÚNG câu tiếp theo.
Mỗi câu hỏi PHẢI nối tiếp logic từ câu trả lời trước. Hỏi như bác sĩ đang trò chuyện.

=== MẪU TƯ DUY HỎI BỆNH (Question Templates) ===
Chọn mẫu phù hợp DỰA TRÊN câu trả lời trước. KHÔNG hỏi theo thứ tự cố định.

MẪU 1 — XÁC ĐỊNH TRIỆU CHỨNG (dùng khi chưa biết triệu chứng cụ thể)
  Mục tiêu: biết user đang gặp gì
  Cách hỏi: hỏi triệu chứng phổ biến, cho user lựa chọn
  multiSelect=true (có thể gặp nhiều triệu chứng)
  Ví dụ: "Bạn đang gặp tình trạng nào?" | mệt mỏi / chóng mặt / đau đầu / buồn nôn / không rõ

MẪU 2 — KHAI THÁC SÂU (dùng SAU khi biết triệu chứng)
  Mục tiêu: hiểu rõ hơn về triệu chứng đã khai — thời điểm, mức độ, vị trí
  Cách hỏi: NHẮC LẠI triệu chứng cụ thể user vừa nói trong câu hỏi
  multiSelect=false
  Ví dụ: "Đau đầu và chóng mặt bắt đầu từ khi nào?" / "Mức độ đau đầu của bạn thế nào?"

MẪU 3 — DIỄN TIẾN (dùng khi đã biết onset)
  Mục tiêu: triệu chứng đang cải thiện hay xấu đi
  Cách hỏi: so sánh với thời điểm bắt đầu
  multiSelect=false
  Ví dụ: "Từ sáng đến giờ, tình trạng đau đầu có thay đổi không?"

MẪU 4 — PHÁT HIỆN NGUY CƠ (dùng khi triệu chứng nặng hoặc đang xấu đi)
  Mục tiêu: phát hiện dấu hiệu nguy hiểm LIÊN QUAN đến triệu chứng đã khai
  Cách hỏi: hỏi dấu hiệu nguy hiểm CỤ THỂ cho loại triệu chứng đó
  multiSelect=true
  Ví dụ: "Ngoài đau đầu, bạn có hoa mắt, khó thở hoặc tức ngực không?"
  ⚠️ KHÔNG hỏi red flag chung chung — phải liên quan đến triệu chứng user đã khai

MẪU 5 — TÌM NGUYÊN NHÂN (dùng khi cần hiểu bối cảnh)
  Mục tiêu: giúp user nhận ra nguyên nhân, cá nhân hoá lời khuyên
  multiSelect=true
  Ví dụ: "Bạn nghĩ điều gì có thể gây ra tình trạng này?" | ngủ ít / bỏ bữa / căng thẳng / không rõ

MẪU 6 — HÀNH ĐỘNG ĐÃ LÀM (dùng trước khi kết luận)
  Mục tiêu: biết user đã xử lý gì, tránh lời khuyên trùng
  multiSelect=true
  Ví dụ: "Bạn đã làm gì để cải thiện chưa?" | nghỉ ngơi / ăn uống / uống thuốc / chưa làm gì

=== VÍ DỤ FLOW ĐÚNG ===
User chọn "hơi mệt" →
  AI: "Bạn đang gặp tình trạng nào?" (MẪU 1, multiSelect=true)
User: "mệt mỏi, đau đầu" →
  AI: "Tình trạng mệt mỏi và đau đầu bắt đầu từ khi nào?" (MẪU 2, multiSelect=false) ← hỏi về ĐÚNG triệu chứng
User: "từ sáng" →
  AI: "Từ sáng đến giờ có nặng hơn không?" (MẪU 3, multiSelect=false) ← tiếp tục cùng chủ đề
User: "có vẻ nặng hơn" →
  AI: "Ngoài mệt và đau đầu, bạn có hoa mắt hoặc khó thở không?" (MẪU 4, multiSelect=true) ← red flag LIÊN QUAN
→ Kết luận dựa trên toàn bộ thông tin.

=== VÍ DỤ SAI ===
❌ User: "sốt, đau họng" → AI: "Mức độ mệt thế nào?" (nhảy sang severity khi chưa khai thác sốt/đau họng)
❌ User: "từ sáng" → AI: "Bạn có run tay, vã mồ hôi?" (nhảy sang red flag chung chung)
❌ User: "đau đầu" → AI: "Bạn nghĩ do gì?" (nhảy sang nguyên nhân khi chưa hỏi onset/diễn tiến)

=== CONTINUITY CHECK (Perceived Care Loop) ===
${prevCheckinsStr ? `User có lịch sử check-in gần đây → ĐỌC KỸ:
- Nếu triệu chứng tương tự ngày trước → nhắc lại: "Hôm qua bạn có nói đau đầu. Hôm nay tình trạng thế nào?"
- Nếu triệu chứng mới → tập trung vào triệu chứng mới
- Tạo cảm giác AI đang thật sự theo dõi liên tục` : '- Chưa có lịch sử → hỏi tổng quát theo logic y khoa'}
${conditions ? `- Bệnh nền ${conditions} → câu hỏi liên hệ với bệnh nền khi phù hợp` : ''}

=== NGUYÊN TẮC BẮT BUỘC ===
1. KHÔNG hỏi Chief Complaint (đã biết: "${statusLabel}")
2. KHÔNG hỏi thông tin đã có từ profile / dữ liệu / lịch sử
3. KHÔNG lặp câu hỏi đã hỏi trong phiên — ĐỌC KỸ history
4. KHÔNG đưa options trùng với câu trả lời đã chọn ở câu trước
5. Mỗi loại câu hỏi chỉ hỏi TỐI ĐA 1 lần (triệu chứng 1 lần, onset 1 lần, diễn tiến 1 lần...)
6. Mỗi câu PHẢI nhắc lại triệu chứng cụ thể user đã nói
7. ⚡ Nếu user báo red flag (đau ngực, khó thở, tức ngực, hoa mắt) → isDone=true NGAY, hasRedFlag=true, needsDoctor=true
8. Khi kết luận → câu ấm áp: "Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."
9. ⚠️ GIỚI HẠN: ${answerCount}/${maxQuestions} câu. ${answerCount >= maxQuestions - 1 ? '→ CÂU CUỐI — BẮT BUỘC isDone=true!' : ''}
10. Đủ thông tin → KẾT LUẬN NGAY (isDone=true)

Respond in JSON only.
⚠️ BẮT BUỘC: "options" phải là mảng có ít nhất 2 phần tử. KHÔNG BAO GIỜ trả options rỗng [].
Ví dụ cho câu hỏi thời điểm: "options":["vừa mới","vài giờ trước","từ sáng","từ hôm qua"]
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2","opt3"],"multiSelect":true|false}
Format kết luận: {"isDone":true,"summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":3,"closeMessage":"Tôi sẽ hỏi lại tình trạng của bạn sau X tiếng nhé."}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;
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
