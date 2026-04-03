'use strict';

/**
 * Triage Chat — Chat-based triage for Asinu Health Companion
 *
 * Replaces the old button/option-based triage with free-form conversation.
 * User types naturally, AI responds like a Vietnamese family doctor.
 *
 * Architecture:
 *   1. Build system prompt (honorifics + profile + health context + clinical rules)
 *   2. Send conversation history to GPT
 *   3. GPT responds naturally as the doctor
 *   4. Server-side post-processing on EVERY response:
 *      a. Emergency detection on all user messages (keyword-based, no AI)
 *      b. Tag detection ([TRIAGE_DONE], [EMERGENCY])
 *      c. Turn-count guard (force conclusion after 8 turns)
 *      d. Deterministic severity calculation when concluding
 */

const OpenAI = require('openai');
const { getHonorifics } = require('../../lib/honorifics');
const { detectEmergency, isRedFlag, getRedFlags } = require('./emergency-detector');
const { resolveComplaint } = require('./clinical-mapping');
const { filterTriageResult } = require('../ai/ai-safety.service');
const { logAiInteraction } = require('../ai/ai-logger.service');

// ─── Constants ─────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const TRIAGE_MODEL = process.env.TRIAGE_CHAT_MODEL || 'gpt-4o';
const TRIAGE_TEMPERATURE = 0.6; // Slightly lower than general chat for clinical accuracy
const TRIAGE_MAX_TOKENS = 500;
const MAX_TURNS = 8; // Force conclusion after this many user turns
const OPENAI_TIMEOUT_MS = 30_000;

// ─── OpenAI client (singleton) ─────────────────────────────────────────────

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── System Prompt Builder ─────────────────────────────────────────────────

/**
 * Build the system prompt that instructs GPT to act as Asinu — a Vietnamese
 * family doctor conducting a health check-in via natural conversation.
 *
 * @param {Object} profile - { birth_year, gender, full_name, medical_conditions }
 * @param {Object} healthContext - { previousCheckins, recentGlucose, recentBP, medications, ... }
 * @param {string|null} previousSessionSummary - Summary from yesterday's session
 * @returns {string}
 */
function buildSystemPrompt(profile, healthContext = {}, previousSessionSummary = null, simulatedHour = null) {
  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang: 'vi',
  });

  const age = profile.birth_year ? CURRENT_YEAR - profile.birth_year : null;
  const conditions = (profile.medical_conditions || []).join(', ') || 'Không';

  let vnTime;
  if (simulatedHour !== null && simulatedHour !== undefined) {
    const tod = simulatedHour < 12 ? 'sáng' : simulatedHour < 18 ? 'chiều' : 'tối';
    vnTime = `${simulatedHour}:00 (buổi ${tod}) [giả lập test]`;
  } else {
    vnTime = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long' });
  }

  return `Bạn là Asinu — người bạn thân quan tâm sức khỏe ${h.callName}.

Xưng hô: "${h.honorific}" / "${h.selfRef}". Tiếng Việt có dấu. 1-2 emoji mỗi tin. Ấm áp, chân thành.
Bây giờ là: ${vnTime} (giờ Việt Nam)

Người dùng: ${profile.full_name || ''}, ${age ? age + ' tuổi' : ''}, bệnh nền: ${conditions}
${previousSessionSummary ? 'Check-in trước: ' + previousSessionSummary + '\n→ Khi mở đầu follow-up, PHẢI nhắc RÕ nội dung này. VD: "Lúc trước chú nói bị ' + previousSessionSummary + '. Giờ chú thấy thế nào rồi?"' : ''}

Bạn đang check-in sức khỏe hàng ngày. Nhìn lịch sử chat để biết ngữ cảnh.

Nguyên tắc:
- User nói ổn/khỏe/bình thường/ok/fine/khoe/on (kể cả 1 từ ngắn) → kết luận NGAY, hẹn giờ phù hợp, KHÔNG hỏi thêm
- User nói không khỏe → hỏi theo tư duy bác sĩ: triệu chứng gì → từ khi nào → đỡ/vậy/nặng → nguyên nhân → đã làm gì → kết luận
- Khi hỏi triệu chứng: hỏi MỞ, KHÔNG liệt kê ví dụ. Để user tự mô tả. VD: "Chú thấy khó chịu chỗ nào vậy? 😟"
- Giọng điệu quan tâm, tự nhiên, KHÔNG sến, KHÔNG than thở ("Ôi", "trời ơi"). VD: "Chú cố gắng nghỉ ngơi nha 💙", "Cháu sẽ theo dõi cùng chú nhé 😊"
- Mỗi lần 1 câu, ngắn gọn, tự nhiên, không hỏi lại cái đã biết
- 5-8 câu rồi PHẢI kết luận. Sau 5 câu hỏi, nếu đã biết: triệu chứng gì + từ khi nào + đỡ hay nặng → kết luận NGAY dù thông tin chưa hoàn hảo
- Follow-up chỉ 2-3 câu: đỡ chưa → có gì mới → kết luận
- Hẹn follow-up:
  + Ổn/khỏe + đang sáng/chiều → hẹn 9h tối nay
  + Ổn/khỏe + đang tối (sau 20h) → chúc ngủ ngon + hẹn sáng mai
  + Hơi mệt → hẹn SAU 3 TIẾNG (VD: bây giờ 14h → hẹn 17h)
  + Rất mệt → hẹn SAU 1 TIẾNG (VD: bây giờ 14h → hẹn 15h)
  + KHÔNG hẹn 9h tối cho "hơi mệt" hay "rất mệt" — phải hẹn sớm hơn

Khi kết luận, thêm ở cuối:
[SUMMARY: tóm tắt]
[SEVERITY: low/medium/high]
[NEEDS_DOCTOR: true/false]
[FOLLOW_UP_HOURS: số giờ]
[TRIAGE_DONE]

Cấp cứu (đau ngực+khó thở, yếu nửa người, co giật...) → "GỌI 115 NGAY" + [EMERGENCY]`;
}

// ─── GPT Call ──────────────────────────────────────────────────────────────

/**
 * Send the conversation to GPT and get the doctor's response.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} history - Full conversation history
 * @param {string} userMessage - Current user message
 * @returns {Promise<{reply: string, meta: Object}>}
 */
async function callGPT(systemPrompt, history, userMessage) {
  const client = getClient();

  // Build messages array: system + history + current message
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model: TRIAGE_MODEL,
    messages,
    temperature: TRIAGE_TEMPERATURE,
    max_completion_tokens: TRIAGE_MAX_TOKENS,
    top_p: 1,
    frequency_penalty: 0.3,
    presence_penalty: 0.3,
  });

  const choice = response.choices[0];
  const reply = (choice.message.content || '').trim();

  return {
    reply,
    meta: {
      model: response.model,
      finish_reason: choice.finish_reason,
      tokens_used: response.usage ? {
        prompt: response.usage.prompt_tokens,
        completion: response.usage.completion_tokens,
        total: response.usage.total_tokens,
      } : undefined,
    },
  };
}

// ─── Conversation Analysis ─────────────────────────────────────────────────

/**
 * Extract all user messages from conversation history + current message.
 *
 * @param {Array<{role: string, content: string}>} history
 * @param {string} currentMessage
 * @returns {string[]}
 */
function extractUserMessages(history, currentMessage) {
  const messages = (history || [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content);
  if (currentMessage) messages.push(currentMessage);
  return messages;
}

/**
 * Count the number of completed user turns (messages from user in history).
 *
 * @param {Array<{role: string, content: string}>} history
 * @returns {number}
 */
function countUserTurns(history) {
  return (history || []).filter((m) => m.role === 'user').length;
}

/**
 * Detect progression status from conversation text.
 * Looks for Vietnamese keywords indicating better/same/worse.
 *
 * @param {string} text - Combined user messages
 * @returns {'better'|'same'|'worse'|null}
 */
function detectProgression(text) {
  const lower = text.toLowerCase();

  // Worse indicators (có dấu + không dấu)
  const worseKw = [
    'nặng hơn', 'nang hon', 'tệ hơn', 'te hon', 'xấu hơn', 'xau hon',
    'nhiều hơn', 'nhieu hon', 'tăng lên', 'tang len',
    'ngày càng', 'ngay cang', 'đau hơn', 'dau hon',
    'khó chịu hơn', 'kho chiu hon', 'không chịu nổi', 'khong chiu noi',
    'trầm trọng', 'tram trong', 'dữ dội hơn', 'du doi hon',
  ];
  if (worseKw.some((kw) => lower.includes(kw))) return 'worse';

  // Better indicators (có dấu + không dấu)
  // QUAN TRỌNG: "do" đơn lẻ KHÔNG match (quá ngắn, dễ false positive)
  // Phải match cụm: "do hon", "do roi", "do nhieu", "da do"
  const betterKw = [
    'đỡ hơn', 'do hon', 'giảm', 'giam',
    'khá hơn', 'kha hon', 'đỡ rồi', 'do roi', 'nhẹ hơn', 'nhe hon',
    'tốt hơn', 'tot hon', 'ổn hơn', 'on hon', 'bớt đau', 'bot dau',
    'đỡ đau', 'do dau', 'khỏe hơn', 'khoe hon', 'đỡ nhiều', 'do nhieu',
    'đã đỡ', 'da do', 'bớt mệt', 'bot met', 'bớt đau', 'bot dau',
    'khỏe rồi', 'khoe roi', 'ổn rồi', 'on roi', 'hết rồi', 'het roi',
  ];
  if (betterKw.some((kw) => lower.includes(kw))) return 'better';

  // Same indicators (có dấu + không dấu)
  const sameKw = [
    'vẫn vậy', 'van vay', 'vẫn như cũ', 'van nhu cu',
    'không đổi', 'khong doi', 'y như cũ', 'y nhu cu',
    'vẫn còn', 'van con', 'chưa đỡ', 'chua do',
    'không khá hơn', 'khong kha hon', 'vẫn thế', 'van the',
    'vẫn mệt', 'van met', 'vẫn đau', 'van dau',
    'vẫn khó', 'van kho', 'vẫn tê', 'van te',
    'vẫn chóng', 'van chong', 'chưa hết', 'chua het',
    'không giảm', 'khong giam', 'chưa giảm', 'chua giam',
  ];
  if (sameKw.some((kw) => lower.includes(kw))) return 'same';

  return null;
}

/**
 * Try to resolve the chief complaint from user messages using clinical-mapping.
 * Scans all user messages and returns the first resolved complaint.
 *
 * @param {string[]} userMessages
 * @returns {{ key: string, data: Object }|null}
 */
function resolveChiefComplaint(userMessages) {
  for (const msg of userMessages) {
    const resolved = resolveComplaint(msg);
    if (resolved) return resolved;

    // Try individual phrases (split by commas, periods, "và", "với")
    const parts = msg.split(/[,.\n]|(?:\svà\s)|(?:\svới\s)/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 1) {
        const resolved2 = resolveComplaint(trimmed);
        if (resolved2) return resolved2;
      }
    }
  }
  return null;
}

// ─── Severity Calculation (Deterministic) ──────────────────────────────────

/**
 * Calculate triage severity from conversation content.
 * Uses the same deterministic rules as triage-engine.js calculateConclusion().
 *
 * @param {string[]} allUserMessages - All user messages in the conversation
 * @param {Object} profile - { birth_year, gender, medical_conditions }
 * @returns {{
 *   severity: string,
 *   needsDoctor: boolean,
 *   needsFamilyAlert: boolean,
 *   hasRedFlag: boolean,
 *   followUpHours: number,
 *   summary: string,
 *   recommendation: string,
 * }}
 */
function calculateSeverity(allUserMessages, profile) {
  const combinedText = allUserMessages.join(' ').toLowerCase();
  const age = profile.birth_year ? CURRENT_YEAR - profile.birth_year : null;
  const isElderly = age !== null && age >= 60;
  const conditions = profile.medical_conditions || [];
  const hasConditions = conditions.length > 0;

  // Check for red flags across all messages
  const redFlags = getRedFlags(combinedText);
  const hasRedFlag = redFlags.length > 0;

  // Detect progression from conversation
  const progression = detectProgression(combinedText);

  // Resolve chief complaint for context
  const complaint = resolveChiefComplaint(allUserMessages);

  // ── Check if user said they're fine ──
  const fineKw = ['tôi ổn', 'toi on', 'bình thường', 'binh thuong', 'khỏe rồi', 'khoe roi', 'khỏe', 'khoe', 'ổn rồi', 'on roi', 'vẫn ổn', 'van on', 'tôi khỏe', 'toi khoe', 'đỡ rồi', 'do roi', 'đã đỡ', 'da do', 'đỡ nhiều', 'do nhieu', 'đỡ hơn', 'do hon', 'fine', 'ok', 'không sao', 'khong sao', 'hết rồi', 'het roi', 'ổn cháu', 'on chau', 'khỏe cháu', 'khoe chau', 'ổn chị', 'on chi'];
  // Check thêm: nếu user chỉ nhắn 1-2 từ ngắn và là "ổn"/"on"/"ok"/"fine"/"khỏe"/"khoe" → coi như fine
  const shortFineWords = ['ổn', 'on', 'ok', 'fine', 'khỏe', 'khoe'];
  const isShortFine = allUserMessages.some(m => {
    const trimmed = m.trim().toLowerCase();
    return trimmed.length <= 10 && shortFineWords.some(w => trimmed === w || trimmed.startsWith(w + ' '));
  });
  const userSaidFine = allUserMessages.some(m => fineKw.some(kw => m.toLowerCase().includes(kw))) || isShortFine;

  // ── Severity rules ──

  let severity = 'low';

  if (userSaidFine && !hasRedFlag && progression !== 'worse') {
    // User nói ổn + không có red flag + không nặng hơn → low
    severity = 'low';
  } else if (hasRedFlag) {
    severity = 'high';
  } else if (progression === 'worse') {
    severity = (isElderly || hasConditions) ? 'high' : 'medium';
  } else if (progression === 'same' && (isElderly || hasConditions)) {
    severity = 'medium';
  } else if (isElderly && hasConditions && !userSaidFine) {
    // Elderly + conditions + không nói ổn → minimum medium
    severity = 'medium';
  }

  // ── needsDoctor ──

  let needsDoctor = false;
  if (userSaidFine && !hasRedFlag) {
    needsDoctor = false; // Nói ổn + không red flag → không cần bác sĩ
  } else {
    if (severity === 'high') needsDoctor = true;
    if (isElderly && hasConditions && severity !== 'low') needsDoctor = true;
    if (hasRedFlag) needsDoctor = true;
    if (progression === 'worse') needsDoctor = true;
  }

  // ── followUpHours ──
  // Tính theo giờ VN hiện tại
  const now = new Date();
  const vnHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }));

  let followUpHours;
  if (userSaidFine && !hasRedFlag) {
    // "Tôi ổn" → hẹn 21h tối, nếu đã tối → hẹn 7h sáng mai
    followUpHours = vnHour < 18 ? (21 - vnHour) : (24 - vnHour + 7);
  } else if (severity === 'high') {
    // "Rất mệt" / red flag → sau 1 tiếng
    followUpHours = 1;
  } else if (severity === 'medium') {
    // "Hơi mệt" → sau 3 tiếng
    followUpHours = 3;
  } else {
    followUpHours = 4;
  }
  // Nếu hẹn rơi vào quá 22h → dời sang sáng mai 7h
  const followUpVnHour = vnHour + followUpHours;
  if (followUpVnHour >= 22) {
    followUpHours = (24 - vnHour) + 7; // tới 7h sáng mai
  }

  // ── needsFamilyAlert ──

  let needsFamilyAlert = false;
  if (severity === 'high' && (isElderly || hasConditions)) {
    needsFamilyAlert = true;
  }
  if (hasRedFlag) needsFamilyAlert = true;

  // ── Summary & recommendation ──

  let summary;
  let recommendation;

  if (userSaidFine) {
    summary = 'Cảm thấy ổn, không có vấn đề gì đặc biệt';
    recommendation = 'Tiếp tục nghỉ ngơi, uống đủ nước. Theo dõi và báo lại nếu có thay đổi.';
  } else {
    const complaintName = complaint ? complaint.key : '';
    const progressionText = progression === 'worse' ? ', đang nặng hơn'
      : progression === 'same' ? ', chưa đỡ'
      : progression === 'better' ? ', đang đỡ dần'
      : '';

    summary = complaintName
      ? `${complaintName}${progressionText}`
      : `Không khoẻ${progressionText}`;

    if (severity === 'high') {
      recommendation = needsDoctor
        ? 'Nên đến khám bác sĩ trong hôm nay. Theo dõi sát triệu chứng.'
        : 'Theo dõi sát triệu chứng. Nếu nặng hơn, đến bệnh viện ngay.';
    } else if (severity === 'medium') {
      recommendation = 'Nghỉ ngơi và theo dõi. Nếu không cải thiện trong vài giờ tới, nên đi khám.';
    } else {
      recommendation = 'Tiếp tục nghỉ ngơi, uống đủ nước. Theo dõi và báo lại nếu có thay đổi.';
    }
  }

  return {
    severity,
    needsDoctor,
    needsFamilyAlert,
    hasRedFlag,
    followUpHours,
    summary,
    recommendation,
    isElderly,
    hasConditions,
    userSaidFine,
  };
}

// ─── Post-Processing: Analyze GPT Response ────────────────────────────────

/**
 * Analyze the GPT response and all conversation data to decide:
 *   - Is this an emergency?
 *   - Is triage complete?
 *   - Should we force-conclude?
 *
 * Runs AFTER every GPT response. This is the safety net — even if GPT misses
 * an emergency, the keyword-based detector will catch it.
 *
 * @param {string} reply - GPT's raw response text
 * @param {Array<{role: string, content: string}>} history - Previous messages
 * @param {string} currentUserMessage - The user message that triggered this response
 * @param {Object} profile - User profile
 * @returns {{
 *   isDone: boolean,
 *   severity?: string,
 *   summary?: string,
 *   recommendation?: string,
 *   needsDoctor?: boolean,
 *   needsFamilyAlert?: boolean,
 *   hasRedFlag?: boolean,
 *   followUpHours?: number,
 *   forceEmergency?: Object,
 *   forceConclude?: boolean,
 * }}
 */
function analyzeResponse(reply, history, currentUserMessage, profile, previousSessionSummary = null) {
  const allUserMessages = extractUserMessages(history, currentUserMessage);

  // ── 1. Check for [EMERGENCY] tag from GPT ──
  if (reply.includes('[EMERGENCY]')) {
    return {
      isDone: true,
      severity: 'critical',
      hasRedFlag: true,
      needsDoctor: true,
      needsFamilyAlert: true,
      followUpHours: 0,
      summary: 'Phát hiện tình trạng nguy hiểm cần cấp cứu.',
      recommendation: 'Gọi cấp cứu 115 hoặc đến bệnh viện ngay lập tức.',
    };
  }

  // ── 2. Check for [TRIAGE_DONE] tag from GPT ──
  if (reply.includes('[TRIAGE_DONE]')) {
    // Parse all tags from AI response
    const summaryMatch = reply.match(/\[SUMMARY:\s*(.+?)\]/i);
    const severityMatch = reply.match(/\[SEVERITY:\s*(.+?)\]/i);
    const doctorMatch = reply.match(/\[NEEDS_DOCTOR:\s*(.+?)\]/i);
    const followUpMatch = reply.match(/\[FOLLOW_UP_HOURS:\s*(.+?)\]/i);

    const aiSeverity = severityMatch ? severityMatch[1].trim().toLowerCase() : null;
    const aiNeedsDoctor = doctorMatch ? doctorMatch[1].trim().toLowerCase() === 'true' : null;
    const aiFollowUpHours = followUpMatch ? parseInt(followUpMatch[1].trim()) : null;
    const aiSummary = summaryMatch ? summaryMatch[1].trim() : null;

    // Fallback: tính server-side nếu AI không trả tag
    const serverResult = calculateSeverity(allUserMessages, profile);

    // Severity: lấy CAO HƠN giữa AI và server, TRỪ KHI user nói ổn
    const sevOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    let finalSev;
    if (serverResult.severity === 'low' && serverResult.userSaidFine) {
      finalSev = 'low';
    } else {
      finalSev = (aiSeverity && sevOrder[aiSeverity] !== undefined)
        ? (sevOrder[aiSeverity] >= sevOrder[serverResult.severity] ? aiSeverity : serverResult.severity)
        : serverResult.severity;
    }

    // needsDoctor: true nếu bất kỳ bên nào nói true, TRỪ KHI user nói ổn
    const finalDoc = serverResult.userSaidFine ? false : ((aiNeedsDoctor === true) || serverResult.needsDoctor);

    const followUpHours = aiFollowUpHours && aiFollowUpHours > 0 ? aiFollowUpHours : serverResult.followUpHours;
    const summary = aiSummary || serverResult.summary;
    const hasRedFlag = serverResult.hasRedFlag;
    const needsFamilyAlert = (finalSev === 'high' || hasRedFlag) && (serverResult.isElderly || serverResult.hasConditions);

    return {
      isDone: true,
      severity: hasRedFlag ? 'high' : finalSev,
      needsDoctor: hasRedFlag ? true : finalDoc,
      needsFamilyAlert,
      hasRedFlag,
      followUpHours,
      summary,
      recommendation: serverResult.recommendation,
    };
  }

  // ── 3. Run emergency detection on ALL user messages (safety net) ──
  // This catches emergencies even if GPT didn't recognize them.
  const emergency = detectEmergency(allUserMessages, {
    birth_year: profile.birth_year,
    gender: profile.gender,
    medical_conditions: profile.medical_conditions,
  });

  if (emergency.isEmergency) {
    return {
      isDone: true,
      severity: emergency.severity,
      hasRedFlag: true,
      needsDoctor: emergency.needsDoctor,
      needsFamilyAlert: emergency.needsFamilyAlert,
      followUpHours: emergency.followUpHours,
      forceEmergency: emergency,
      summary: `Phát hiện tình trạng nguy hiểm: ${emergency.type}.`,
      recommendation: 'Gọi cấp cứu 115 hoặc đến bệnh viện ngay lập tức.',
    };
  }

  // ── 4. Check turn count — force conclusion ──
  const turnCount = countUserTurns(history) + 1;
  // Follow-up: max 2 user turns. Check-in mới: max 8.
  const isFollowUp = !!previousSessionSummary;
  const maxTurns = isFollowUp ? 2 : MAX_TURNS;
  if (turnCount >= maxTurns) {
    const result = calculateSeverity(allUserMessages, profile);
    return { isDone: true, forceConclude: true, ...result };
  }

  // ── 5. Heuristic: detect AI concluded without tag ──
  const replyLower = reply.toLowerCase();
  const concludePatterns = [
    'hỏi lại.*sau', 'hỏi thăm.*sau', 'hỏi lại.*lúc', 'hỏi thăm.*lúc',
    'hoi lai.*sau', 'hoi tham.*sau', 'hoi lai.*luc', 'hoi tham.*luc',
    'chúc ngủ ngon', 'chuc ngu ngon', 'sáng mai', 'sang mai',
    'hẹn.*tối', 'hen.*toi', 'hỏi thăm.*tối', 'hỏi thăm.*sáng',
    'hỏi lại.*giờ', 'hỏi thăm.*giờ', 'hoi lai.*gio', 'hoi tham.*gio',
    'sẽ hỏi lại', 'se hoi lai', 'sẽ hỏi thăm', 'se hoi tham',
  ];
  const looksLikeDone = concludePatterns.some(p => new RegExp(p).test(replyLower));

  // Chỉ trigger nếu reply là kết luận thật:
  // - Có pattern hẹn/chúc trong REPLY HIỆN TẠI
  // - Reply đủ dài (>80 ký tự)
  // - Reply KHÔNG kết thúc bằng ?
  // - User message KHÔNG rỗng (greeting không phải kết luận)
  // - Ít nhất 2 lượt user trong PHIÊN HIỆN TẠI (không đếm history cũ)
  const endsWithQuestion = reply.trim().endsWith('?') || reply.trim().match(/\?\s*[\p{Emoji}]*$/u);
  const isGreeting = !currentUserMessage || !currentUserMessage.trim();
  if (looksLikeDone && !isGreeting && turnCount >= 2 && reply.length > 80 && !endsWithQuestion) {
    // AI kết luận nhưng quên tag
    // Dùng severity từ server nhưng summary từ AI reply (không parse keyword sai)
    const serverResult = calculateSeverity(allUserMessages, profile);

    // Trích summary từ reply AI — lấy câu đầu tiên hoặc tóm tắt ngắn
    const replySentences = reply.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 5);
    const aiSummary = replySentences.length > 0 ? replySentences[0] : reply.substring(0, 100);

    // Parse severity/doctor/followup từ tag nếu có, fallback server
    const severityMatch = reply.match(/\[SEVERITY:\s*(.+?)\]/i);
    const doctorMatch = reply.match(/\[NEEDS_DOCTOR:\s*(.+?)\]/i);
    const followUpMatch = reply.match(/\[FOLLOW_UP_HOURS:\s*(.+?)\]/i);
    const summaryMatch = reply.match(/\[SUMMARY:\s*(.+?)\]/i);

    // Severity: lấy CAO HƠN giữa AI và server (an toàn)
    // NGOẠI TRỪ khi user nói ổn → server nói low → dùng low
    const sevOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    const aiSev = severityMatch ? severityMatch[1].trim().toLowerCase() : null;
    const serverSev = serverResult.severity;
    let finalSev;
    if (serverSev === 'low' && serverResult.userSaidFine) {
      // User nói ổn → luôn low, bất kể AI nói gì
      finalSev = 'low';
    } else {
      finalSev = (aiSev && sevOrder[aiSev] !== undefined)
        ? (sevOrder[aiSev] >= sevOrder[serverSev] ? aiSev : serverSev)
        : serverSev;
    }

    // needsDoctor: true nếu bất kỳ bên nào nói true, TRỪ KHI user nói ổn
    const aiDoc = doctorMatch ? doctorMatch[1].trim().toLowerCase() === 'true' : false;
    const finalDoc = serverResult.userSaidFine ? false : (aiDoc || serverResult.needsDoctor);

    return {
      isDone: true,
      severity: finalSev,
      needsDoctor: finalDoc,
      needsFamilyAlert: serverResult.needsFamilyAlert || (finalSev === 'high' && (serverResult.isElderly || serverResult.hasConditions)),
      hasRedFlag: serverResult.hasRedFlag,
      followUpHours: followUpMatch ? parseInt(followUpMatch[1]) : serverResult.followUpHours,
      summary: summaryMatch ? summaryMatch[1].trim() : aiSummary,
      recommendation: serverResult.recommendation,
    };
  }

  // ── 6. Not done yet — continue conversation ──
  return { isDone: false };
}

// ─── Tag Stripping ─────────────────────────────────────────────────────────

/**
 * Strip internal control tags from the reply before returning to the user.
 * These tags are for server-side processing only.
 *
 * @param {string} reply
 * @returns {string}
 */
function stripTags(reply) {
  return reply
    .replace(/\[TRIAGE_DONE\]/g, '')
    .replace(/\[EMERGENCY\]/g, '')
    .replace(/\[SUMMARY:\s*[^\]]*\]/gi, '')
    .replace(/\[SEVERITY:\s*[^\]]*\]/gi, '')
    .replace(/\[NEEDS_DOCTOR:\s*[^\]]*\]/gi, '')
    .replace(/\[FOLLOW_UP_HOURS:\s*[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Process a triage chat message. This is the main entry point.
 *
 * Takes a user's free-text message, sends it to GPT along with conversation
 * history, then runs deterministic post-processing for emergency detection
 * and severity calculation.
 *
 * @param {Object} input
 * @param {string} input.message - User's text message
 * @param {Object} input.profile - { birth_year, gender, full_name, medical_conditions }
 * @param {Array}  input.history - Previous messages [{role: 'user'|'assistant', content: string}]
 * @param {Object} input.healthContext - { previousCheckins, recentGlucose, recentBP, medications, ... }
 * @param {string} input.previousSessionSummary - Summary from yesterday
 * @returns {Promise<{
 *   reply: string,
 *   isDone: boolean,
 *   severity?: string,
 *   summary?: string,
 *   recommendation?: string,
 *   needsDoctor?: boolean,
 *   needsFamilyAlert?: boolean,
 *   hasRedFlag?: boolean,
 *   followUpHours?: number,
 * }>}
 */
async function processTriageChat(input) {
  const {
    message,
    profile = {},
    history = [],
    healthContext = {},
    previousSessionSummary = null,
    isFollowUpSameDay = false,
  } = input;

  // Empty message = initial greeting trigger (first call)
  const isInitialGreeting = !message || !message.trim();
  const userMessage = isInitialGreeting ? 'Xin chào' : message.trim();

  // ── 1. Build system prompt ──
  const systemPrompt = buildSystemPrompt(profile, healthContext, previousSessionSummary, input.simulatedHour);

  // ── 2. Call GPT ──
  let gptResult;
  try {
    gptResult = await callGPT(systemPrompt, history, userMessage);
  } catch (err) {
    // Log the error but still run emergency detection on user's message
    // — safety net must work even when GPT is down.
    console.error('[TriageChat] GPT error:', err.message);

    // Run emergency detection even without GPT response
    const allUserMessages = extractUserMessages(history, message);
    const emergency = detectEmergency(allUserMessages, {
      birth_year: profile.birth_year,
      gender: profile.gender,
      medical_conditions: profile.medical_conditions,
    });

    if (emergency.isEmergency) {
      // Emergency detected — return hardcoded Vietnamese response
      return {
        reply: `⚠️ Phát hiện tình trạng nguy hiểm. GỌI CẤP CỨU 115 hoặc ĐẾN BỆNH VIỆN NGAY.`,
        isDone: true,
        severity: emergency.severity,
        hasRedFlag: true,
        needsDoctor: true,
        needsFamilyAlert: true,
        followUpHours: 0,
        summary: `Phát hiện tình trạng nguy hiểm: ${emergency.type}.`,
        recommendation: 'Gọi cấp cứu 115 hoặc đến bệnh viện ngay lập tức.',
      };
    }

    // No emergency — re-throw so the caller can handle the GPT failure
    throw err;
  }

  const rawReply = gptResult.reply;

  // ── 3. Analyze response (emergency detection + completion check) ──
  const analysis = analyzeResponse(rawReply, history, message, profile, previousSessionSummary);

  // ── 4. Strip control tags from reply ──
  let cleanReply = stripTags(rawReply);

  // ── 5. If emergency was force-detected by server (GPT missed it), override reply ──
  if (analysis.forceEmergency && !rawReply.includes('[EMERGENCY]')) {
    cleanReply += '\n\n⚠️ GỌI CẤP CỨU 115 hoặc ĐẾN BỆNH VIỆN NGAY.';
  }

  // ── 6. If force-concluded due to turn limit, reply stays as-is ──
  // GPT's last response is still a valid conversational reply.

  // ── 7. Run AI safety filter on the final reply ──
  const filtered = filterTriageResult({
    text: cleanReply,
    severity: analysis.severity,
    needsDoctor: analysis.needsDoctor,
  });
  if (filtered.text) cleanReply = filtered.text;

  // ── 8. Log the interaction ──
  console.log(`[TriageChat] isDone=${analysis.isDone} severity=${analysis.severity||'-'} redFlag=${analysis.hasRedFlag||false}`);

  // ── 9. Build final response ──
  const response = {
    reply: cleanReply,
    isDone: analysis.isDone,
  };

  // Only include triage result fields when done
  if (analysis.isDone) {
    response.severity = analysis.severity;
    response.summary = analysis.summary;
    response.recommendation = analysis.recommendation;
    response.needsDoctor = analysis.needsDoctor;
    response.needsFamilyAlert = analysis.needsFamilyAlert;
    response.hasRedFlag = analysis.hasRedFlag;
    response.followUpHours = analysis.followUpHours;
  }

  return response;
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  processTriageChat,

  // Exported for testing / downstream use
  buildSystemPrompt,
  analyzeResponse,
  calculateSeverity,
  detectProgression,
  resolveChiefComplaint,
  stripTags,
};
