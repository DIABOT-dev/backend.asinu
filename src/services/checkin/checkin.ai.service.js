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

// Normalize answer: array → string, null-safe
const safeAns = (answer) => (Array.isArray(answer) ? answer.join(', ') : String(answer || '')).toLowerCase();

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
function getFallbackQuestion(status, phase, lang, previousAnswers = [], profile = {}) {
  const isFollowUp = phase === 'followup';
  const questionBank = isFollowUp ? FALLBACK_QUESTIONS.followup : FALLBACK_QUESTIONS.initial;
  const questions = questionBank[lang] || questionBank['vi'];
  const answerCount = previousAnswers.length;

  // Compute honorifics for personalization
  const age = profile.birth_year ? new Date().getFullYear() - parseInt(profile.birth_year) : null;
  const gender = (profile.gender || '').toLowerCase();
  const isMale = gender.includes('nam') || gender === 'male';
  let hon = 'bạn', self = 'mình';
  if (lang === 'vi' && age) {
    if (age >= 60) { hon = isMale ? 'chú' : 'cô'; self = 'cháu'; }
    else if (age >= 40) { hon = isMale ? 'anh' : 'chị'; self = 'em'; }
    else if (age >= 25) { hon = isMale ? 'anh' : 'chị'; self = 'mình'; }
  }
  const fixBan = (text) => {
    if (!text || lang !== 'vi' || hon === 'bạn') return text;
    return text.replace(/bạn/g, hon).replace(/Bạn/g, hon.charAt(0).toUpperCase() + hon.slice(1));
  };

  if (answerCount < questions.length) {
    return {
      isDone: false,
      question: fixBan(questions[answerCount].question),
      options: questions[answerCount].options,
      multiSelect: questions[answerCount].multiSelect,
      _fallback: true,
    };
  }

  // All fallback questions exhausted → return done with summary
  const summaryVi = `${self} đã ghi nhận tình trạng của ${hon} qua các câu trả lời.`;
  const summaryEn = 'Asinu has recorded your condition from your answers.';
  const recVi = `${hon.charAt(0).toUpperCase() + hon.slice(1)} nghỉ ngơi và theo dõi thêm nhé. ${self} sẽ hỏi lại sau.`;
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

  // Symptom frequency + medication adherence (new context)
  const symptomFreqStr = healthContext.symptomFrequencyContext || null;
  const medAdherenceStr = healthContext.medicationAdherenceContext || null;

  const healthDataLines = [
    glucoseStr && `- Glucose 7 ngày gần đây: ${glucoseStr}`,
    bpStr      && `- Huyết áp 7 ngày gần đây: ${bpStr}`,
    weightStr  && `- Cân nặng: ${weightStr}`,
    medAdherenceStr && `- ${medAdherenceStr}`,
  ].filter(Boolean);

  const healthDataSection = healthDataLines.length
    ? `Dữ liệu sức khoẻ gần đây:\n${healthDataLines.join('\n')}${vitalAlerts.length ? '\n\n🚨 CẢNH BÁO CHỈ SỐ:\n' + vitalAlerts.join('\n') : ''}${symptomFreqStr ? '\n\n📊 TẦN SUẤT TRIỆU CHỨNG (dữ liệu tích lũy):\n' + symptomFreqStr : ''}`
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
    const ans = safeAns(a.answer);

    // Detect TYPE from question content
    if (q.includes('mức độ') || q.includes('how severe') || q.includes('khó chịu') || q.includes('nặng thế nào')) usedTypes.add(2);
    if (q.includes('triệu chứng') || q.includes('symptoms') || q.includes('tình trạng nào') || q.includes('gặp phải') || q.includes('đang bị gì')) usedTypes.add(3);
    if (q.includes('bắt đầu') || q.includes('when did') || q.includes('từ khi nào') || q.includes('từ bao giờ') || q.includes('từ lúc nào') || q.includes('bao lâu rồi')) usedTypes.add(4);
    if (q.includes('thay đổi') || q.includes('diễn tiến') || q.includes('progression') || q.includes('có nặng hơn') || q.includes('có đỡ') || q.includes('đỡ hơn') || q.includes('vẫn vậy') || q.includes('nặng hơn chưa')) usedTypes.add(5);
    if (q.includes('nguy hiểm') || q.includes('khó thở') || q.includes('đau ngực') || q.includes('red flag') || q.includes('dấu hiệu nào') || q.includes('tức ngực') || q.includes('warning')) usedTypes.add(6);
    if (q.includes('nguyên nhân') || q.includes('cause') || q.includes('dẫn đến') || q.includes('ngủ ít') || q.includes('bỏ bữa') || q.includes('căng thẳng') || q.includes('gần đây')) usedTypes.add(7);
    if (q.includes('đã làm') || q.includes('action') || q.includes('cải thiện') || q.includes('have you done') || q.includes('nghỉ ngơi hay') || q.includes('uống thuốc gì chưa')) usedTypes.add(8);
    if (q.includes('thường xuyên') || q.includes('hay bị') || q.includes('how often') || q.includes('lần đầu') || q.includes('có hay xảy ra')) usedTypes.add(10);
    if (q.includes('uống thuốc') || q.includes('medication') || q.includes('thuốc')) usedTypes.add(11);

    // Fallback: detect TYPE from answer content (what user replied)
    if (!usedTypes.has(4) && (ans.includes('vừa mới') || ans.includes('vài giờ') || ans.includes('từ sáng') || ans.includes('từ hôm qua') || ans.includes('vài ngày'))) usedTypes.add(4);
    if (!usedTypes.has(5) && (ans.includes('đỡ dần') || ans.includes('đỡ hơn') || ans.includes('vẫn như cũ') || ans.includes('vẫn vậy') || ans.includes('nặng hơn'))) usedTypes.add(5);
    if (!usedTypes.has(7) && (ans.includes('ngủ ít') || ans.includes('bỏ bữa') || ans.includes('căng thẳng') || ans.includes('quên thuốc'))) usedTypes.add(7);
    if (!usedTypes.has(8) && (ans.includes('nghỉ ngơi') || ans.includes('uống nước') || ans.includes('chưa làm gì') || ans.includes('uống thuốc'))) usedTypes.add(8);

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

  // ── Xưng hô theo tuổi + giới tính ──
  const gender = (profile.gender || '').toLowerCase();
  const isMale = gender.includes('nam') || gender === 'male';
  let honorific = 'bạn';
  let selfRef = 'mình';
  if (lang === 'vi' && age) {
    if (age >= 60) { honorific = isMale ? 'chú' : 'cô'; selfRef = 'cháu'; }
    else if (age >= 40) { honorific = isMale ? 'anh' : 'chị'; selfRef = 'em'; }
    else if (age >= 25) { honorific = isMale ? 'anh' : 'chị'; selfRef = 'mình'; }
  }

  // Lấy tên ngắn (tên riêng) từ profile
  const fullName = profile.display_name || profile.full_name || '';
  const shortName = fullName ? fullName.trim().split(/\s+/).pop() : '';
  // VD: "Trần Văn Hùng" → "Hùng", gọi "Chú Hùng"
  const callName = shortName ? `${honorific} ${shortName}` : honorific;
  // Viết hoa đầu câu
  const CallName = callName.charAt(0).toUpperCase() + callName.slice(1);
  const Honorific = honorific.charAt(0).toUpperCase() + honorific.slice(1);

  const honorificRule = lang === 'vi'
    ? `\nCÁCH XƯNG HÔ (BẮT BUỘC):
- Gọi người dùng: "${CallName}" (có tên) hoặc "${Honorific}" (không tên). LUÔN viết hoa chữ đầu câu.
- Xưng: "${selfRef}".
- VD đầu câu: "${CallName} ơi, ..." hoặc "${Honorific} ơi, ..."
- 🚫 CẤM dùng "bạn" trong MỌI field (question, summary, recommendation, closeMessage) nếu đã có xưng hô "${honorific}". Luôn dùng "${honorific}" thay "bạn".
- KHÔNG viết thường đầu câu: "chú ơi" ← SAI, "${Honorific} ơi" ← ĐÚNG.`
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

  // ── Build continuity instruction ──
  const hasPrevCheckins = healthContext.previousCheckins && healthContext.previousCheckins.length > 0;
  const hasSymptomFreq = healthContext.symptomFrequencyContext;
  const hasMedAdherence = healthContext.medicationAdherenceContext;

  let continuityInstruction = '';
  if (answerCount === 0 && hasPrevCheckins) {
    const prevCheckins = healthContext.previousCheckins || [];
    const consecutiveDays = prevCheckins.length;

    if (consecutiveDays >= 3) {
      continuityInstruction = `\n\n🔴 CÂU HỎI ĐẦU TIÊN: "${CallName} ơi, ${selfRef} thấy ${honorific} mệt ${consecutiveDays} ngày liên tiếp rồi, hôm nay ${honorific} thấy thế nào? Mệt mỏi, chóng mặt hay có triệu chứng gì khác?"
Options PHẢI gồm: triệu chứng phổ biến (mệt mỏi, chóng mặt, đau đầu...) + "đã đỡ hơn" + "không rõ". multiSelect=true, allowFreeText=true để user nhập thêm.\n`;
    } else if (consecutiveDays >= 1) {
      continuityInstruction = `\n\n🔴 CÂU HỎI ĐẦU TIÊN: "${CallName} ơi, hôm qua ${honorific} nói bị [triệu chứng từ lịch sử], hôm nay ${honorific} thấy thế nào?"
Options PHẢI gồm: triệu chứng phổ biến + "đã đỡ hơn" + "không rõ". multiSelect=true, allowFreeText=true.\n`;
    }
  }
  // Tần suất + thuốc → inject vào context, AI tự dùng ở câu phù hợp (không ép vào câu 1)

  // ── Shared context block ──
  const contextBlock = `=== THÔNG TIN NGƯỜI DÙNG ===
- Tuổi: ${age ? age + ' tuổi' : 'không rõ'}
- Giới tính: ${profile.gender || 'không rõ'}
- Bệnh nền: ${conditions || 'không có'}
${medStatus}
${honorificRule}
${healthDataSection}
${prevCheckinsSection}
${prevSummary}
${prevTriageDetail}
${continuityInstruction}
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
    // Follow-up định kỳ: 3 lớp câu hỏi, 1-3 câu/lần
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

    // Build initial symptom context from triage summary AND triage messages for follow-up
    const symptomParts = [];
    if (previousSessionSummary) symptomParts.push(`Tóm tắt lần check-in trước: "${previousSessionSummary}"`);
    if (previousTriageMessages.length > 0) {
      symptomParts.push(`Chi tiết Q&A lần trước:\n${previousTriageMessages.map((m, i) => `  Q${i + 1}: "${m.question}" → "${m.answer}"`).join('\n')}`);
    }
    if (knownSymptomsStr) symptomParts.push(knownSymptomsStr);
    const initialSymptomContext = symptomParts.length > 0
      ? symptomParts.join('\n')
      : 'Không có thông tin triệu chứng từ lần trước.';

    // Detect if user already said "improved" in this session
    const IMPROVED_ANSWERS = ['đã đỡ', 'đỡ nhiều', 'đỡ rồi', 'đã đỡ nhiều', 'hết rồi', 'ổn rồi', 'better', 'improved', 'đang đỡ', 'đã đỡ hơn'];
    const userSaidImproved = previousAnswers.some(a =>
      IMPROVED_ANSWERS.some(kw => safeAns(a.answer).includes(kw))
    );

    // Detect if user said "worse"
    const WORSENED_ANSWERS = ['mệt hơn', 'nặng hơn', 'tệ hơn', 'worse', 'getting worse', 'mệt hơn trước'];
    const userSaidWorsened = previousAnswers.some(a =>
      WORSENED_ANSWERS.some(kw => safeAns(a.answer).includes(kw))
    );

    systemPrompt = `Bạn là Asinu — người đồng hành sức khoẻ, đang hỏi thăm lại ${honorific} sau lần check-in trước.
${honorific} trước đó báo "${statusLabel}".

═══ PHONG CÁCH HỎI (QUAN TRỌNG) ═══
Hỏi như NGƯỜI THÂN quan tâm, KHÔNG như hệ thống.
- ĐÚNG: "${CallName} ơi, lúc trước ${honorific} nói bị chóng mặt, giờ ${honorific} thấy đỡ hơn chưa?"
- SAI: "Tình trạng chóng mặt giờ thế nào rồi?" ← máy móc
- KHÔNG dùng "Ôi", "Ôi trời" hay cảm thán giả tạo. Hỏi thẳng, nhẹ nhàng.
- Câu ngắn gọn, đi thẳng vào vấn đề, quan tâm thật chứ không nịnh.
${age >= 50 ? `- ${honorific} lớn tuổi → dùng từ đơn giản, dễ hiểu.` : ''}

=== BỐI CẢNH TỪ LẦN CHECK-IN TRƯỚC (ĐỌC KỸ) ===
${initialSymptomContext}

${contextBlock}

=== LUỒNG XỬ LÝ FOLLOW-UP (tuân thủ CHÍNH XÁC) ===
${userSaidImproved ? `
████████████████████████████████████████████████████
█  🟢 USER ĐÃ NÓI ĐỠ RỒI                         █
█  → BẮT BUỘC isDone=true NGAY LẬP TỨC            █
█  → progression=improved, severity=low              █
█  → KHÔNG ĐƯỢC hỏi thêm BẤT KỲ câu nào            █
████████████████████████████████████████████████████
` : userSaidWorsened ? `
████████████████████████████████████████████████████
█  🔴 USER NÓI NẶNG HƠN → Cần đánh giá thêm       █
█  → Hỏi LỚP 2 (triệu chứng mới) nếu chưa hỏi    █
█  → Chú ý red flag                                  █
████████████████████████████████████████████████████
` : ''}

Hỏi theo thứ tự 3 LỚP. Lớp chưa hỏi: ${layersLeft.length > 0 ? layersLeft.map(l => `LỚP ${l}`).join(', ') : 'đã hỏi hết → isDone=true'}.

─── LỚP 1: TRẠNG THÁI SO VỚI LẦN TRƯỚC ${usedLayers.has(1) ? '✅ ĐÃ HỎI' : '⬜ CHƯA HỎI → hỏi ngay'} ───
  Mục đích: So sánh tình trạng hiện tại với lần check-in trước.
  Cách hỏi: Nhắc ĐÚNG triệu chứng từ lần trước (lấy từ "Triệu chứng user đã khai" hoặc "Tóm tắt lần check-in trước").
  VD đúng: "Tình trạng chóng mặt giờ thế nào rồi?" (nếu user trước đó khai chóng mặt)
  VD sai: "Tình trạng đau đầu giờ thế nào rồi?" (nếu user CHƯA BAO GIỜ nói đau đầu)
  multiSelect: false
  Options CHÍNH XÁC: ["đã đỡ nhiều", "vẫn như cũ", "mệt hơn trước"]

  → Nếu user chọn "đã đỡ nhiều": isDone=true NGAY. progression=improved, severity=low, followUpHours=6.
     KHÔNG hỏi lớp 2 hay lớp 3. Kết thúc luôn.
  → Nếu "vẫn như cũ": tiếp tục lớp 2.
  → Nếu "mệt hơn trước": tiếp tục lớp 2, chú ý red flag.

─── LỚP 2: TRIỆU CHỨNG MỚI ${usedLayers.has(2) ? '✅ ĐÃ HỎI' : '⬜ CHƯA HỎI'} ───
  Mục đích: Phát hiện triệu chứng mới xuất hiện sau lần check-in trước.
  CHỈ hỏi nếu user KHÔNG nói "đã đỡ" ở lớp 1.
  Cách hỏi: "Ngoài [triệu chứng đã biết], bạn có thêm dấu hiệu nào không?"
  multiSelect: true, allowFreeText: true
  Options: CHỈ gồm triệu chứng MỚI (không trùng triệu chứng đã khai) + "không có gì thêm"

  ⚡ RED FLAG: Nếu user chọn khó thở / đau ngực / hoa mắt / vã mồ hôi / ngất:
     → isDone=true NGAY, hasRedFlag=true, needsDoctor=true, severity=high, followUpHours=1

─── LỚP 3: HÀNH ĐỘNG ĐÃ LÀM ${usedLayers.has(3) ? '✅ ĐÃ HỎI' : '⬜ CHƯA HỎI'} ───
  Mục đích: Biết user đã tự chăm sóc chưa, để đưa lời khuyên phù hợp.
  Cách hỏi: "Bạn đã nghỉ ngơi hay làm gì để đỡ hơn chưa?"
  multiSelect: true
  Options CHÍNH XÁC: ["nghỉ ngơi", "ăn uống", "uống thuốc", "uống nước", "chưa làm gì"]

=== BẢNG QUYẾT ĐỊNH KẾT LUẬN ===
┌─────────────────────────┬─────────────┬──────────┬───────────────┬───────┐
│ Tình huống               │ progression │ severity │ followUpHours │ alert │
├─────────────────────────┼─────────────┼──────────┼───────────────┼───────┤
│ Lớp 1 = "đã đỡ"         │ improved    │ low      │ 6             │ no    │
│ Lớp 1 = "vẫn như cũ"    │ same        │ medium   │ 3             │ no    │
│ Nặng hơn, không red flag│ worsened    │ medium   │ 2             │ no    │
│ Nặng hơn + red flag     │ worsened    │ high     │ 1             │ yes   │
│ Triệu chứng mới nguy   │ worsened    │ high     │ 1             │ yes   │
└─────────────────────────┴─────────────┴──────────┴───────────────┴───────┘

=== NGUYÊN TẮC CỨNG (VI PHẠM = LỖI HỆ THỐNG) ===
1. 🚫 KHÔNG được nhắc tên triệu chứng mà user CHƯA BAO GIỜ khai.
   Chỉ dùng triệu chứng có trong "Triệu chứng user đã khai" hoặc Q&A lần trước.
2. 🚫 KHÔNG đưa triệu chứng đã khai vào options (tránh hỏi lại).
3. 🚫 KHÔNG lặp lớp đã hỏi (xem ✅ ở trên).
4. 🚫 KHÔNG hỏi thêm nếu user nói "đã đỡ" — trả isDone=true ngay.
5. ✅ Câu hỏi PHẢI cá nhân hóa: dùng đúng triệu chứng user đã báo.
6. ✅ Giọng điệu: thân thiện, ngắn gọn, như bác sĩ gia đình nói chuyện với người thân.
7. ✅ recommendation trong kết luận: cá nhân hóa dựa trên triệu chứng + hành động + bệnh nền.
8. ✅ Nếu có "Lịch sử check-in gần nhất" → recommendation PHẢI nhắc pattern (VD: "Triệu chứng lặp lại 3 ngày liên tiếp, ${selfRef} khuyên ${honorific} nên đi khám").
9. ✅ Nếu có "TẦN SUẤT TRIỆU CHỨNG" với xu hướng ↑ tăng → severity nên tăng 1 bậc (low→medium, medium→high).
10. ✅ Nếu có thông tin bỏ thuốc (⚠️) → recommendation PHẢI nhắc uống thuốc đều.

=== OUTPUT FORMAT (JSON only, không text thừa) ===
Câu hỏi: {"isDone":false,"question":"...","options":["opt1","opt2"],"multiSelect":true|false,"allowFreeText":false}
Kết luận: {"isDone":true,"progression":"improved|same|worsened","summary":"tóm tắt triệu chứng","severity":"low|medium|high","recommendation":"lời khuyên cá nhân hóa","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":6,"closeMessage":"${selfRef} sẽ hỏi lại ${honorific} sau X tiếng nhé."}

LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.`;

  } else {
    // ══════════════════════════════════════════════════════════════════
    // GIAI ĐOẠN 2: LÀM RÕ TÌNH TRẠNG (Clinical Interview — 11 TYPE y khoa)
    // Hỏi theo tư duy bác sĩ — mỗi câu nối tiếp câu trước
    // Tối thiểu 5 câu, tối đa 8 câu
    // ══════════════════════════════════════════════════════════════════

    // Detect user's "đang đỡ" answer for progression question
    const userSaidGettingBetter = previousAnswers.some(a =>
      ['đang đỡ', 'đỡ dần', 'getting better'].some(kw => safeAns(a.answer).includes(kw))
    );
    const userSaidGettingWorse = previousAnswers.some(a =>
      ['nặng hơn', 'tệ hơn', 'getting worse', 'worse'].some(kw => safeAns(a.answer).includes(kw))
    );

    systemPrompt = `Bạn là Asinu — người đồng hành sức khoẻ, như bác sĩ gia đình thân thiết đang hỏi thăm ${honorific}.

═══ PHONG CÁCH HỎI (QUAN TRỌNG NHẤT) ═══
Bạn KHÔNG phải chatbot hay hệ thống y tế. Bạn là NGƯỜI THẬT đang quan tâm đến ${honorific}.
- Câu hỏi phải tự nhiên như người thân hỏi thăm, KHÔNG như bảng khảo sát y tế.
- Hỏi THẲNG, NGẮN GỌN, nhẹ nhàng. Không rào đón, không cảm thán giả tạo.
- KHÔNG dùng "Ôi", "Ôi trời", "khó chịu lắm nhỉ" → nghe nịnh nọt, giả.
- KHÔNG hỏi kiểu: "Bạn đang gặp triệu chứng nào?" → quá cứng.
- Dùng đúng xưng hô "${Honorific}"/"${selfRef}" xuyên suốt, viết hoa đầu câu.
${age >= 50 ? `- ${Honorific} lớn tuổi → câu hỏi phải ĐƠN GIẢN, DỄ HIỂU, không dùng thuật ngữ y khoa.` : ''}
${conditions ? `- ${Honorific} có bệnh nền (${conditions}) → lồng ghép quan tâm khi cần.` : ''}

═══ QUY TẮC CÂU HỎI + OPTIONS PHẢI MATCH ═══
Câu hỏi và options PHẢI logic với nhau:
- Nếu options là TRIỆU CHỨNG → câu hỏi phải nhắc đến tình trạng đã báo rồi hỏi thêm triệu chứng: "${CallName} ơi, ${selfRef} vừa nhận được thông tin ${honorific} đang không khoẻ. ${Honorific} cho ${selfRef} biết thêm triệu chứng ${honorific} gặp phải nhé."
- Nếu options là THỜI GIAN → câu hỏi phải hỏi về thời gian: "${Honorific} bị từ lúc nào vậy?"
- Nếu options là MỨC ĐỘ → câu hỏi phải hỏi về mức độ
- KHÔNG hỏi "mệt kiểu nào?" rồi đưa options là triệu chứng → không match

═══ VÍ DỤ CÂU HỎI ĐÚNG vs SAI ═══
TYPE 3 triệu chứng:
  ❌ SAI: "Bạn đang gặp triệu chứng nào?" ← khảo sát
  ❌ SAI: "Hôm nay chú thấy mệt kiểu nào? Đau đầu, chóng mặt hay sao?" ← "kiểu nào" không match với triệu chứng
  ✅ ĐÚNG: "${CallName} ơi, ${selfRef} vừa nhận được thông tin ${honorific} đang ${statusLabel}. ${Honorific} cho ${selfRef} biết thêm về triệu chứng ${honorific} gặp phải — ${honorific} chọn phía dưới hoặc điền vào nếu có triệu chứng nào khác nhé."
  ✅ ĐÚNG: "${CallName} ơi, ${selfRef} nghe ${honorific} đang ${statusLabel}. ${Honorific} đang gặp triệu chứng nào dưới đây không? ${Honorific} chọn hoặc nhập thêm cho ${selfRef} biết nhé."

TYPE 4 onset (allowFreeText=true để nhập thời gian chính xác):
  ❌ SAI: "Tình trạng này bắt đầu từ khi nào?" ← máy móc
  ❌ SAI: User chọn 3 triệu chứng (mệt mỏi, chóng mặt, đau đầu) → chỉ hỏi "Chú bị chóng mặt từ lúc nào?" ← bỏ sót 2 triệu chứng còn lại
  ✅ ĐÚNG (nhiều triệu chứng): "${Honorific} bị các triệu chứng trên từ lúc nào vậy? ${Honorific} chọn hoặc cho ${selfRef} biết thời gian chính xác nhé."
  ✅ ĐÚNG (1 triệu chứng): "${Honorific} bị [triệu chứng] từ lúc nào vậy — ${honorific} chọn hoặc nhập thời gian chính xác nhé."

TYPE 5 diễn tiến (CHỈ HỎI 1 CÂU DUY NHẤT, KHÔNG hỏi 2 câu cùng ý):
  ❌ SAI: "Từ sáng đến giờ, tình trạng có thay đổi không?" ← khảo sát
  ❌ SAI: Hỏi "có thay đổi gì không — đỡ dần, vẫn vậy, nặng hơn?" RỒI lại hỏi "đỡ hơn chưa hay vẫn vậy?" ← TRÙNG LẶP
  ✅ ĐÚNG: "Từ [thời điểm user nói] đến giờ ${honorific} thấy đỡ hơn chưa, hay vẫn vậy?"

TYPE 7 nguyên nhân:
  ❌ SAI: "Bạn nghĩ điều gì có thể dẫn đến tình trạng này?" ← dài, cứng
  ✅ ĐÚNG: "${Honorific} có nhớ gần đây ngủ ít, bỏ bữa hay căng thẳng gì không?"

TYPE 8 hành động:
  ❌ SAI: "Bạn đã làm gì để cải thiện chưa?" ← khảo sát
  ✅ ĐÚNG: "${Honorific} có nghỉ ngơi hay uống thuốc gì chưa?"

QUY TẮC GIỌNG ĐIỆU:
- KHÔNG dùng "Ôi", "Ôi trời" → giả tạo
- Câu hỏi NGẮN GỌN (1-2 câu max), KHÔNG nhồi nhiều thông tin vào 1 câu
- Mỗi câu hỏi chỉ hỏi 1 điều duy nhất
- 🚫 CHỐNG TRÙNG LẶP: KHÔNG viết 2 câu cùng hỏi 1 ý. VD: "có thay đổi gì không — đỡ dần, vẫn vậy, nặng hơn?" rồi lại "đỡ hơn chưa hay vẫn vậy?" → CẤM. Chỉ giữ 1 câu duy nhất.

QUY TẮC OPTIONS (BẮT BUỘC):
- Options PHẢI là đáp án hợp lý cho câu hỏi đang hỏi
- Options PHẢI bao quát đủ để ĐA SỐ người dùng tìm được lựa chọn phù hợp mà không cần gõ thêm
- KHÔNG để options không match câu hỏi

🔑 NGUYÊN TẮC multiSelect:
- Câu hỏi CHỈ CÓ 1 ĐÁP ÁN ĐÚNG (đỡ/vẫn vậy/nặng, mốc thời gian, mức độ, tần suất) → multiSelect=false
  VD: "Đỡ hơn chưa?" → chỉ chọn 1: đỡ rồi / vẫn vậy / nặng hơn
  VD: "Từ khi nào?" → chỉ chọn 1: vừa mới / vài giờ trước / từ sáng / từ hôm qua
- Câu hỏi CÓ THỂ NHIỀU ĐÁP ÁN CÙNG LÚC (triệu chứng, nguyên nhân, hành động, red flag) → multiSelect=true
  VD: "Gặp triệu chứng gì?" → có thể vừa mệt vừa đau đầu vừa chóng mặt → chọn nhiều

Người dùng vừa báo: "${statusLabel}".
TYPE 1 (Chief Complaint) đã biết — KHÔNG hỏi lại "${Honorific} cảm thấy thế nào?".

${contextBlock}

═══ TƯ DUY LÂM SÀNG ═══
Câu hỏi sau PHẢI nối tiếp tự nhiên từ câu trả lời trước:
- ${honorific} chọn 1 triệu chứng → hỏi onset: "${Honorific} bị [triệu chứng] từ lúc nào vậy?"
- ${honorific} chọn NHIỀU triệu chứng → hỏi onset CHUNG: "${Honorific} bị các triệu chứng trên từ lúc nào vậy?"
- ${honorific} nói "từ sáng" → hỏi diễn tiến (CHỈ 1 CÂU): "Từ sáng đến giờ ${honorific} thấy đỡ hơn chưa, hay vẫn vậy?"
- ${honorific} nói "nặng hơn" → hỏi red flag: "${Honorific} có thêm triệu chứng gì không — đau ngực, khó thở?"
- ${honorific} nói "đang đỡ" → cân nhắc kết luận sớm
⚠️ Mỗi bước chỉ sinh 1 câu hỏi. KHÔNG ghép 2 câu hỏi cùng ý vào 1 lượt.
${userSaidGettingBetter ? `\n🟢 ${honorific} nói ĐANG ĐỠ → cân nhắc kết luận sớm, severity=low.` : ''}
${userSaidGettingWorse ? `\n🔴 ${honorific} nói NẶNG HƠN → BẮT BUỘC hỏi red flag trước khi kết luận.` : ''}

=== THỨ TỰ CÂU HỎI THEO STATUS ===
${isSpecificConcern ? `
┌─── CÓ VẤN ĐỀ CỤ THỂ ────────────────────────────────────────────┐
│ ① TYPE 3 — MÔ TẢ (multiSelect=true, allowFreeText=true)          │
│   "${Honorific} đang gặp vấn đề gì?"                              │
│   Options: đau đầu / chóng mặt / đau bụng / đau ngực / khó thở   │
│            / mất ngủ / lo lắng / da/tóc bất thường / vấn đề khác  │
│ ② TYPE 4 — Onset (allowFreeText=true)                              │
│ ③ TYPE 10 — Tần suất                                               │
│ ④ TYPE 5 — Diễn tiến                                               │
│ ⑤ TYPE 2 — Mức độ (nếu chưa rõ severity)                          │
│ ⑥ TYPE 6 — Red flag (nếu cần) hoặc TYPE 7 — Nguyên nhân          │
│ ⑦ Kết luận                                                         │
└────────────────────────────────────────────────────────────────────┘` : isVeryUnwell ? `
┌─── RẤT MỆT (ưu tiên phát hiện nguy hiểm) ──────────────────────┐
│ ① TYPE 3 — Triệu chứng (multiSelect=true, allowFreeText=true)   │
│   "${Honorific} đang gặp triệu chứng nào?"                        │
│   Options: mệt mỏi / chóng mặt / đau đầu / buồn nôn             │
│            / tức ngực / khó thở / hoa mắt / vã mồ hôi / không rõ │
│ ② TYPE 6 — Red flag (multiSelect=true):                           │
│   "Ngoài [triệu chứng đã khai], ${honorific} có thêm dấu hiệu?" │
│   Options: khó thở / đau ngực / tức ngực / hoa mắt / vã mồ hôi  │
│            / ngất / không có                                       │
│   ⚡ Chọn bất kỳ (trừ "không có") → isDone=true, hasRedFlag=true │
│ ③ TYPE 2 — Severity (multiSelect=false):                          │
│   Options BẮT BUỘC: trung bình / khá nặng / rất nặng             │
│   ⚠️ KHÔNG có "nhẹ" vì user đã báo RẤT MỆT                      │
│   "rất nặng" → severity=high bắt buộc                             │
│ ④ TYPE 4 — Onset (allowFreeText=true)                              │
│ ⑤ TYPE 5 — Diễn tiến (multiSelect=false)                          │
│ ⑥ TYPE 7 — Nguyên nhân                                            │
│ ⑦ Kết luận                                                        │
└──────────────────────────────────────────────────────────────────┘` : `
┌─── HƠI MỆT (đánh giá chi tiết) ────────────────────────────────┐
│ ① TYPE 3 — Triệu chứng (multiSelect=true, allowFreeText=true)   │
│   "${Honorific} đang gặp triệu chứng nào?"                        │
│   Options: mệt mỏi / chóng mặt / đau đầu / buồn nôn             │
│            / khát nước / ăn không ngon / không rõ                  │
│ ② TYPE 4 — Onset (multiSelect=false, allowFreeText=true)          │
│   Nhiều triệu chứng → hỏi chung "các triệu chứng trên"           │
│   Options: vừa mới / vài giờ trước / từ sáng / từ hôm qua       │
│            / vài ngày nay                                          │
│ ③ TYPE 5 — Diễn tiến (multiSelect=false)                          │
│   Options: đang đỡ dần / vẫn như cũ / có vẻ nặng hơn             │
│   → "nặng hơn": BẮT BUỘC hỏi TYPE 6 trước kết luận               │
│   → "đang đỡ dần": cân nhắc kết luận sớm                          │
│ ④ TYPE 7 — Nguyên nhân (multiSelect=true, allowFreeText=true)    │
│   Options: ngủ ít / bỏ bữa / căng thẳng / quên thuốc / không rõ │
│ ⑤ TYPE 8 — Hành động (multiSelect=true)                           │
│   Options: nghỉ ngơi / ăn uống / uống nước / uống thuốc          │
│            / chưa làm gì                                           │
│ ⑥ Kết luận nếu đã đủ thông tin                                    │
└──────────────────────────────────────────────────────────────────┘`}

=== CÁ NHÂN HÓA (quan trọng) ===
${conditions ? `🏥 Bệnh nền: ${conditions}
   → Ưu tiên hỏi triệu chứng liên quan bệnh nền.
   → Kết luận phải đề cập ảnh hưởng đến bệnh nền nếu relevant.` : '- Không có bệnh nền ghi nhận.'}
${prevCheckinsStr ? `📋 Lịch sử gần (BẮT BUỘC ĐỌC VÀ DÙNG):
${prevCheckinsStr}
   🔴 BẮT BUỘC: Câu hỏi ĐẦU TIÊN PHẢI nhắc lại triệu chứng từ lần check-in trước.
   VD: "${CallName} ơi, hôm qua ${honorific} có nói bị [triệu chứng từ lịch sử], hôm nay ${honorific} thấy thế nào?"
   🔴 Nếu triệu chứng lặp lại nhiều ngày → severity PHẢI tăng 1 bậc + nhắc "${selfRef} thấy ${honorific} bị [triệu chứng] mấy ngày liên tục rồi".
   🔴 Recommendation kết luận PHẢI đề cập pattern nếu có.` : '- Chưa có lịch sử check-in trước.'}
${hasSymptomFreq ? `📊 Tần suất triệu chứng (BẮT BUỘC DÙNG trong recommendation):
${healthContext.symptomFrequencyContext}
   → Nếu có ↑ tăng → PHẢI nhắc trong kết luận: "Triệu chứng [X] đang có xu hướng tăng trong tuần qua".` : ''}
${hasMedAdherence ? `💊 ${healthContext.medicationAdherenceContext}
   → Nếu có ⚠️ bỏ thuốc → PHẢI nhắc trong recommendation: "Nhớ uống thuốc đều ${honorific} nhé".` : (medStatus ? `💊 ${medStatus}` : '')}

=== NGUYÊN TẮC CỨNG (VI PHẠM = LỖI HỆ THỐNG) ===

🚫 CẤM TUYỆT ĐỐI:
1. KHÔNG tạo câu hỏi thuộc TYPE đã dùng (xem "TYPEs đã dùng" ở TRACKING).
2. KHÔNG đưa triệu chứng đã khai vào options (tránh hỏi lại cái user đã nói).
3. KHÔNG nhắc tên triệu chứng user CHƯA BAO GIỜ khai trong câu hỏi.
   VD SAI: User nói "chóng mặt, ăn không ngon" → hỏi "Tình trạng đau đầu bắt đầu từ khi nào?"
   VD ĐÚNG: → hỏi "Tình trạng chóng mặt bắt đầu từ khi nào?"
4. KHÔNG hỏi chung chung "Bạn có triệu chứng nào khác?" sau TYPE 3 — dùng TYPE 6 (red flag) thay vào.
5. KHÔNG trộn lẫn loại options — xem bảng dưới.

✅ BẮT BUỘC:
6. TYPE 4 (onset) và TYPE 5 (diễn tiến) PHẢI nhắc triệu chứng CHÍNH từ "Triệu chứng user đã khai".
7. Red flag (đau ngực / khó thở / hoa mắt / vã mồ hôi / ngất) → isDone=true NGAY.
8. User chọn "rất nặng" → severity=high bắt buộc (không được hạ).
9. Recommendation phải cá nhân hóa: đề cập triệu chứng cụ thể + bệnh nền (nếu có).
10. closeMessage trong kết luận phải nói rõ bao lâu sẽ hỏi lại.

🏥 CLINICAL CORRELATION (BẮT BUỘC nếu có bệnh nền):
11. Tiểu đường + khát nước/mệt mỏi/quên thuốc → nghi ngờ tăng đường huyết → severity tối thiểu medium, recommendation PHẢI nhắc "kiểm tra đường huyết" và "uống thuốc đúng giờ".
12. Cao huyết áp + đau đầu/chóng mặt + nặng hơn → nghi ngờ tăng huyết áp → severity=high, needsDoctor=true, recommendation PHẢI nhắc "đo huyết áp ngay".
13. Bệnh tim + tức ngực/mệt/khó thở → nguy cơ tim mạch → severity=high, needsDoctor=true.
14. Quên thuốc + có bệnh nền → recommendation BẮT BUỘC nhắc "uống thuốc ngay nếu chưa quá muộn".

👨‍👩‍👦 needsFamilyAlert (BẮT BUỘC = true khi):
- severity=high VÀ ${age >= 60 ? 'người lớn tuổi (≥60)' : 'có bệnh nền nặng'}
- Red flag detected
- User nói "rất nặng" hoặc "nặng hơn" VÀ có bệnh nền
- Quên thuốc + triệu chứng nặng

🔒 BẢNG OPTIONS THEO TYPE (bắt buộc tuân thủ):
┌──────────┬───────────────────────────────────────────────────────┬────────────┐
│ TYPE     │ Options cho phép                                      │ multiSelect│
├──────────┼───────────────────────────────────────────────────────┼────────────┤
│ 2 Mức độ │ nhẹ / trung bình / khá nặng / rất nặng               │ false      │
│ 3 Triệu  │ tên triệu chứng (KHÔNG có mức độ)                    │ true       │
│   chứng  │ + allowFreeText=true                                  │            │
│ 4 Onset  │ vừa mới / vài giờ trước / từ sáng / từ hôm qua      │ false      │
│          │ + allowFreeText=true (nhập thời gian chính xác)      │            │
│ 5 Diễn   │ đang đỡ dần / vẫn như cũ / có vẻ nặng hơn            │ false      │
│   tiến   │                                                       │            │
│ 6 Red    │ dấu hiệu nguy hiểm + "không có"                      │ true       │
│   flag   │ (KHÔNG có triệu chứng thường)                         │            │
│ 7 Nguyên │ nguyên nhân + "không rõ"                               │ true       │
│   nhân   │ + allowFreeText=true                                  │            │
│ 8 Hành   │ hành động đã làm + "chưa làm gì"                     │ true       │
│   động   │                                                       │            │
│ 10 Tần   │ lần đầu / thỉnh thoảng / hay bị / gần đây nhiều hơn │ false      │
│    suất  │                                                       │            │
${conditions ? `│ 11 Thuốc │ đã uống / quên / chưa đến giờ                        │ false      │` : ''}
└──────────┴───────────────────────────────────────────────────────┴────────────┘

=== BẢNG SEVERITY KẾT LUẬN ===
┌─────────────────────────────────────┬──────────┬───────────────┬────────────┐
│ Tình huống                           │ severity │ followUpHours │ needsDoc   │
├─────────────────────────────────────┼──────────┼───────────────┼────────────┤
│ Triệu chứng nhẹ, đang đỡ            │ low      │ 6-8           │ false      │
│ Triệu chứng vừa, không red flag     │ medium   │ 3-4           │ false      │
│ User nói "rất nặng"                  │ high     │ 1-2           │ true       │
│ Red flag detected                    │ high     │ 1             │ true       │
│ Vital signs bất thường               │ high     │ 1             │ true       │
│ Triệu chứng lặp lại nhiều ngày      │ medium+  │ 2-3           │ cân nhắc   │
└─────────────────────────────────────┴──────────┴───────────────┴────────────┘

=== OUTPUT FORMAT (JSON only, KHÔNG có text thừa bên ngoài JSON) ===
Câu hỏi:
{"isDone":false,"question":"câu hỏi cá nhân hóa","options":["opt1","opt2",...],"multiSelect":true|false,"allowFreeText":false}

Kết luận:
{"isDone":true,"summary":"tóm tắt ngắn gọn triệu chứng user khai (VD: mệt mỏi, chóng mặt từ sáng, đang đỡ dần)","severity":"low|medium|high","recommendation":"lời khuyên cá nhân hóa dựa trên triệu chứng + bệnh nền","needsDoctor":false,"needsFamilyAlert":false,"hasRedFlag":false,"followUpHours":6,"closeMessage":"${selfRef} sẽ hỏi lại ${honorific} sau X tiếng nhé."}

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
      ? `Bạn là Asinu — trợ lý sức khoẻ AI thân thiện, vai trò bác sĩ gia đình theo dõi bệnh nhân định kỳ.
${honorificRule}

QUY TẮC TỐI THƯỢNG (vi phạm = lỗi hệ thống):
1. User nói "đã đỡ"/"đỡ nhiều"/"đỡ rồi" → BẮT BUỘC isDone=true NGAY. KHÔNG hỏi thêm bất kỳ câu nào.
2. KHÔNG ĐƯỢC nhắc tên triệu chứng mà user chưa bao giờ khai — chỉ dùng triệu chứng từ "Triệu chứng user đã khai" hoặc Q&A lần trước.
3. Hỏi theo 3 lớp: Trạng thái → Triệu chứng mới → Hành động. Không lặp lớp đã hỏi.
4. Red flag (đau ngực/khó thở/hoa mắt/vã mồ hôi/ngất) → isDone=true ngay, hasRedFlag=true.
5. Giọng điệu: ấm áp, ngắn gọn, quan tâm như người thân.
6. Options và câu hỏi PHẢI có đầy đủ dấu tiếng Việt chính xác (VD: "mệt mỏi" không phải "met moi").
Trả lời JSON only.`
      : `Bạn là Asinu — trợ lý sức khoẻ AI thân thiện, vai trò bác sĩ gia đình đang khám bệnh nhân.
${honorificRule}

QUY TẮC TỐI THƯỢNG (vi phạm = lỗi hệ thống):
1. KHÔNG ĐƯỢC nhắc tên triệu chứng mà user chưa bao giờ khai. Chỉ dùng triệu chứng từ "Triệu chứng user đã khai".
2. Tuân thủ 11 TYPE câu hỏi y khoa. Không lặp TYPE đã hỏi. Mỗi câu phải logic với câu trả lời trước.
3. TYPE 4 (onset), TYPE 5 (diễn tiến) PHẢI nhắc đúng triệu chứng CHÍNH user đã khai.
4. Red flag (đau ngực/khó thở/hoa mắt/vã mồ hôi/ngất) → isDone=true ngay, hasRedFlag=true.
5. Không trộn lẫn loại options (triệu chứng vs mức độ vs thời điểm).
6. Giọng điệu: ấm áp, chuyên nghiệp, dễ hiểu cho người lớn tuổi.
Trả lời JSON only.`;

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

    return getFallbackQuestion(status, phase, lang, previousAnswers, profile);
  }

  console.log(`[TriageAI] phase=${phase}, answers=${answerCount}/${maxQuestions}, min=${minQuestions}, raw:`, raw);
  try {
    let parsed = JSON.parse(raw);

    // ── Server-side enforcement: force isDone if at max questions ──
    if (!parsed.isDone && answerCount >= maxQuestions) {
      console.log(`[TriageAI] ⛔ Max questions reached (${answerCount}/${maxQuestions}). Forcing conclusion.`);
      const allSymptoms = previousAnswers.map(a => safeAns(a.answer)).join(', ');
      parsed = {
        isDone: true,
        summary: allSymptoms,
        severity: isVeryUnwell ? 'high' : 'medium',
        recommendation: lang === 'en'
          ? 'Please rest and monitor your condition. See a doctor if symptoms worsen.'
          : `${Honorific} nghỉ ngơi và theo dõi thêm nhé. Nếu tình trạng nặng hơn, ${honorific} nên đi khám bác sĩ.`,
        needsDoctor: isVeryUnwell,
        needsFamilyAlert: false,
        hasRedFlag: false,
        followUpHours: calcFollowUpHours(isVeryUnwell ? 'high' : 'medium', answerCount),
        closeMessage: lang === 'en'
          ? `I'll check back in a few hours.`
          : `${selfRef.charAt(0).toUpperCase() + selfRef.slice(1)} sẽ hỏi lại ${honorific} sau nhé.`,
      };
    }

    // ── Server-side enforcement: block early isDone ──
    // Allow early isDone in follow-up if user says they've improved
    const IMPROVED_KW = ['đã đỡ', 'đỡ nhiều', 'đỡ rồi', 'hết rồi', 'ổn rồi', 'better', 'improved', 'đang đỡ'];
    const userImproved = phase === 'followup' && previousAnswers.some(a =>
      IMPROVED_KW.some(kw => safeAns(a.answer).includes(kw))
    );
    // ── Follow-up: force isDone if user said improved but AI didn't comply ──
    if (userImproved && !parsed.isDone) {
      console.log(`[TriageAI] 🟢 User said improved but AI didn't set isDone=true. Forcing conclusion.`);
      const allSymptoms = previousAnswers.map(a => a.answer).join(', ');
      parsed = {
        isDone: true,
        progression: 'improved',
        summary: allSymptoms,
        severity: 'low',
        recommendation: lang === 'en'
          ? 'Good to hear you\'re feeling better! Keep resting and I\'ll check back later.'
          : 'Vui vì bạn đã đỡ hơn! Tiếp tục nghỉ ngơi, tôi sẽ hỏi lại sau nhé.',
        needsDoctor: false,
        needsFamilyAlert: false,
        hasRedFlag: false,
        followUpHours: 6,
        closeMessage: lang === 'en' ? 'I\'ll check back in about 6 hours.' : `${selfRef} sẽ hỏi lại ${honorific} sau khoảng 6 tiếng nhé.`,
      };
    }
    if (parsed.isDone && answerCount < minQuestions && !parsed.hasRedFlag && !userImproved) {
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
      const answersText = previousAnswers.map(a => safeAns(a.answer)).join(' ');
      if (HIGH_SEVERITY_KEYWORDS.some(kw => answersText.includes(kw))) {
        if (parsed.severity !== 'high') {
          console.log(`[TriageAI] ⚠️ Severity override: AI returned "${parsed.severity}" but answers contain high-severity keyword → forcing "high"`);
          parsed.severity = 'high';
        }
      }
    }

    // ── TYPE repeat guard: if AI repeats an already-used TYPE, force next TYPE ──
    if (!parsed.isDone && parsed.question && usedTypes.size > 0) {
      const q = parsed.question.toLowerCase();
      let detectedType = null;
      if (q.includes('triệu chứng') || q.includes('symptoms') || q.includes('tình trạng nào') || q.includes('gặp phải')) detectedType = 3;
      else if (q.includes('mức độ') || q.includes('how severe') || q.includes('khó chịu')) detectedType = 2;
      else if (q.includes('bắt đầu') || q.includes('từ khi nào') || q.includes('từ lúc nào') || q.includes('when did')) detectedType = 4;
      else if (q.includes('thay đổi') || q.includes('đỡ hơn') || q.includes('nặng hơn') || q.includes('diễn tiến')) detectedType = 5;

      if (detectedType && usedTypes.has(detectedType)) {
        console.log(`[TriageAI] ⛔ TYPE ${detectedType} repeat blocked. Forcing next unused TYPE.`);
        // Pick next TYPE from flow order that hasn't been used
        const flowOrder = status === 'very_tired' ? [3, 6, 2, 4, 5, 7, 8] : [3, 4, 5, 7, 8, 2, 10];
        const nextType = flowOrder.find(t => !usedTypes.has(t));
        const primarySymptom = [...knownSymptoms][0] || '';
        const fallbackByType = {
          4: { q: lang === 'en' ? `When did these symptoms start?`
                : primarySymptom
                  ? `${Honorific} bị các triệu chứng trên từ lúc nào vậy? ${Honorific} chọn hoặc cho ${selfRef} biết thời gian chính xác nhé.`
                  : `${Honorific} bị từ lúc nào vậy? ${Honorific} chọn hoặc cho ${selfRef} biết thời gian chính xác nhé.`,
               opts: lang === 'en' ? ['just now', 'a few hours ago', 'since morning', 'since yesterday', 'a few days']
                : ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay'],
               multi: false, freeText: true },
          5: { q: lang === 'en' ? 'Has your condition changed since it started?'
                : `Từ lúc bắt đầu đến giờ ${honorific} thấy đỡ hơn chưa, hay vẫn vậy?`,
               opts: lang === 'en' ? ['getting better', 'about the same', 'getting worse']
                : ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'],
               multi: false, freeText: false },
          7: { q: lang === 'en' ? 'What might have caused this?'
                : `${Honorific} có nhớ gần đây ngủ ít, bỏ bữa hay căng thẳng gì không?`,
               opts: lang === 'en' ? ['lack of sleep', 'skipped meals', 'stress', 'missed medication', 'not sure']
                : ['ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ'],
               multi: true, freeText: true },
          8: { q: lang === 'en' ? 'Have you done anything to feel better?'
                : `${Honorific} có nghỉ ngơi hay uống thuốc gì chưa?`,
               opts: lang === 'en' ? ['rested', 'ate something', 'drank water', 'took medication', 'nothing yet']
                : ['nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì'],
               multi: true, freeText: false },
          2: { q: lang === 'en' ? 'How severe is it right now?'
                : `${Honorific} thấy mức độ khó chịu hiện tại thế nào?`,
               opts: lang === 'en' ? ['mild', 'moderate', 'quite severe']
                : ['nhẹ', 'trung bình', 'khá nặng'],
               multi: false, freeText: false },
          6: { q: lang === 'en' ? 'Do you have any of these warning signs?'
                : `Ngoài ra ${honorific} có thấy dấu hiệu nào dưới đây không?`,
               opts: lang === 'en' ? ['chest pain', 'shortness of breath', 'fainting', 'cold sweat', 'none']
                : ['đau ngực', 'khó thở', 'hoa mắt', 'vã mồ hôi', 'không có'],
               multi: true, freeText: false },
          10: { q: lang === 'en' ? 'Does this happen often?'
                : `Tình trạng này ${honorific} có hay bị không?`,
               opts: lang === 'en' ? ['first time', 'occasionally', 'often', 'more often recently']
                : ['lần đầu', 'thỉnh thoảng', 'hay bị', 'gần đây bị nhiều hơn'],
               multi: false, freeText: false },
        };
        const fb = fallbackByType[nextType] || fallbackByType[4];
        parsed = { isDone: false, question: fb.q, options: fb.opts, multiSelect: fb.multi, allowFreeText: fb.freeText || false };
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

    // ── Hallucination guard: if AI mentions a symptom user never reported in onset/progression questions, fix it ──
    if (!parsed.isDone && parsed.question && knownSymptoms.size > 0) {
      const q = parsed.question.toLowerCase();
      const isOnsetOrProgressionQ = q.includes('bắt đầu') || q.includes('từ khi nào') || q.includes('when did')
        || q.includes('thay đổi') || q.includes('diễn tiến') || q.includes('thế nào rồi');
      if (isOnsetOrProgressionQ) {
        // Check if question mentions a symptom user never reported
        const COMMON_SYMPTOMS = ['đau đầu', 'chóng mặt', 'buồn nôn', 'mệt mỏi', 'khát nước', 'ăn không ngon',
          'đau bụng', 'khó thở', 'đau ngực', 'hoa mắt', 'mất ngủ', 'sốt',
          'headache', 'dizziness', 'nausea', 'fatigue', 'chest pain'];
        const mentionedInQ = COMMON_SYMPTOMS.filter(s => q.includes(s));
        const unmentionedByUser = mentionedInQ.filter(s => !knownSymptoms.has(s));
        if (unmentionedByUser.length > 0 && knownSymptoms.size > 0) {
          // Replace with the first known symptom that's in COMMON_SYMPTOMS list (not raw free text)
          const knownCommon = COMMON_SYMPTOMS.filter(s => [...knownSymptoms].some(ks => ks.includes(s)));
          const primarySymptom = knownCommon[0] || [...knownSymptoms][0];
          // Only replace if primarySymptom is short (actual symptom name, not free text)
          if (primarySymptom.length > 30) return; // skip if it's a long free text answer
          let fixedQ = parsed.question;
          for (const wrong of unmentionedByUser) {
            fixedQ = fixedQ.replace(new RegExp(wrong, 'gi'), primarySymptom);
          }
          console.log(`[TriageAI] ⚠️ Hallucination fix: replaced "${unmentionedByUser.join(', ')}" with "${primarySymptom}" in question`);
          parsed.question = fixedQ;
        }
      }
    }

    // ── Self-validation: fix common AI mistakes before returning ──
    if (!parsed.isDone && parsed.question && parsed.options) {
      const q = parsed.question.toLowerCase();
      const opts = parsed.options.map(o => o.toLowerCase());

      // 1. Onset question (TYPE 4): nếu user chọn nhiều triệu chứng nhưng AI chỉ nhắc 1
      const isOnsetQ = q.includes('từ lúc nào') || q.includes('từ khi nào') || q.includes('bắt đầu từ') || q.includes('when did');
      if (isOnsetQ && knownSymptoms.size > 1) {
        // Kiểm tra AI có chỉ nhắc 1 triệu chứng không
        const COMMON_SYMPTOMS = ['đau đầu', 'chóng mặt', 'buồn nôn', 'mệt mỏi', 'khát nước', 'ăn không ngon',
          'đau bụng', 'khó thở', 'đau ngực', 'hoa mắt', 'mất ngủ', 'sốt', 'tức ngực', 'vã mồ hôi'];
        const mentionedInQ = COMMON_SYMPTOMS.filter(s => q.includes(s));
        if (mentionedInQ.length === 1) {
          // Thay bằng "các triệu chứng trên"
          let fixedQ = parsed.question;
          for (const sym of mentionedInQ) {
            fixedQ = fixedQ.replace(new RegExp(sym, 'gi'), 'các triệu chứng trên');
          }
          console.log(`[TriageAI] ⚠️ Onset fix: user có ${knownSymptoms.size} triệu chứng nhưng AI chỉ nhắc "${mentionedInQ[0]}" → đổi thành "các triệu chứng trên"`);
          parsed.question = fixedQ;
        }
        // Force allowFreeText=true cho onset (nhập thời gian chính xác)
        if (!parsed.allowFreeText) {
          parsed.allowFreeText = true;
          console.log(`[TriageAI] ⚠️ Onset fix: forced allowFreeText=true cho câu hỏi thời gian`);
        }
      }

      // 2. multiSelect validation dựa theo loại options
      const TIME_OPTS = ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay', 'just now', 'few hours ago'];
      const PROGRESSION_OPTS = ['đang đỡ', 'đỡ dần', 'vẫn như cũ', 'vẫn vậy', 'nặng hơn', 'getting better', 'same', 'worse'];
      const SEVERITY_OPTS = ['nhẹ', 'trung bình', 'khá nặng', 'rất nặng', 'mild', 'moderate', 'severe'];
      const isTimeOpts = opts.some(o => TIME_OPTS.some(t => o.includes(t)));
      const isProgressionOpts = opts.some(o => PROGRESSION_OPTS.some(p => o.includes(p)));
      const isSeverityOpts = opts.some(o => SEVERITY_OPTS.some(s => o === s))
        || (q.includes('mức') && (q.includes('nào') || q.includes('độ')))
        || q.includes('nặng thế nào') || q.includes('how severe');
      // Các loại chỉ chọn 1 → force multiSelect=false
      if ((isTimeOpts || isProgressionOpts || isSeverityOpts) && parsed.multiSelect === true) {
        console.log(`[TriageAI] ⚠️ multiSelect fix: forced multiSelect=false`);
        parsed.multiSelect = false;
      }
      // very_tired: severity options không được có "nhẹ"
      if (isVeryUnwell && isSeverityOpts) {
        const filtered = parsed.options.filter(o => !['nhẹ', 'mild'].includes(o.toLowerCase().trim()));
        if (filtered.length >= 2) {
          parsed.options = filtered;
          // Đảm bảo có "rất nặng"
          if (!filtered.some(o => o.toLowerCase().includes('rất nặng') || o.toLowerCase().includes('very severe'))) {
            parsed.options.push(lang === 'en' ? 'very severe' : 'rất nặng');
          }
          console.log(`[TriageAI] ⚠️ very_tired severity fix: removed "nhẹ", ensured "rất nặng"`);
        }
      }

      // 3. Chống trùng lặp: nếu question có 2 câu hỏi cùng ý
      const sentences = parsed.question.split(/[?？]/).filter(s => s.trim().length > 5);
      if (sentences.length >= 2) {
        const s1 = sentences[0].toLowerCase();
        const s2 = sentences[1].toLowerCase();
        const OVERLAP_PAIRS = [
          ['thay đổi', 'đỡ hơn'], ['thay đổi', 'vẫn vậy'], ['thay đổi', 'nặng hơn'],
          ['đỡ hơn', 'đỡ dần'], ['thế nào', 'đỡ hơn chưa'],
        ];
        const isDuplicate = OVERLAP_PAIRS.some(([a, b]) => (s1.includes(a) && s2.includes(b)) || (s1.includes(b) && s2.includes(a)));
        if (isDuplicate) {
          // Giữ câu đầu, bỏ câu sau
          parsed.question = sentences[0].trim() + '?';
          console.log(`[TriageAI] ⚠️ Duplicate fix: 2 câu cùng ý → giữ câu đầu`);
        }
      }
    }

    // ── Clinical override: condition-specific severity escalation ──
    if (parsed.isDone && conditions) {
      const condLower = conditions.toLowerCase();
      const answersJoined = previousAnswers.map(a => safeAns(a.answer)).join(' ');
      const hasHypertension = condLower.includes('huyết áp') || condLower.includes('hypertension');
      const hasDiabetes = condLower.includes('tiểu đường') || condLower.includes('diabetes');
      const hasHeartDisease = condLower.includes('tim') || condLower.includes('heart');
      const hasHeadacheDizziness = answersJoined.includes('đau đầu') || answersJoined.includes('chóng mặt') || answersJoined.includes('headache');
      const isWorsening = answersJoined.includes('nặng hơn') || answersJoined.includes('tệ hơn') || answersJoined.includes('worse');
      const missedMeds = answersJoined.includes('quên thuốc') || answersJoined.includes('quên uống') || answersJoined.includes('missed med');
      const hasThirst = answersJoined.includes('khát nước') || answersJoined.includes('thirst');
      const hasChestPain = answersJoined.includes('tức ngực') || answersJoined.includes('đau ngực') || answersJoined.includes('chest');

      // Cao huyết áp + đau đầu/chóng mặt + nặng hơn → high
      if (hasHypertension && hasHeadacheDizziness && isWorsening && parsed.severity !== 'high') {
        console.log(`[TriageAI] ⚠️ Clinical: hypertension + headache + worsening → high`);
        parsed.severity = 'high'; parsed.needsDoctor = true;
      }
      // Tiểu đường + khát nước/quên thuốc → needsDoctor=true, severity at least medium
      if (hasDiabetes && (hasThirst || missedMeds)) {
        if (!parsed.needsDoctor) {
          console.log(`[TriageAI] ⚠️ Clinical: diabetes + thirst/missed meds → needsDoctor=true`);
          parsed.needsDoctor = true;
        }
        if (parsed.severity === 'low') parsed.severity = 'medium';
        // Elderly diabetic + missed meds + symptoms → escalate to high
        if (missedMeds && hasThirst && age >= 60 && parsed.severity !== 'high') {
          console.log(`[TriageAI] ⚠️ Clinical: elderly diabetic + missed meds + thirst → high`);
          parsed.severity = 'high';
        }
      }
      // Bệnh tim + tức ngực/khó thở → high
      if (hasHeartDisease && hasChestPain && parsed.severity !== 'high') {
        console.log(`[TriageAI] ⚠️ Clinical: heart disease + chest pain → high`);
        parsed.severity = 'high'; parsed.needsDoctor = true;
      }
      // Quên thuốc + bệnh nền → bump severity + needsDoctor
      if (missedMeds && (hasDiabetes || hasHypertension || hasHeartDisease)) {
        if (parsed.severity === 'low') parsed.severity = 'medium';
        if (!parsed.needsDoctor) {
          console.log(`[TriageAI] ⚠️ Clinical: missed meds + conditions → needsDoctor`);
          parsed.needsDoctor = true;
        }
      }
    }

    // ── needsFamilyAlert enforcement ──
    if (parsed.isDone && !parsed.needsFamilyAlert) {
      const shouldAlert = (parsed.severity === 'high' && age >= 60)
        || parsed.hasRedFlag
        || (parsed.severity === 'high' && conditions);
      if (shouldAlert) {
        console.log(`[TriageAI] ⚠️ needsFamilyAlert forced true (severity=${parsed.severity}, age=${age}, conditions=${!!conditions})`);
        parsed.needsFamilyAlert = true;
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

    // ── "bạn" leak fix: AFTER safety filter to catch any appended text ──
    if (honorific !== 'bạn') {
      const fixBan = (text) => {
        if (!text || typeof text !== 'string') return text;
        return text.replace(/bạn/g, honorific).replace(/Bạn/g, Honorific);
      };
      for (const f of ['question', 'summary', 'recommendation', 'closeMessage']) {
        if (parsed[f]) parsed[f] = fixBan(parsed[f]);
      }
    }

    console.log(`[TriageAI] isDone=${parsed.isDone}, question=${parsed.question || 'N/A'}`);
    return parsed;
  } catch (parseErr) {
    console.error(`[TriageAI] JSON parse failed, using fallback:`, parseErr?.message);
    return getFallbackQuestion(status, phase, lang, previousAnswers, profile);
  }
}

module.exports = { getNextTriageQuestion, buildContinuityMessage, calcFollowUpHours, getFallbackQuestion };
