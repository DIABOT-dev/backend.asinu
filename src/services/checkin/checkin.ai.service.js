/**
 * Checkin AI Service — Asinu Health Companion
 *
 * Daily Question Engine theo nguyên tắc y khoa:
 *   initial  — buổi sáng: Clinical Interview 9 TYPE, tối đa 8 câu, tối thiểu 3 câu
 *   followup — theo dõi định kỳ: 3-layer Q&A (Status / Symptoms / Actions), tối đa 3 câu, tối thiểu 2 câu
 *
 * 11 TYPE câu hỏi y khoa:
 *   1. Khoanh vùng (Chief Complaint) — đã xử lý bằng status select
 *   2. Định lượng nhanh (Severity Check)
 *   3. Xác định triệu chứng (Symptom Identification)
 *   4. Thời điểm xuất hiện (Onset Question)
 *   5. Diễn tiến (Progression Question)
 *   6. Phát hiện nguy cơ (Red Flag Question)
 *   7. Tìm nguyên nhân (Cause Exploration)
 *   8. Hành động đã làm (Action Taken)
 *   9. Thiết lập theo dõi (Monitoring Setup)
 *  10. Tần suất/Pattern (Frequency) — G7 fix
 *  11. Kiểm tra thuốc (Medication Check) — G8 fix
 */

const OpenAI = require('openai');
const { t } = require('../../i18n');
const { filterTriageResult } = require('../ai/ai-safety.service');
const { logAiInteraction } = require('../ai/ai-logger.service');

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

// ─── Fallback questions (when OpenAI API fails) ─────────────────────────────

const FALLBACK_QUESTIONS = {
  initial: {
    vi: [
      // TYPE 2 — Severity (calibrated to "hơi mệt" — no "rất nặng" here)
      { question: 'Mức độ mệt của bạn hiện tại thế nào?', options: ['nhẹ', 'trung bình', 'khá nặng'], multiSelect: false },
      // TYPE 3 — Symptoms
      { question: 'Bạn đang gặp triệu chứng nào?', options: ['mệt mỏi', 'chóng mặt', 'đau đầu', 'buồn nôn', 'khát nước', 'không rõ'], multiSelect: true },
      // TYPE 4 — Onset
      { question: 'Tình trạng này bắt đầu từ khi nào?', options: ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua'], multiSelect: false },
      // TYPE 7 — Cause
      { question: 'Bạn nghĩ điều gì có thể dẫn đến tình trạng này?', options: ['ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ'], multiSelect: true },
      // TYPE 8 — Action
      { question: 'Bạn đã làm gì để cải thiện chưa?', options: ['nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì'], multiSelect: true },
    ],
    en: [
      { question: 'How severe is your tiredness right now?', options: ['mild', 'moderate', 'quite severe'], multiSelect: false },
      { question: 'What symptoms are you experiencing?', options: ['fatigue', 'dizziness', 'headache', 'nausea', 'thirst', 'not sure'], multiSelect: true },
      { question: 'When did this start?', options: ['just now', 'a few hours ago', 'since morning', 'since yesterday'], multiSelect: false },
      { question: 'What might have caused this?', options: ['lack of sleep', 'skipped meals', 'stress', 'missed medication', 'not sure'], multiSelect: true },
      { question: 'Have you done anything to feel better?', options: ['rested', 'ate something', 'drank water', 'took medication', 'nothing yet'], multiSelect: true },
    ],
  },
  followup: {
    vi: [
      { question: 'So với lần trước, bạn cảm thấy thế nào?', options: ['đã đỡ hơn', 'vẫn như cũ', 'mệt hơn trước'], multiSelect: false },
      { question: 'Bạn có thêm triệu chứng nào mới không?', options: ['đau đầu', 'chóng mặt', 'buồn nôn', 'khó thở', 'không có gì thêm'], multiSelect: true },
      { question: 'Bạn đã nghỉ ngơi hoặc ăn uống gì chưa?', options: ['đã nghỉ ngơi', 'đã ăn uống', 'đã uống thuốc', 'chưa làm gì'], multiSelect: true },
    ],
    en: [
      { question: 'Compared to before, how are you feeling now?', options: ['better', 'about the same', 'worse'], multiSelect: false },
      { question: 'Do you have any new symptoms?', options: ['headache', 'dizziness', 'nausea', 'shortness of breath', 'nothing new'], multiSelect: true },
      { question: 'Have you rested or eaten anything?', options: ['rested', 'ate something', 'took medication', 'nothing yet'], multiSelect: true },
    ],
  },
};

/**
 * Trả câu hỏi fallback khi OpenAI API fail.
 * Khi hết câu hỏi → trả isDone=true với summary mặc định.
 */
function getFallbackQuestion(status, phase, lang, previousAnswers = []) {
  const isFollowUp = phase === 'followup';
  const questionBank = isFollowUp ? FALLBACK_QUESTIONS.followup : FALLBACK_QUESTIONS.initial;
  const questions = questionBank[lang] || questionBank['vi'];
  const answerCount = previousAnswers.length;

  if (answerCount < questions.length) {
    return {
      isDone: false,
      question: questions[answerCount].question,
      options: questions[answerCount].options,
      multiSelect: questions[answerCount].multiSelect,
      _fallback: true,
    };
  }

  // All fallback questions exhausted → return done with summary
  const summaryVi = 'Asinu đã ghi nhận tình trạng của bạn qua các câu trả lời.';
  const summaryEn = 'Asinu has recorded your condition from your answers.';
  const recVi = 'Hãy nghỉ ngơi và theo dõi thêm. Asinu sẽ hỏi lại sau nhé.';
  const recEn = 'Please rest and monitor. Asinu will check back later.';

  return {
    isDone: true,
    summary: lang === 'en' ? summaryEn : summaryVi,
    severity: status === 'very_tired' ? 'high' : 'medium',
    recommendation: lang === 'en' ? recEn : recVi,
    needsDoctor: false,
    needsFamilyAlert: false,
    hasRedFlag: false,
    followUpHours: calcFollowUpHours(status === 'very_tired' ? 'high' : 'medium', answerCount),
    _fallback: true,
  };
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
  pool = null,
  userId = null,
}) {
  const answerCount = previousAnswers.length;
  const isVeryUnwell = status === 'very_tired';
  const isFollowUp = phase === 'followup';

  // Initial: hỏi kỹ 5-8 câu để hiểu rõ tình trạng
  // Follow-up: hỏi nhanh 2-3 câu vì đã biết context
  const maxQuestions = isFollowUp ? 3 : 8;
  const minQuestions = isFollowUp ? 2 : 5;

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

  // [G4 FIX] Detect dangerous vital signs and inject alert into context
  const vitalAlerts = [];
  const recentGlucose = healthContext.recentGlucose || [];
  const recentBP = healthContext.recentBP || [];
  if (recentGlucose.length > 0) {
    const latest = recentGlucose[0];
    if (latest.value > 250) vitalAlerts.push(`⚠️ GLUCOSE RẤT CAO: ${latest.value} ${latest.unit} → ưu tiên hỏi triệu chứng hạ/tăng đường huyết, severity tối thiểu HIGH`);
    else if (latest.value < 70) vitalAlerts.push(`⚠️ GLUCOSE RẤT THẤP: ${latest.value} ${latest.unit} → nguy cơ hạ đường huyết, severity tối thiểu HIGH`);
  }
  if (recentBP.length > 0) {
    const latest = recentBP[0];
    if (latest.systolic >= 180 || latest.diastolic >= 110) vitalAlerts.push(`⚠️ HUYẾT ÁP NGUY HIỂM: ${latest.systolic}/${latest.diastolic} → severity tối thiểu HIGH, hỏi đau đầu/hoa mắt/khó thở`);
  }

  const healthDataLines = [
    glucoseStr && `- Glucose 7 ngày gần đây: ${glucoseStr}`,
    bpStr      && `- Huyết áp 7 ngày gần đây: ${bpStr}`,
    weightStr  && `- Cân nặng: ${weightStr}`,
  ].filter(Boolean);

  const healthDataSection = healthDataLines.length
    ? `Dữ liệu sức khoẻ gần đây:\n${healthDataLines.join('\n')}${vitalAlerts.length ? '\n\n🚨 CẢNH BÁO CHỈ SỐ:\n' + vitalAlerts.join('\n') : ''}`
    : 'Chưa có dữ liệu sức khoẻ gần đây.';

  const prevCheckinsSection = prevCheckinsStr
    ? `Lịch sử check-in gần nhất:\n${prevCheckinsStr}`
    : 'Chưa có lịch sử check-in trước.';

  const historyText = previousAnswers.length
    ? previousAnswers.map((a, i) => `Q${i + 1}: "${a.question}" → "${a.answer}"`).join('\n')
    : '(Chưa hỏi câu nào)';

  // ── Pre-compute: TYPEs đã hỏi & triệu chứng đã biết ──
  // [G3 FIX] Also scan previousTriageMessages (initial triage) so follow-up doesn't re-ask
  const usedTypes = new Set();
  const knownSymptoms = new Set();

  const allAnswers = [...previousAnswers, ...previousTriageMessages.map(m => ({ question: m.question, answer: m.answer }))];
  for (const a of allAnswers) {
    const q = (a.question || '').toLowerCase();
    const ans = (a.answer || '').toLowerCase();

    // Detect TYPE from question content
    if (q.includes('mức độ') || q.includes('how severe') || q.includes('khó chịu')) usedTypes.add(2);
    if (q.includes('triệu chứng') || q.includes('symptoms') || q.includes('tình trạng nào')) usedTypes.add(3);
    if (q.includes('bắt đầu') || q.includes('when did') || q.includes('từ khi nào') || q.includes('từ bao giờ')) usedTypes.add(4);
    if (q.includes('thay đổi') || q.includes('diễn tiến') || q.includes('progression') || q.includes('có nặng hơn') || q.includes('có đỡ')) usedTypes.add(5);
    if (q.includes('nguy hiểm') || q.includes('khó thở') || q.includes('đau ngực') || q.includes('red flag') || q.includes('dấu hiệu nào')) usedTypes.add(6);
    if (q.includes('nguyên nhân') || q.includes('cause') || q.includes('dẫn đến')) usedTypes.add(7);
    if (q.includes('đã làm') || q.includes('action') || q.includes('cải thiện') || q.includes('have you done')) usedTypes.add(8);
    if (q.includes('thường xuyên') || q.includes('hay bị') || q.includes('how often') || q.includes('lần đầu')) usedTypes.add(10);
    if (q.includes('uống thuốc') || q.includes('medication') || q.includes('thuốc')) usedTypes.add(11);

    // Extract symptoms from answers to TYPE 3 / TYPE 6
    if (usedTypes.has(3) || usedTypes.has(6)) {
      ans.split(/,|;/).map(s => s.trim()).filter(Boolean).forEach(s => knownSymptoms.add(s));
    }
  }

  const usedTypesStr = usedTypes.size > 0
    ? `TYPEs đã dùng trong phiên này: ${[...usedTypes].map(n => `TYPE ${n}`).join(', ')} → KHÔNG hỏi lại các TYPE này.`
    : 'Chưa hỏi TYPE nào.';

  const knownSymptomsStr = knownSymptoms.size > 0
    ? `Triệu chứng user đã khai: ${[...knownSymptoms].join(', ')} → KHÔNG đưa vào options ở câu hỏi tiếp theo.`
    : '';

  // ── Tạo system prompt theo phase ──
  let systemPrompt;

  const isSpecificConcern = status === 'specific_concern';
  const statusLabel = status === 'very_tired' ? 'rất không khoẻ'
    : isSpecificConcern ? 'có triệu chứng cụ thể muốn hỏi'
    : 'hơi không khoẻ';

  const prevTriageDetail = previousTriageMessages.length
    ? `Chi tiết Q&A lần trước trong ngày:\n${previousTriageMessages.map((m, i) => `  Q${i + 1}: "${m.question}" → "${m.answer}"`).join('\n')}`
    : '';

  const prevSummary = previousSessionSummary
    ? `Tóm tắt lần trước: "${previousSessionSummary}"`
    : '';

  // [G8] Medication status
  const tookMed = healthContext.tookMedicationToday;
  const medStatus = conditions
    ? (tookMed ? '- Thuốc hôm nay: ĐÃ uống ✓' : '- Thuốc hôm nay: CHƯA uống ⚠️ → cân nhắc hỏi TYPE 11 nếu relevant')
    : '';

  // ── Shared context block ──
  const contextBlock = `=== THÔNG TIN NGƯỜI DÙNG ===
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
${medStatus}
${healthDataSection}
${prevCheckinsSection}
${prevSummary}
${prevTriageDetail}

=== PHIÊN HIỆN TẠI (${answerCount}/${maxQuestions} câu đã hỏi) ===
${historyText}

=== TRACKING (đọc trước khi tạo câu hỏi) ===
${usedTypesStr}
${knownSymptomsStr || '(Chưa biết triệu chứng cụ thể)'}
Còn lại tối đa: ${maxQuestions - answerCount} câu${answerCount >= maxQuestions - 1 ? ' — ĐÂY LÀ CÂU CUỐI, BẮT BUỘC isDone=true' : ''}.
${answerCount < minQuestions ? `⛔ CHƯA ĐỦ ${minQuestions} CÂU TỐI THIỂU — isDone PHẢI là false (trừ red flag).` : `✓ Đã đủ câu tối thiểu, có thể kết luận nếu đã rõ.`}`;

  const minQRule = ''; // đã tích hợp vào contextBlock, không cần inject riêng

  if (isFollowUp) {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 3: THEO DÕI DIỄN BIẾN (Symptom Progression)
    // Follow-up định kỳ: 3 lớp câu hỏi, 2-3 câu/lần
    // ══════════════════════════════════════════════════════════════════

    // Detect which follow-up layers have been used
    const usedLayers = new Set();
    for (const a of previousAnswers) {
      const q = a.question.toLowerCase();
      if (q.includes('so với') || q.includes('thế nào rồi') || q.includes('compared to') || q.includes('how are you now')) usedLayers.add(1);
      if (q.includes('triệu chứng') || q.includes('symptom') || q.includes('thêm') || q.includes('new')) usedLayers.add(2);
      if (q.includes('nghỉ ngơi') || q.includes('đã làm') || q.includes('rested') || q.includes('action')) usedLayers.add(3);
    }
    const layersLeft = [1, 2, 3].filter(l => !usedLayers.has(l));

    // Build initial symptom context from triage summary for follow-up
    const initialSymptomContext = previousSessionSummary
      ? `Triệu chứng ghi nhận ban đầu: "${previousSessionSummary}"`
      : (knownSymptomsStr || '');

    systemPrompt = `Bạn là Asinu — đang theo dõi sức khoẻ định kỳ.
Người dùng trước đó báo "${statusLabel}". ${initialSymptomContext}

${contextBlock}

=== NHIỆM VỤ: THEO DÕI DIỄN BIẾN ===
Hỏi theo thứ tự 3 LỚP (mỗi lớp tối đa 1 lần). Lớp chưa hỏi: ${layersLeft.length > 0 ? layersLeft.map(l => `LỚP ${l}`).join(', ') : 'đã hỏi hết → isDone=true'}.

LỚP 1 — TRẠNG THÁI (multiSelect=false) — hỏi TRƯỚC TIÊN${usedLayers.has(1) ? ' ✓ ĐÃ HỎI' : ''}
  Nhắc đúng triệu chứng từ lần trước: "Tình trạng [triệu chứng cụ thể] giờ thế nào rồi?"
  Options: đã đỡ nhiều / vẫn như cũ / mệt hơn trước

LỚP 2 — TRIỆU CHỨNG MỚI (multiSelect=true) — chỉ hỏi nếu chưa đỡ${usedLayers.has(2) ? ' ✓ ĐÃ HỎI' : ''}
  "Ngoài [triệu chứng đã biết], bạn có thêm dấu hiệu nào không?"
  Options chỉ gồm triệu chứng MỚI chưa khai + "không có gì thêm"
  ⚡ Nếu user báo: khó thở / đau ngực / hoa mắt / vã mồ hôi → isDone=true NGAY, hasRedFlag=true

LỚP 3 — HÀNH ĐỘNG (multiSelect=true) — hỏi trước khi kết luận${usedLayers.has(3) ? ' ✓ ĐÃ HỎI' : ''}
  "Bạn đã nghỉ ngơi hay làm gì để đỡ hơn chưa?"
  Options: nghỉ ngơi / ăn uống / uống thuốc / uống nước / chưa làm gì

=== KẾT LUẬN ===
✓ Lớp 1 trả lời "đã đỡ" → isDone=true ngay, progression=improved, severity=low, followUpHours=6
✓ Vẫn như cũ sau đủ câu → isDone=true, progression=same, severity=medium, followUpHours=3
✓ Nặng hơn + red flag → isDone=true, hasRedFlag=true, needsDoctor=true, severity=high, followUpHours=1
✓ Nặng hơn, không red flag → isDone=true, progression=worsened, severity=medium, followUpHours=2

⚠️ NGUYÊN TẮC:
- KHÔNG đưa vào options triệu chứng user đã khai
- KHÔNG lặp lớp đã hỏi (xem danh sách ✓ ở trên)
- Nhắc đúng tên triệu chứng user đã báo, không hỏi chung chung

Respond in JSON only. "options" có ít nhất 2 phần tử.
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2"],"multiSelect":true|false,"allowFreeText":false}
  Lớp 2 (triệu chứng mới): set "allowFreeText":true để user mô tả thêm.
Format kết luận: {"isDone":true,"progression":"improved|same|worsened","summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":3,"closeMessage":"Tôi sẽ hỏi lại bạn sau X tiếng nhé."}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;

  } else {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 2: LÀM RÕ TÌNH TRẠNG (Clinical Interview — 9 TYPE y khoa)
    // Hỏi theo tư duy bác sĩ — mỗi câu nối tiếp câu trước
    // Tối thiểu 3 câu, tối đa 8 câu
    // ══════════════════════════════════════════════════════════════════

    systemPrompt = `Bạn là Asinu — trợ lý sức khoẻ AI, hỏi như bác sĩ gia đình.
Người dùng báo: "${statusLabel}". TYPE 1 (Chief Complaint) đã rõ — KHÔNG hỏi lại.

${contextBlock}

=== THỨ TỰ CÂU HỎI (chọn TYPE tiếp theo chưa dùng, theo thứ tự ưu tiên) ===
${isSpecificConcern ? `
CÓ VẤN ĐỀ CỤ THỂ — user muốn hỏi/báo triệu chứng riêng:
① TYPE 3 — MÔ TẢ VẤN ĐỀ (multiSelect=true): "Bạn đang gặp vấn đề gì?" — câu hỏi MỞ, options bao gồm nhiều loại triệu chứng + "vấn đề khác" để user chọn
   Options: đau đầu / chóng mặt / đau bụng / đau ngực / khó thở / mất ngủ / lo lắng / da/tóc bất thường / vấn đề khác
② TYPE 4 — Onset: "Vấn đề này bắt đầu từ khi nào?"
③ TYPE 10 — TẦN SUẤT (multiSelect=false): "Tình trạng này có xảy ra thường xuyên không?"
   Options: lần đầu / thỉnh thoảng / hay bị / gần đây bị nhiều hơn
④ TYPE 5 — Diễn tiến: "Tình trạng đang thay đổi thế nào?"
⑤ TYPE 6 — Red flag nếu cần, hoặc TYPE 7 — Nguyên nhân
⑥ Kết luận` : isVeryUnwell ? `
RẤT MỆT — thứ tự ưu tiên:
① TYPE 3 — Triệu chứng (multiSelect=true): "Bạn đang gặp triệu chứng nào?" — hỏi TRƯỚC TIÊN
   Options MỚI (không trùng triệu chứng đã biết): mệt mỏi / chóng mặt / đau đầu / buồn nôn / tức ngực / khó thở / hoa mắt / vã mồ hôi / không rõ
② TYPE 6 — Red flag (multiSelect=true): "Ngoài [triệu chứng đã khai], bạn có thêm dấu hiệu nào không?"
   Options chỉ gồm: khó thở / đau ngực / tức ngực / hoa mắt / vã mồ hôi / ngất / không có
   ⚡ Nếu user chọn bất kỳ dấu hiệu nào (trừ "không có") → isDone=true NGAY, hasRedFlag=true, needsDoctor=true, severity=high
② TYPE 2 — Severity (multiSelect=false): "Mức độ nặng của bạn thế nào?"
   Options: trung bình / khá nặng / rất nặng
   Ánh xạ: "rất nặng" → severity=high (bắt buộc)
③ TYPE 4 — Onset (multiSelect=false): "Tình trạng [triệu chứng] bắt đầu từ khi nào?"
   Options: vừa mới / vài giờ trước / từ sáng / từ hôm qua
④ TYPE 7 — Nguyên nhân (multiSelect=true): nếu còn câu hỏi
⑤ Kết luận nếu đã đủ thông tin` : `
HƠI MỆT — thứ tự ưu tiên:
① TYPE 3 — Triệu chứng (multiSelect=true): "Bạn đang gặp triệu chứng nào?" — hỏi TRƯỚC TIÊN
   Options MỚI (không trùng triệu chứng đã biết): mệt mỏi / chóng mặt / đau đầu / buồn nôn / khát nước / ăn không ngon / không rõ
② TYPE 4 — Onset (multiSelect=false): "Tình trạng [triệu chứng cụ thể] bắt đầu từ khi nào?"
   Options: vừa mới / vài giờ trước / từ sáng / từ hôm qua / vài ngày nay
③ TYPE 5 — Diễn tiến (multiSelect=false): "Từ [thời điểm] đến giờ, tình trạng có thay đổi không?"
   Options: đang đỡ dần / vẫn như cũ / có vẻ nặng hơn
   Nếu "nặng hơn" → hỏi thêm TYPE 6 (red flag) trước khi kết luận
④ TYPE 7 hoặc TYPE 8 — chỉ nếu còn câu hỏi VÀ cần thêm thông tin
⑤ Kết luận`}

⚠️ NGUYÊN TẮC CỨNG:
- KHÔNG tạo câu hỏi thuộc TYPE đã có trong danh sách "TYPEs đã dùng" ở trên
- KHÔNG đưa vào options bất kỳ triệu chứng nào đã có trong "Triệu chứng user đã khai"
- Mỗi câu hỏi PHẢI nhắc tên triệu chứng CỤ THỂ user đã nói (không hỏi chung chung)
- Nếu user báo red flag (đau ngực / khó thở / hoa mắt / vã mồ hôi / ngất) → isDone=true NGAY
- Severity kết luận: nếu user chọn "rất nặng" ở bất kỳ câu nào → severity=high (không được giảm xuống)
${conditions ? `- Bệnh nền [${conditions}] → ưu tiên hỏi triệu chứng liên quan bệnh nền này` : ''}
${prevCheckinsStr ? `- Hôm qua/gần đây user có triệu chứng tương tự → nhắc lại để tạo cảm giác theo dõi liên tục` : ''}

🔒 QUY TẮC OPTIONS THEO TỪNG LOẠI CÂU HỎI (bắt buộc tuân thủ):
• Câu hỏi TRIỆU CHỨNG (TYPE 3): options = tên triệu chứng (mệt mỏi, chóng mặt, đau đầu, ...) — KHÔNG được có mức độ (nhẹ/nặng)
• Câu hỏi MỨC ĐỘ (TYPE 2): options = mức độ (nhẹ, trung bình, khá nặng, rất nặng) — KHÔNG được có triệu chứng
• Câu hỏi THỜI ĐIỂM (TYPE 4): options = mốc thời gian (vừa mới, vài giờ trước, từ sáng, từ hôm qua) — không được có gì khác
• Câu hỏi DIỄN TIẾN (TYPE 5): options = xu hướng thay đổi (đang đỡ dần, vẫn như cũ, có vẻ nặng hơn)
• Câu hỏi RED FLAG (TYPE 6): options = dấu hiệu nguy hiểm cụ thể + "không có" — KHÔNG được có triệu chứng thông thường
• Câu hỏi NGUYÊN NHÂN (TYPE 7): options = nguyên nhân (ngủ ít, bỏ bữa, căng thẳng, quên thuốc, không rõ)
• Câu hỏi HÀNH ĐỘNG (TYPE 8): options = hành động đã làm (nghỉ ngơi, ăn uống, uống nước, uống thuốc, chưa làm gì)
• Câu hỏi TẦN SUẤT (TYPE 10): options = tần suất (lần đầu, thỉnh thoảng, hay bị, gần đây bị nhiều hơn) — dùng khi cần biết pattern${conditions ? `
• Câu hỏi THUỐC (TYPE 11): "Hôm nay bạn đã uống thuốc [tên thuốc theo bệnh nền] chưa?" — options: đã uống / quên / chưa đến giờ` : ''}

Respond in JSON only. "options" phải có ít nhất 2 phần tử.
Format câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2"],"multiSelect":true|false,"allowFreeText":false}
  Nếu câu hỏi cần mô tả chi tiết (TYPE 3 triệu chứng, TYPE 7 nguyên nhân), set "allowFreeText":true để user có thể gõ thêm.
Format kết luận: {"isDone":true,"summary":"...","severity":"low|medium|high","recommendation":"...","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":3,"closeMessage":"Tôi sẽ hỏi lại bạn sau X tiếng nhé."}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;
  }

  // ── Call OpenAI with timeout + fallback ──
  let raw;
  let response;
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    // [G1 FIX] Split into system (behavioral rules) + user (session data) roles
    // System role gets higher instruction adherence from GPT-4o
    const systemRole = isFollowUp
      ? `Bạn là Asinu — trợ lý sức khoẻ AI, đang theo dõi diễn biến bệnh nhân định kỳ. Hỏi theo 3 lớp (Trạng thái → Triệu chứng mới → Hành động). Trả lời JSON only.`
      : `Bạn là Asinu — trợ lý sức khoẻ AI, hỏi như bác sĩ gia đình. Tuân thủ 9 TYPE câu hỏi y khoa. Không lặp TYPE đã hỏi. Nhắc triệu chứng cụ thể, không hỏi chung chung. Red flag → isDone=true ngay. Trả lời JSON only.`;

    response = await getClient().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemRole },
        { role: 'user', content: systemPrompt },
      ],
      max_completion_tokens: 500,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }, { signal: controller.signal });

    clearTimeout(timeout);
    raw = response.choices[0]?.message?.content || '{}';

    // Log successful AI call
    if (pool) {
      const duration = Date.now() - startTime;
      logAiInteraction(pool, {
        userId,
        type: 'triage',
        model: 'gpt-4o',
        promptSummary: `phase=${phase}, status=${status}, answers=${answerCount}`,
        responseSummary: raw,
        tokensUsed: response?.usage?.total_tokens || 0,
        durationMs: duration,
        isFallback: false,
      }).catch(() => {}); // fire-and-forget
    }
  } catch (apiErr) {
    console.error(`[TriageAI] OpenAI API failed (phase=${phase}, answers=${answerCount}):`, apiErr?.message || apiErr);
    console.log(`[TriageAI] Using fallback question instead of blocking checkin flow.`);

    // Log fallback AI call
    if (pool) {
      const duration = Date.now() - startTime;
      logAiInteraction(pool, {
        userId,
        type: 'triage',
        model: 'gpt-4o',
        promptSummary: `phase=${phase}, status=${status}, answers=${answerCount}`,
        responseSummary: 'FALLBACK',
        durationMs: duration,
        isFallback: true,
        error: apiErr?.message,
      }).catch(() => {}); // fire-and-forget
    }

    return getFallbackQuestion(status, phase, lang, previousAnswers);
  }

  console.log(`[TriageAI] phase=${phase}, answers=${answerCount}/${maxQuestions}, min=${minQuestions}, raw:`, raw);
  try {
    let parsed = JSON.parse(raw);

    // ── Server-side enforcement: block early isDone ──
    if (parsed.isDone && answerCount < minQuestions && !parsed.hasRedFlag) {
      console.log(`[TriageAI] ⛔ Blocked early isDone (${answerCount}/${minQuestions} min). Forcing continue with unused TYPE.`);
      // Pick a TYPE not yet used
      const fallbackByType = {
        5: { q: lang === 'en' ? 'How has your condition changed since it started?' : 'Từ lúc bắt đầu đến giờ, tình trạng có thay đổi không?',
             opts: lang === 'en' ? ['getting better', 'about the same', 'getting worse'] : ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'], multi: false },
        7: { q: lang === 'en' ? 'What might have caused this?' : 'Bạn nghĩ điều gì có thể dẫn đến tình trạng này?',
             opts: lang === 'en' ? ['lack of sleep', 'skipped meals', 'stress', 'missed medication', 'not sure'] : ['ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ'], multi: true },
        8: { q: lang === 'en' ? 'Have you done anything to feel better?' : 'Bạn đã làm gì để cải thiện chưa?',
             opts: lang === 'en' ? ['rested', 'ate something', 'drank water', 'took medication', 'nothing yet'] : ['nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì'], multi: true },
        2: { q: lang === 'en' ? 'How severe is your discomfort right now?' : 'Mức độ khó chịu của bạn hiện tại thế nào?',
             opts: lang === 'en' ? ['mild', 'moderate', 'quite severe'] : ['nhẹ', 'trung bình', 'khá nặng'], multi: false },
        10: { q: lang === 'en' ? 'Does this happen often?' : 'Tình trạng này có hay xảy ra không?',
              opts: lang === 'en' ? ['first time', 'occasionally', 'often', 'more often recently'] : ['lần đầu', 'thỉnh thoảng', 'hay bị', 'gần đây bị nhiều hơn'], multi: false },
      };
      const nextType = [5, 7, 8, 2, 10].find(t => !usedTypes.has(t));
      const fb = fallbackByType[nextType] || fallbackByType[7];
      parsed = { isDone: false, question: fb.q, options: fb.opts, multiSelect: fb.multi };
    }

    // ── Severity safety override ──
    // If user explicitly answered "rất nặng" / "very severe" in any triage answer,
    // severity must be at least "high" — AI must not downgrade it to medium/low.
    if (parsed.isDone) {
      const HIGH_SEVERITY_KEYWORDS = ['rất nặng', 'very severe', 'rất tệ', 'rất khó chịu', 'cực kỳ'];
      const answersText = previousAnswers.map(a => (a.answer || '').toLowerCase()).join(' ');
      if (HIGH_SEVERITY_KEYWORDS.some(kw => answersText.includes(kw))) {
        if (parsed.severity !== 'high') {
          console.log(`[TriageAI] ⚠️ Severity override: AI returned "${parsed.severity}" but answers contain high-severity keyword → forcing "high"`);
          parsed.severity = 'high';
        }
      }
    }

    // ── Options sanity check (server-side) ──
    // Prevent AI from mixing option types (e.g. severity words in symptom question)
    if (!parsed.isDone && parsed.options && parsed.question) {
      const q = parsed.question.toLowerCase();
      const SEVERITY_WORDS = ['nhẹ', 'trung bình', 'khá nặng', 'rất nặng', 'mild', 'moderate', 'severe'];
      const SYMPTOM_WORDS = ['mệt mỏi', 'chóng mặt', 'đau đầu', 'buồn nôn', 'fatigue', 'dizziness', 'headache', 'nausea'];
      const isSymptomQ = q.includes('triệu chứng') || q.includes('tình trạng nào') || q.includes('symptoms') || q.includes('experiencing');
      const isSeverityQ = q.includes('mức độ') || q.includes('how severe') || q.includes('nặng thế nào');

      if (isSymptomQ) {
        // Remove severity words from symptom question options
        const filtered = parsed.options.filter(o => !SEVERITY_WORDS.includes(o.toLowerCase().trim()));
        if (filtered.length >= 2) parsed.options = filtered;
      } else if (isSeverityQ) {
        // Remove symptom words from severity question options
        const filtered = parsed.options.filter(o => !SYMPTOM_WORDS.some(sw => o.toLowerCase().includes(sw)));
        if (filtered.length >= 2) parsed.options = filtered;
      }

      // Ensure options don't contain already-known symptoms
      if (knownSymptoms.size > 0 && isSymptomQ) {
        const filtered = parsed.options.filter(o => !knownSymptoms.has(o.toLowerCase().trim()));
        if (filtered.length >= 2) parsed.options = filtered;
      }
    }

    // [G4 FIX] Force high severity if vital signs are dangerous, regardless of AI output
    if (parsed.isDone && vitalAlerts.length > 0 && parsed.severity !== 'high') {
      console.log(`[TriageAI] ⚠️ Vital signs override: forcing severity=high due to dangerous readings`);
      parsed.severity = 'high';
      parsed.needsDoctor = true;
    }

    // Gắn followUpHours mặc định nếu AI không trả về
    if (parsed.isDone && !parsed.followUpHours) {
      parsed.followUpHours = calcFollowUpHours(parsed.severity || 'medium', answerCount);
    }
    // Apply AI safety filter
    parsed = filterTriageResult(parsed);

    console.log(`[TriageAI] isDone=${parsed.isDone}, question=${parsed.question || 'N/A'}`);
    return parsed;
  } catch (parseErr) {
    console.error(`[TriageAI] JSON parse failed, using fallback:`, parseErr?.message);
    return getFallbackQuestion(status, phase, lang, previousAnswers);
  }
}

module.exports = { getNextTriageQuestion, buildContinuityMessage, calcFollowUpHours, getFallbackQuestion };
