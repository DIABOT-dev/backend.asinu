/**
 * Chat Service
 * Business logic cho AI chat
 * - Build onboarding context
 * - Format user messages
 * - Process AI replies
 */
const { t } = require('../i18n');

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

const HISTORY_LIMIT = 20; // Last 20 messages for better repeat-detection
const RETENTION_DAYS_FREE = 7;
const RETENTION_DAYS_PREMIUM = 30;

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
const buildSystemPrompt = (profile, historyLength = 0, logsSummary = null, history = []) => {
  const lines = [];

  // ── IDENTITY ─────────────────────────────────────────
  lines.push('Bạn là Asinu — trợ lý cá nhân thân thiện, thông minh.');
  lines.push('Bạn trò chuyện tự nhiên, linh hoạt như một người bạn thực sự quan tâm, không phải chatbot y tế cứng nhắc.');
  lines.push('');

  // ── USER PROFILE (background context) ────────────────
  if (profile) {
    const medical  = formatIssueList(profile.medical_conditions);
    const symptoms = formatIssueList(profile.chronic_symptoms);
    const joints   = formatIssueList(profile.joint_issues);
    const habits   = [];
    if (profile.exercise_freq)  habits.push(`tập ${profile.exercise_freq}`);
    if (profile.sleep_duration) habits.push(`ngủ ${profile.sleep_duration}`);
    if (profile.water_intake)   habits.push(`nước ${profile.water_intake}`);
    if (profile.walking_habit)  habits.push(`đi bộ ${profile.walking_habit}`);

    const profileParts = [];
    if (profile.gender)     profileParts.push(`giới tính ${profile.gender}`);
    if (profile.age)        profileParts.push(`nhóm tuổi ${profile.age}`);
    if (profile.goal)       profileParts.push(`mục tiêu: ${profile.goal}`);
    if (profile.body_type)  profileParts.push(`thể trạng: ${profile.body_type}`);
    if (profile.height_cm)  profileParts.push(`cao ${profile.height_cm}cm`);
    if (profile.weight_kg)  profileParts.push(`nặng ${profile.weight_kg}kg`);
    if (profile.blood_type) profileParts.push(`nhóm máu ${profile.blood_type}`);
    if (medical)            profileParts.push(`bệnh lý: ${medical}`);
    if (symptoms)           profileParts.push(`triệu chứng: ${symptoms}`);
    if (joints)             profileParts.push(`vấn đề khớp: ${joints}`);
    if (habits.length)      profileParts.push(`thói quen: ${habits.join(', ')}`);

    if (profileParts.length) {
      lines.push(`Thông tin người dùng (đã biết sẵn — dùng làm nền tảng, KHÔNG hỏi lại bất kỳ điều nào đã có ở đây): ${profileParts.join('; ')}.`);
    }
    const mentionHint = buildMentionHint(profile);
    if (mentionHint) {
      lines.push(`Gợi ý cá nhân hóa: ${mentionHint} — đề cập khi phù hợp, không cần nhắc mọi lúc.`);
    }
  }

  // ── HEALTH METRICS ────────────────────────────────────
  if (logsSummary) {
    const metrics = [];
    if (logsSummary.latest_glucose) {
      const g = logsSummary.latest_glucose;
      const trend = logsSummary.glucose_trend ? ` (xu hướng: ${logsSummary.glucose_trend})` : '';
      metrics.push(`đường huyết gần nhất ${g.value} ${g.unit || 'mg/dL'}${trend}`);
    }
    if (logsSummary.latest_bp) {
      const bp = logsSummary.latest_bp;
      const pulse = bp.pulse ? `, nhịp tim ${bp.pulse} bpm` : '';
      metrics.push(`huyết áp gần nhất ${bp.systolic}/${bp.diastolic} mmHg${pulse}`);
    }
    if (logsSummary.latest_weight) {
      const w = logsSummary.latest_weight;
      const bf = w.bodyfat_pct ? `, mỡ ${w.bodyfat_pct}%` : '';
      metrics.push(`cân nặng gần nhất ${w.weight_kg} kg${bf}`);
    }
    if (logsSummary.water_today_ml) {
      metrics.push(`nước uống hôm nay ${logsSummary.water_today_ml} ml`);
    }
    if (logsSummary.recent_medications?.length) {
      const meds = logsSummary.recent_medications.map(m => `${m.medication}${m.dose ? ' ' + m.dose : ''}`).join(', ');
      metrics.push(`thuốc đang dùng: ${meds}`);
    }
    if (metrics.length) {
      lines.push(`Chỉ số sức khoẻ đã ghi nhận (dùng làm căn cứ trả lời, KHÔNG hỏi lại các thông số đã có): ${metrics.join('; ')}.`);
    }
    // Cross-reference bệnh lý + chỉ số để AI có nhận xét cụ thể hơn
    if (profile) {
      const medical = formatIssueList(profile.medical_conditions).toLowerCase();
      const crossRefs = [];
      if ((medical.includes('tiểu đường') || medical.includes('đái tháo đường')) && logsSummary.latest_glucose) {
        const g = logsSummary.latest_glucose;
        if (g.value > 180) crossRefs.push(`đường huyết ${g.value} mg/dL vượt ngưỡng sau ăn cho người tiểu đường (<180)`);
        else if (g.value < 70) crossRefs.push(`đường huyết ${g.value} mg/dL thấp, nguy cơ hạ đường huyết`);
        else crossRefs.push(`đường huyết ${g.value} mg/dL trong phạm vi chấp nhận cho người tiểu đường`);
      }
      if ((medical.includes('huyết áp cao') || medical.includes('tăng huyết áp')) && logsSummary.latest_bp) {
        const bp = logsSummary.latest_bp;
        if (bp.systolic >= 140 || bp.diastolic >= 90) crossRefs.push(`huyết áp ${bp.systolic}/${bp.diastolic} vượt ngưỡng cho người THA (<140/90)`);
        else crossRefs.push(`huyết áp ${bp.systolic}/${bp.diastolic} đang kiểm soát tốt`);
      }
      if (crossRefs.length) {
        lines.push(`Nhận xét kết hợp (dùng khi liên quan): ${crossRefs.join('; ')}.`);
      }
    }
  }

  if (profile || logsSummary) lines.push('');

  // ── CONVERSATION RULES ────────────────────────────────
  lines.push('Quy tắc bắt buộc:');

  // First turn greeting
  if (historyLength === 0) {
    lines.push('- Lần đầu: chào ngắn 1 câu rồi đi thẳng vào nội dung, không giải thích dài.');
  } else {
    lines.push('- Đang trò chuyện: không chào lại, đi thẳng vào nội dung.');
  }

  lines.push('- Trả lời đúng điều người dùng đang nói/hỏi, bất kể chủ đề gì. Không kéo về sức khoẻ nếu người dùng không đề cập.');
  lines.push('- Ngắn gọn, tự nhiên — không dài dòng, không mở đầu sáo rỗng ("Chào bạn!", "Tuyệt vời!", v.v.).');
  lines.push('- Không phải bác sĩ — chỉ gợi ý gặp bác sĩ khi triệu chứng thực sự nghiêm trọng (đau ngực, khó thở, mất ý thức...). Không nhắc bác sĩ cho câu hỏi thông thường.');
  lines.push('- Luôn trả lời bằng đúng ngôn ngữ người dùng dùng (Việt → Việt, Anh → Anh).');
  lines.push('');

  // ── STOP RULE (chống vòng lặp câu hỏi) ───────────────
  lines.push('ĐIỂM DỪNG HỎI — bắt buộc tuân thủ:');
  lines.push('- Mỗi lượt TỐI ĐA 1 câu hỏi. PHẢI đưa ra câu trả lời/lời khuyên cụ thể TRƯỚC, rồi mới hỏi thêm nếu thực sự cần.');
  lines.push('- CHỈ hỏi khi thiếu thông tin mà KHÔNG CÓ CÁCH NÀO trả lời nếu thiếu nó. Nếu hồ sơ hoặc lịch sử hội thoại đã đủ → KHÔNG hỏi, trả lời luôn.');
  lines.push('- Kiểm tra lịch sử hội thoại: nếu đã hỏi câu tương tự hoặc người dùng đã đề cập → KHÔNG hỏi lại, dùng thông tin đã có.');
  lines.push('- Khi cần hỏi: ưu tiên hỏi về thông số LIÊN QUAN trực tiếp đến vấn đề người dùng đang đề cập (VD: hỏi về thời điểm đo nếu người dùng chia sẻ đường huyết, hỏi về triệu chứng cụ thể nếu họ than đau). KHÔNG hỏi chung chung kiểu "Bạn cảm thấy thế nào?".');
  lines.push('- Nếu người dùng đã có dữ liệu (profile + chỉ số ghi nhận ở trên): dùng dữ liệu đó để đưa ra nhận xét/lời khuyên cụ thể thay vì hỏi lại.');

  // Dynamic stop injection based on conversation state
  const consecutiveQuestions = countConsecutiveAiQuestions(history);
  const prevWasQuestion = lastAiTurnWasQuestion(history);

  if (consecutiveQuestions >= 2) {
    lines.push('');
    lines.push(`CANH BAO VONG LAP: Da hoi lien tiep ${consecutiveQuestions} luot. PHAI tra loi cu the ngay, KHONG hoi them.`);
  } else if (prevWasQuestion) {
    lines.push('');
    lines.push('Lượt trước bạn đã hỏi người dùng. Lần này PHẢI đưa ra câu trả lời hoặc lời khuyên cụ thể trước dựa trên thông tin người dùng vừa chia sẻ. Chỉ hỏi thêm tối đa 1 câu ở cuối nếu thực sự cần thiết.');
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
  const { isPremium: checkIsPremium } = require('./subscription.service');

  console.log(`[Chat] user=${userId} msg="${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`);

  try {
    const now = new Date();
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    let finalMessage = message;
    let onboardingProfile = null;
    let conversationHistory = [];
    let systemPrompt = null;
    let logsSummary = null;

    // Determine retention window based on subscription
    const userIsPremium = await checkIsPremium(pool, userId);
    const retentionDays = userIsPremium ? RETENTION_DAYS_PREMIUM : RETENTION_DAYS_FREE;
    console.log(`[Chat] user=${userId} provider=${provider || 'default'} premium=${userIsPremium}`);

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
        [onboardingProfile, conversationHistory, logsSummary] = await Promise.all([
          getOnboardingProfile(pool, userId),
          getRecentHistory(pool, userId, HISTORY_LIMIT, retentionDays),
          getHealthLogsSummary(pool, userId),
        ]);
        systemPrompt = buildSystemPrompt(onboardingProfile, conversationHistory.length, logsSummary, conversationHistory);
      } catch (err) {

      }
      await saveUserMessage(pool, userId, message, now);
    }

    // Get AI reply — pass conversation history and system prompt for Gemini
    const providerContext = { ...context, user_id: userId };
    const replyResult = await getChatReply(finalMessage, providerContext, conversationHistory, systemPrompt);
    const reply = replyResult.reply || '';
    const replyProvider = replyResult.provider || 'mock';

    console.log(`[Chat] user=${userId} provider=${replyProvider} reply="${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}"`);

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
  saveUserMessage,
  saveAssistantReply,

  // Main
  processChat,
};
