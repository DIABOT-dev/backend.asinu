/**
 * Chat Service
 * Business logic cho AI chat
 * - Build onboarding context
 * - Format user messages
 * - Process AI replies
 */
const { t } = require('../../i18n');
const { filterChatResponse } = require('../ai/ai-safety.service');
const { logAiInteraction } = require('../ai/ai-logger.service');

// =====================================================
// CONSTANTS
// =====================================================

const FALLBACK_CONTEXT =
  t('chat.fallback_context');

// =====================================================
// HELPERS
// =====================================================

/**
 * Collect issue items into string array
 * @param {Array} items - Array of issue items (string or object)
 * @returns {Array<string>} - Cleaned string array
 */
const collectIssueItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      return (item.other_text || item.label || item.key || '').trim();
    })
    .filter(Boolean);
};

/**
 * Format issue items into comma-separated string
 * @param {Array} items - Array of issue items
 * @returns {string} - Formatted string
 */
const formatIssueList = (items) => collectIssueItems(items).join(', ');

// =====================================================
// CONTEXT BUILDING
// =====================================================

/**
 * Build onboarding context for AI from user profile
 * @param {Object|null} profile - User onboarding profile
 * @returns {string} - Context string
 */
const buildOnboardingContext = (profile) => {
  if (!profile) return FALLBACK_CONTEXT;
  
  const medical = formatIssueList(profile.medical_conditions);
  const symptoms = formatIssueList(profile.chronic_symptoms);
  const joints = formatIssueList(profile.joint_issues);
  
  const notes = [];
  notes.push(`${t('chat.gender')}: ${profile.gender}. ${t('chat.age_group')}: ${profile.age}.`);
  notes.push(`${t('chat.goal')}: ${profile.goal}. ${t('chat.body_type')}: ${profile.body_type}.`);
  
  if (medical) notes.push(`${t('chat.conditions')}: ${medical}.`);
  if (symptoms) notes.push(`${t('chat.symptoms')}: ${symptoms}.`);
  if (joints) notes.push(`${t('chat.joint_issues')}: ${joints}.`);
  
  notes.push(
    `${t('chat.habits')}: ${t('chat.flexibility')} ${profile.flexibility}, ${t('chat.stairs')} ${profile.stairs_performance}, ` +
    `${t('chat.exercise')} ${profile.exercise_freq}, ${t('chat.walking')} ${profile.walking_habit}, ` +
    `${t('chat.water')} ${profile.water_intake}, ${t('chat.sleep')} ${profile.sleep_duration}.`
  );
  
  notes.push(t('chat.reply_instruction'));
  
  return notes.join(' ');
};

/**
 * Build mention hint from profile for reply enhancement
 * @param {Object|null} profile - User onboarding profile
 * @returns {string} - Hint string or empty
 */
const buildMentionHint = (profile) => {
  if (!profile) return '';
  
  const symptoms = collectIssueItems(profile.chronic_symptoms);
  const joints = collectIssueItems(profile.joint_issues);
  const primarySymptom = symptoms[0] || joints[0] || '';
  
  if (profile.goal && primarySymptom) {
    return t('chat.goal_and_symptom', 'vi', { goal: profile.goal, symptom: primarySymptom });
  }
  if (profile.goal) {
    return t('chat.goal_only', 'vi', { goal: profile.goal });
  }
  if (primarySymptom) {
    return t('chat.symptom_only', 'vi', { symptom: primarySymptom });
  }
  return '';
};

/**
 * Check if reply mentions profile keywords
 * @param {string} reply - AI reply
 * @param {Object|null} profile - User profile
 * @returns {boolean} - Whether reply mentions profile
 */
const replyMentionsProfile = (reply, profile) => {
  if (!profile || !reply) return false;
  
  const keywords = [
    profile.goal,
    ...collectIssueItems(profile.chronic_symptoms),
    ...collectIssueItems(profile.joint_issues),
  ].filter(Boolean);
  
  const normalized = reply.toLowerCase();
  return keywords.some((item) => normalized.includes(String(item).toLowerCase()));
};

/**
 * Format message with system context for DiaBrain provider
 * @param {string} message - User message
 * @param {string} context - System context
 * @returns {string} - Formatted message
 */
const formatMessageWithContext = (message, context) => {
  return `### SYSTEM_CONTEXT\n${context}\n### USER\n${message}`;
};

/**
 * Enhance reply with profile mention if needed
 * @param {string} reply - AI reply
 * @param {Object|null} profile - User profile
 * @returns {string} - Enhanced reply
 */
const enhanceReplyWithProfile = (reply, profile) => {
  if (!profile) return reply;
  if (replyMentionsProfile(reply, profile)) return reply;
  
  const hint = buildMentionHint(profile);
  if (hint) {
    return `${reply} ${hint}`;
  }
  return reply;
};

// =====================================================
// SYSTEM PROMPT BUILDING
// =====================================================

const HISTORY_LIMIT_FREE = 50;     // AI context: 50 messages for free users (7 ngày)
const HISTORY_LIMIT_PREMIUM = 300; // AI context: 300 messages for premium (~128K token window)
const HISTORY_LIMIT = HISTORY_LIMIT_FREE; // default export (backward compat)
const RETENTION_DAYS_FREE = 7;
const RETENTION_DAYS_PREMIUM = 365;

/**
 * Kiểm tra một đoạn text có phải câu hỏi không.
 * Hỗ trợ cả câu có ? và câu hỏi tiếng Việt không có ?.
 */
const isQuestion = (text) => {
  if (!text) return false;
  if (/\?/.test(text)) return true;
  // Câu hỏi tiếng Việt hay bỏ dấu hỏi chấm
  return /(\bkhông\s*$|\bchưa\s*$|\bsao\s*$|như thế nào|bao (nhiêu|lâu|giờ|lần)|mấy (giờ|lần|ngày|tuần)|lúc nào|khi nào|bao giờ|tại sao|vì sao|làm sao|ở đâu)/i.test(text.trim());
};

/**
 * Kiểm tra xem tin nhắn cuối của AI có phải câu hỏi không.
 */
const lastAiTurnWasQuestion = (history = []) => {
  const lastAi = [...history].reverse().find(h => h.sender === 'assistant');
  if (!lastAi) return false;
  return isQuestion(lastAi.message);
};

/**
 * Đếm số lượt AI liên tiếp (tính theo assistant turns) đặt câu hỏi.
 * Bỏ qua user messages xen kẽ — kiểm tra các assistant turn gần nhất.
 */
const countConsecutiveAiQuestions = (history = []) => {
  const aiTurns = history.filter(h => h.sender === 'assistant').slice(-4);
  let count = 0;
  for (const turn of [...aiTurns].reverse()) {
    if (isQuestion(turn.message)) count++;
    else break;
  }
  return count;
};

/**
 * Build system prompt for AI from user profile and health logs.
 * @param {Object|null} profile - User onboarding profile
 * @param {number} historyLength - Number of prior messages in this conversation
 * @param {Object|null} logsSummary - Latest health metrics { latest_glucose, latest_bp }
 * @param {Array} history - Full conversation history (for loop detection)
 * @returns {string} - System prompt
 */
const buildSystemPrompt = (profile, historyLength = 0, logsSummary = null, history = [], lang = 'vi') => {
  const isEn = lang === 'en';
  const lines = [];

  // ── IDENTITY ─────────────────────────────────────────
  if (isEn) {
    lines.push('You are Asinu — a close, knowledgeable friend who truly listens and cares.');
    lines.push('Chat like a real friend: relaxed, warm, sometimes lightly humorous. Not stiff, not scripted, not "chatbot-like".');
    lines.push('Each message should sound like a person wrote it, not a machine. Short sentences, clear points, on topic.');
  } else {
    lines.push('Bạn là Asinu — người bạn thân thiết, hiểu biết, luôn lắng nghe và quan tâm thật sự.');
    lines.push('Hãy trò chuyện như một người bạn thực thụ: thoải mái, gần gũi, đôi khi hài hước nhẹ nhàng. Không cứng nhắc, không theo khuôn mẫu, không "chatbot".');
    lines.push('Mỗi tin nhắn nên nghe như do người viết ra, không phải máy móc. Câu ngắn, ý rõ, đúng trọng tâm.');
  }

  // ── USER PROFILE (background context) ────────────────
  if (profile) {
    const medical  = formatIssueList(profile.medical_conditions);
    const symptoms = formatIssueList(profile.chronic_symptoms);
    const joints   = formatIssueList(profile.joint_issues);

    // User goals: V2 stores as JSONB array, V1 stores as string
    const goalList = Array.isArray(profile.user_goal) && profile.user_goal.length
      ? profile.user_goal.join(', ')
      : (profile.goal || '');

    // Age: V2 uses birth_year, V1 uses age
    let ageDisplay = '';
    if (profile.birth_year) {
      const age = new Date().getFullYear() - parseInt(profile.birth_year);
      ageDisplay = isEn ? `${age} years old (born ${profile.birth_year})` : `${age} tuổi (sinh ${profile.birth_year})`;
    } else if (profile.age) {
      ageDisplay = isEn ? `age group ${profile.age}` : `nhóm tuổi ${profile.age}`;
    }

    const habits = [];
    if (profile.exercise_freq)  habits.push(isEn ? `exercise ${profile.exercise_freq}` : `tập ${profile.exercise_freq}`);
    if (profile.sleep_hours)    habits.push(isEn ? `sleep ${profile.sleep_hours}` : `ngủ ${profile.sleep_hours}`);
    else if (profile.sleep_duration) habits.push(isEn ? `sleep ${profile.sleep_duration}` : `ngủ ${profile.sleep_duration}`);
    if (profile.water_intake)   habits.push(isEn ? `water ${profile.water_intake}` : `nước ${profile.water_intake}`);
    if (profile.walking_habit)  habits.push(isEn ? `walking ${profile.walking_habit}` : `đi bộ ${profile.walking_habit}`);
    if (profile.meals_per_day)  habits.push(isEn ? `${profile.meals_per_day} meals/day` : `${profile.meals_per_day}/ngày`);
    if (profile.dinner_time)    habits.push(isEn ? `dinner ${profile.dinner_time}` : `ăn tối ${profile.dinner_time}`);
    if (profile.sweet_intake)   habits.push(isEn ? `sweets ${profile.sweet_intake}` : `đồ ngọt ${profile.sweet_intake}`);
    if (profile.post_meal_drowsy && profile.post_meal_drowsy !== 'Không') {
      habits.push(isEn ? `post-meal drowsiness: ${profile.post_meal_drowsy}` : `buồn ngủ sau ăn: ${profile.post_meal_drowsy}`);
    }

    const profileParts = [];
    if (profile.gender)          profileParts.push(isEn ? `gender ${profile.gender}` : `giới tính ${profile.gender}`);
    if (ageDisplay)              profileParts.push(ageDisplay);
    if (goalList)                profileParts.push(isEn ? `goal: ${goalList}` : `mục tiêu: ${goalList}`);
    if (profile.body_type)       profileParts.push(isEn ? `body type: ${profile.body_type}` : `thể trạng: ${profile.body_type}`);
    if (profile.height_cm)       profileParts.push(isEn ? `height ${profile.height_cm}cm` : `cao ${profile.height_cm}cm`);
    if (profile.weight_kg)       profileParts.push(isEn ? `weight ${profile.weight_kg}kg` : `nặng ${profile.weight_kg}kg`);
    if (profile.blood_type)      profileParts.push(isEn ? `blood type ${profile.blood_type}` : `nhóm máu ${profile.blood_type}`);
    if (medical)                 profileParts.push(isEn ? `conditions: ${medical}` : `bệnh lý: ${medical}`);
    if (symptoms)                profileParts.push(isEn ? `symptoms: ${symptoms}` : `triệu chứng: ${symptoms}`);
    if (joints)                  profileParts.push(isEn ? `joint issues: ${joints}` : `vấn đề khớp: ${joints}`);
    if (profile.daily_medication && profile.daily_medication !== 'Không') {
      profileParts.push(isEn ? `daily medication: ${profile.daily_medication}` : `dùng thuốc hàng ngày: ${profile.daily_medication}`);
    }
    if (habits.length)           profileParts.push(isEn ? `habits: ${habits.join(', ')}` : `thói quen: ${habits.join(', ')}`);
    if (profile.user_group) {
      const groupLabel = isEn
        ? (profile.user_group === 'monitoring' ? 'needs close monitoring' : profile.user_group === 'metabolic_risk' ? 'metabolic risk' : 'good health')
        : (profile.user_group === 'monitoring' ? 'cần theo dõi sát' : profile.user_group === 'metabolic_risk' ? 'nguy cơ chuyển hóa' : 'sức khoẻ tốt');
      profileParts.push(isEn ? `health group: ${groupLabel}` : `nhóm sức khoẻ: ${groupLabel}`);
    }

    if (profileParts.length) {
      lines.push(isEn
        ? `User info (already known — use as background, do NOT ask about any of this): ${profileParts.join('; ')}.`
        : `Thông tin người dùng (đã biết sẵn — dùng làm nền tảng, KHÔNG hỏi lại bất kỳ điều nào đã có ở đây): ${profileParts.join('; ')}.`);
    }
    const mentionHint = buildMentionHint(profile);
    if (mentionHint) {
      lines.push(isEn
        ? `Personalization hint: ${mentionHint} — mention when relevant, not every time.`
        : `Gợi ý cá nhân hóa: ${mentionHint} — đề cập khi phù hợp, không cần nhắc mọi lúc.`);
    }
  }

  // ── HEALTH METRICS ────────────────────────────────────
  if (logsSummary) {
    const metrics = [];
    if (logsSummary.latest_glucose) {
      const g = logsSummary.latest_glucose;
      const trend = logsSummary.glucose_trend ? (isEn ? ` (trend: ${logsSummary.glucose_trend})` : ` (xu hướng: ${logsSummary.glucose_trend})`) : '';
      metrics.push(isEn ? `latest glucose ${g.value} ${g.unit || 'mg/dL'}${trend}` : `đường huyết gần nhất ${g.value} ${g.unit || 'mg/dL'}${trend}`);
    }
    if (logsSummary.latest_bp) {
      const bp = logsSummary.latest_bp;
      const pulse = bp.pulse ? (isEn ? `, heart rate ${bp.pulse} bpm` : `, nhịp tim ${bp.pulse} bpm`) : '';
      metrics.push(isEn ? `latest BP ${bp.systolic}/${bp.diastolic} mmHg${pulse}` : `huyết áp gần nhất ${bp.systolic}/${bp.diastolic} mmHg${pulse}`);
    }
    if (logsSummary.latest_weight) {
      const w = logsSummary.latest_weight;
      const bf = w.bodyfat_pct ? (isEn ? `, body fat ${w.bodyfat_pct}%` : `, mỡ ${w.bodyfat_pct}%`) : '';
      metrics.push(isEn ? `latest weight ${w.weight_kg} kg${bf}` : `cân nặng gần nhất ${w.weight_kg} kg${bf}`);
    }
    if (logsSummary.water_today_ml) {
      metrics.push(isEn ? `water today ${logsSummary.water_today_ml} ml` : `nước uống hôm nay ${logsSummary.water_today_ml} ml`);
    }
    if (logsSummary.recent_medications?.length) {
      const meds = logsSummary.recent_medications.map(m => `${m.medication}${m.dose ? ' ' + m.dose : ''}`).join(', ');
      metrics.push(isEn ? `current medications: ${meds}` : `thuốc đang dùng: ${meds}`);
    }
    if (metrics.length) {
      lines.push(isEn
        ? `Recorded health metrics (use as reference, do NOT ask about these): ${metrics.join('; ')}.`
        : `Chỉ số sức khoẻ đã ghi nhận (dùng làm căn cứ trả lời, KHÔNG hỏi lại các thông số đã có): ${metrics.join('; ')}.`);
    }
    // Cross-reference conditions + metrics
    if (profile) {
      const medical = formatIssueList(profile.medical_conditions).toLowerCase();
      const crossRefs = [];
      if ((medical.includes('tiểu đường') || medical.includes('đái tháo đường') || medical.includes('diabetes')) && logsSummary.latest_glucose) {
        const g = logsSummary.latest_glucose;
        if (g.value > 180) crossRefs.push(isEn ? `glucose ${g.value} mg/dL exceeds post-meal target for diabetics (<180)` : `đường huyết ${g.value} mg/dL vượt ngưỡng sau ăn cho người tiểu đường (<180)`);
        else if (g.value < 70) crossRefs.push(isEn ? `glucose ${g.value} mg/dL low, hypoglycemia risk` : `đường huyết ${g.value} mg/dL thấp, nguy cơ hạ đường huyết`);
        else crossRefs.push(isEn ? `glucose ${g.value} mg/dL within acceptable range for diabetics` : `đường huyết ${g.value} mg/dL trong phạm vi chấp nhận cho người tiểu đường`);
      }
      if ((medical.includes('huyết áp cao') || medical.includes('tăng huyết áp') || medical.includes('hypertension')) && logsSummary.latest_bp) {
        const bp = logsSummary.latest_bp;
        if (bp.systolic >= 140 || bp.diastolic >= 90) crossRefs.push(isEn ? `BP ${bp.systolic}/${bp.diastolic} exceeds target for hypertension (<140/90)` : `huyết áp ${bp.systolic}/${bp.diastolic} vượt ngưỡng cho người THA (<140/90)`);
        else crossRefs.push(isEn ? `BP ${bp.systolic}/${bp.diastolic} well controlled` : `huyết áp ${bp.systolic}/${bp.diastolic} đang kiểm soát tốt`);
      }
      if (crossRefs.length) {
        lines.push(isEn ? `Cross-reference notes (use when relevant): ${crossRefs.join('; ')}.` : `Nhận xét kết hợp (dùng khi liên quan): ${crossRefs.join('; ')}.`);
      }
    }
  }

  if (profile || logsSummary) lines.push('');

  // ── CONVERSATION STYLE ──────────────────────────────────
  if (historyLength === 0) {
    lines.push(isEn ? 'First message: greet briefly then get straight to the point.' : 'Tin nhắn đầu tiên: chào thật ngắn rồi vào thẳng vấn đề.');
  }

  if (isEn) {
    lines.push('How you talk: like texting a close friend — short, direct, no filler. Never open with "OK", "Sure", "Great question", "I understand", "Let me explain" or any cliché opener — jump straight to the content. No numbered lists, no bullet points, no indentation. No **, *, ##. Always reply in the same language the user uses.');
    lines.push('About health: you are knowledgeable and speak frankly. Common OTC meds like paracetamol, ibuprofen — mention normally with dosage notes if needed. For prescription meds, naturally suggest seeing a doctor/pharmacist — not because you are "limited" but because it is the right thing. When someone asks what disease they have, say directly that only a doctor can diagnose accurately, then suggest they get checked. You do not always need to mention a doctor, only when truly necessary.');
    lines.push('Important: never say "I am limited", "I am not allowed", "beyond my capability" or anything that sounds like reading rules. If there is something you prefer not to say directly, redirect naturally like a normal person would.');
  } else {
    lines.push(`Cách bạn nói chuyện: như nhắn tin với bạn thân — câu ngắn, đúng việc, không rào đón. Không bao giờ mở đầu bằng "Ok", "Được", "Chào bạn", "Tuyệt vời", "Mình hiểu", "Mình nói thẳng luôn", "Để mình giải thích" hay bất kỳ câu dẫn sáo rỗng nào — vào thẳng nội dung luôn. Không liệt kê 1-2-3, không dùng dấu gạch ngang đầu dòng, không indent. Không dùng **, *, ##. Trả lời đúng ngôn ngữ người dùng dùng.`);
    lines.push(`Về sức khoẻ: bạn biết nhiều và chia sẻ thẳng thắn. Thuốc không kê đơn phổ biến như paracetamol, ibuprofen thì nói bình thường, kèm lưu ý liều dùng nếu cần. Thuốc kê đơn thì hướng sang bác sĩ/dược sĩ một cách tự nhiên, không phải vì "bị giới hạn" mà vì đó là việc đúng đắn. Khi ai đó hỏi mình bị bệnh gì, hãy nói thẳng là việc đó cần bác sĩ khám trực tiếp mới chính xác được, rồi gợi ý họ đi khám — đừng đoán bệnh. Không phải lúc nào cũng cần nhắc bác sĩ, chỉ khi thực sự cần thiết.`);
    lines.push(`Quan trọng: đừng bao giờ nói "mình bị giới hạn", "mình không được phép", "ngoài khả năng" hay bất cứ kiểu nào nghe như mình đang đọc luật. Nếu có gì không muốn nói thẳng, hãy chuyển hướng một cách thật tự nhiên như người bình thường.`);
  }

  // ── STOP RULE ───────────────
  lines.push(isEn
    ? 'Follow-up questions: only ask when truly missing critical info. Max 1 question per turn, and always give a concrete comment/advice first. If you already know enough from profile or chat history, just answer.'
    : `Hỏi lại: chỉ hỏi khi thực sự thiếu thông tin và không có cách nào trả lời nếu thiếu nó. Mỗi lượt tối đa 1 câu hỏi, và phải đưa ra nhận xét/lời khuyên cụ thể trước. Nếu đã biết đủ từ hồ sơ hoặc lịch sử chat thì đừng hỏi lại, trả lời luôn.`);

  const consecutiveQuestions = countConsecutiveAiQuestions(history);
  const prevWasQuestion = lastAiTurnWasQuestion(history);

  if (consecutiveQuestions >= 2) {
    lines.push('');
    lines.push(isEn
      ? `LOOP WARNING: Already asked ${consecutiveQuestions} consecutive turns. MUST give a concrete answer NOW, do NOT ask more.`
      : `CANH BAO VONG LAP: Da hoi lien tiep ${consecutiveQuestions} luot. PHAI tra loi cu the ngay, KHONG hoi them.`);
  } else if (prevWasQuestion) {
    lines.push('');
    lines.push(isEn
      ? 'You asked a question last turn. This turn you MUST provide a concrete answer or advice first based on what the user just shared. Only ask 1 more question at the end if truly necessary.'
      : 'Lượt trước bạn đã hỏi người dùng. Lần này PHẢI đưa ra câu trả lời hoặc lời khuyên cụ thể trước dựa trên thông tin người dùng vừa chia sẻ. Chỉ hỏi thêm tối đa 1 câu ở cuối nếu thực sự cần thiết.');
  }

  return lines.join('\n');
};

// =====================================================
// DATABASE OPERATIONS
// =====================================================

/**
 * Get recent conversation history for context window
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {number} limit - Max messages to retrieve
 * @param {number} retentionDays - How many days back to fetch (based on subscription)
 * @returns {Promise<Array<{message: string, sender: string}>>}
 */
async function getRecentHistory(pool, userId, limit = HISTORY_LIMIT, retentionDays = RETENTION_DAYS_FREE) {
  const result = await pool.query(
    `SELECT message, sender FROM chat_histories
     WHERE user_id = $1
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, retentionDays, limit]
  );
  return result.rows.reverse(); // chronological order
}

/**
 * Get chat history for display in the app (with created_at)
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {number} limit - Max messages
 * @param {number} retentionDays - How many days back
 * @returns {Promise<Array>}
 */
async function getChatHistory(pool, userId, limit = 100, retentionDays = RETENTION_DAYS_FREE) {
  const result = await pool.query(
    `SELECT id, message, sender, created_at FROM chat_histories
     WHERE user_id = $1
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY created_at ASC, CASE sender WHEN 'user' THEN 0 ELSE 1 END ASC
     LIMIT $3`,
    [userId, retentionDays, limit]
  );
  return result.rows;
}

/**
 * Get latest health log metrics for AI context (glucose, blood pressure)
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<{latest_glucose: Object|null, latest_bp: Object|null}>}
 */
async function getHealthLogsSummary(pool, userId) {
  try {
    const [glucoseResult, bpResult, weightResult, waterResult, medResult] = await Promise.all([
      pool.query(
        `SELECT d.value, d.unit, c.occurred_at
         FROM logs_common c
         JOIN glucose_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'glucose'
           AND c.occurred_at >= NOW() - INTERVAL '7 days'
         ORDER BY c.occurred_at DESC LIMIT 3`,
        [userId]
      ),
      pool.query(
        `SELECT d.systolic, d.diastolic, d.pulse, c.occurred_at
         FROM logs_common c
         JOIN blood_pressure_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'bp'
           AND c.occurred_at >= NOW() - INTERVAL '7 days'
         ORDER BY c.occurred_at DESC LIMIT 3`,
        [userId]
      ),
      pool.query(
        `SELECT d.weight_kg, d.body_fat_percent, c.occurred_at
         FROM logs_common c
         JOIN weight_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'weight'
           AND c.occurred_at >= NOW() - INTERVAL '30 days'
         ORDER BY c.occurred_at DESC LIMIT 1`,
        [userId]
      ),
      pool.query(
        `SELECT SUM(d.volume_ml) as total_ml, c.occurred_at::date as log_date
         FROM logs_common c
         JOIN water_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'water'
           AND c.occurred_at >= NOW() - INTERVAL '1 days'
         GROUP BY c.occurred_at::date
         ORDER BY log_date DESC LIMIT 1`,
        [userId]
      ),
      pool.query(
        `SELECT d.med_name, d.dose_text, d.frequency_text, c.occurred_at
         FROM logs_common c
         JOIN medication_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'medication'
           AND c.occurred_at >= NOW() - INTERVAL '3 days'
         ORDER BY c.occurred_at DESC LIMIT 3`,
        [userId]
      ),
    ]);

    // Glucose trend từ 3 readings gần nhất
    const glucoseRows = glucoseResult.rows;
    let glucoseTrend = null;
    if (glucoseRows.length >= 2) {
      const diff = glucoseRows[0].value - glucoseRows[glucoseRows.length - 1].value;
      glucoseTrend = diff > 10 ? 'tăng' : diff < -10 ? 'giảm' : 'ổn định';
    }

    return {
      latest_glucose: glucoseRows[0] || null,
      glucose_trend: glucoseTrend,
      latest_bp: bpResult.rows[0] || null,
      latest_weight: weightResult.rows[0] || null,
      water_today_ml: waterResult.rows[0]?.total_ml || null,
      recent_medications: medResult.rows,
    };
  } catch (err) {
    return { latest_glucose: null, latest_bp: null, latest_weight: null, water_today_ml: null, recent_medications: [] };
  }
}

/**
 * Get user's onboarding profile
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - Profile or null
 */
async function getOnboardingProfile(pool, userId) {
  const result = await pool.query(
    'SELECT * FROM user_onboarding_profiles WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Save user message to chat history
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} message - Message content
 * @param {Date} timestamp - Message timestamp
 * @returns {Promise<void>}
 */
async function saveUserMessage(pool, userId, message, timestamp) {
  await pool.query(
    `INSERT INTO chat_histories (user_id, message, sender, created_at)
     VALUES ($1, $2, 'user', $3)`,
    [userId, message, timestamp]
  );
}

/**
 * Save assistant reply to chat history
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} reply - Reply content
 * @param {Date} timestamp - Reply timestamp
 * @returns {Promise<Object>} - { id, created_at }
 */
async function saveAssistantReply(pool, userId, reply, timestamp) {
  const result = await pool.query(
    `INSERT INTO chat_histories (user_id, message, sender, created_at)
     VALUES ($1, $2, 'assistant', $3)
     RETURNING id, created_at`,
    [userId, reply, timestamp]
  );
  return result.rows[0];
}

/**
 * Process chat message and get AI reply
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} message - User message
 * @param {Object} context - Additional context
 * @returns {Promise<Object>} - { ok, reply, chat_id, provider, created_at, error }
 */
async function processChat(pool, userId, message, context = {}) {
  const { getChatReply } = require('./chat.provider.service');
  const { isPremium: checkIsPremium } = require('../payment/subscription.service');

  console.log(`[Chat] user=${userId} msg="${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`);

  try {
    const now = new Date();
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    let finalMessage = message;
    let onboardingProfile = null;
    let conversationHistory = [];
    let systemPrompt = null;
    let logsSummary = null;

    // Determine user language + retention window
    const { rows: [userRow] } = await pool.query(
      'SELECT COALESCE(language_preference, $2) AS lang FROM users WHERE id = $1',
      [userId, 'vi']
    );
    const userLang = userRow?.lang || context.lang || 'vi';
    const userIsPremium = await checkIsPremium(pool, userId);
    const retentionDays = userIsPremium ? RETENTION_DAYS_PREMIUM : RETENTION_DAYS_FREE;
    console.log(`[Chat] user=${userId} provider=${provider || 'default'} premium=${userIsPremium} lang=${userLang}`);

    if (provider === 'diabrain') {
      // DiaBrain manages its own conversation state — keep existing behavior
      await saveUserMessage(pool, userId, message, now);
      try {
        [onboardingProfile, logsSummary] = await Promise.all([
          getOnboardingProfile(pool, userId),
          getHealthLogsSummary(pool, userId),
        ]);
        let contextText = buildOnboardingContext(onboardingProfile);
        if (logsSummary?.latest_glucose) {
          const g = logsSummary.latest_glucose;
          contextText += ` Đường huyết gần nhất: ${g.value} ${g.unit || 'mg/dL'}.`;
        }
        if (logsSummary?.latest_bp) {
          const bp = logsSummary.latest_bp;
          contextText += ` Huyết áp gần nhất: ${bp.systolic}/${bp.diastolic} mmHg.`;
        }
        finalMessage = formatMessageWithContext(message, contextText);
      } catch (err) {

        finalMessage = formatMessageWithContext(message, FALLBACK_CONTEXT);
      }
    } else {
      // Gemini/other: fetch history + profile + health logs BEFORE saving current message
      try {
        const historyLimit = userIsPremium ? HISTORY_LIMIT_PREMIUM : HISTORY_LIMIT_FREE;
        [onboardingProfile, conversationHistory, logsSummary] = await Promise.all([
          getOnboardingProfile(pool, userId),
          getRecentHistory(pool, userId, historyLimit, retentionDays),
          getHealthLogsSummary(pool, userId),
        ]);
        systemPrompt = buildSystemPrompt(onboardingProfile, conversationHistory.length, logsSummary, conversationHistory, userLang);
      } catch (err) {

      }
      await saveUserMessage(pool, userId, message, now);
    }

    // Get AI reply — pass conversation history and system prompt for Gemini
    const providerContext = { ...context, user_id: userId };
    const chatStartTime = Date.now();
    const replyResult = await getChatReply(finalMessage, providerContext, conversationHistory, systemPrompt);
    const chatDuration = Date.now() - chatStartTime;
    const rawReply = replyResult.reply || '';
    // Strip markdown formatting (**, *, ##, _) so chat UI shows plain text
    let reply = rawReply
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-–—]\s+/gm, '')       // xóa dấu gạch đầu dòng
      .replace(/^[ \t]+/gm, '')          // xóa indent đầu dòng
      .replace(/__(.+?)__/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/\n{3,}/g, '\n\n')        // giảm khoảng trắng thừa
      .trim();

    // Apply AI safety filter
    const safetyFiltered = reply !== filterChatResponse(reply);
    reply = filterChatResponse(reply);

    const replyProvider = replyResult.provider || 'mock';

    console.log(`[Chat] user=${userId} provider=${replyProvider} reply="${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}"`);

    // Log AI interaction
    logAiInteraction(pool, {
      userId,
      type: 'chat',
      model: replyProvider,
      promptSummary: message.slice(0, 500),
      responseSummary: reply,
      tokensUsed: 0,
      durationMs: chatDuration,
      isFallback: replyProvider === 'mock',
      safetyFiltered,
    }).catch(() => {}); // fire-and-forget

    // Save assistant reply
    const assistantRow = await saveAssistantReply(pool, userId, reply, now);

    return {
      ok: true,
      reply,
      chat_id: assistantRow?.id,
      provider: replyProvider,
      created_at: assistantRow?.created_at
        ? new Date(assistantRow.created_at).toISOString()
        : now.toISOString()
    };
  } catch (err) {
    console.error(`[Chat] user=${userId} error:`, err.message);
    return { ok: false, error: t('error.server') };
  }
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Constants
  FALLBACK_CONTEXT,
  HISTORY_LIMIT,
  HISTORY_LIMIT_FREE,
  HISTORY_LIMIT_PREMIUM,
  RETENTION_DAYS_FREE,
  RETENTION_DAYS_PREMIUM,

  // Helpers
  collectIssueItems,
  formatIssueList,

  // Context building
  buildOnboardingContext,
  buildSystemPrompt,
  buildMentionHint,
  replyMentionsProfile,
  formatMessageWithContext,
  enhanceReplyWithProfile,
  lastAiTurnWasQuestion,
  countConsecutiveAiQuestions,

  // Database operations
  getOnboardingProfile,
  getHealthLogsSummary,
  getRecentHistory,
  getChatHistory,
  saveUserMessage,
  saveAssistantReply,

  // Main
  processChat,
};
