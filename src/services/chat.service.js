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
 * Kiểm tra xem tin nhắn cuối của AI có phải câu hỏi không.
 * Chỉ dùng dấu ? để tránh false positive với câu tiếng Việt.
 */
const lastAiTurnWasQuestion = (history = []) => {
  const lastAi = [...history].reverse().find(h => h.sender === 'assistant');
  if (!lastAi) return false;
  // Chỉ nhận là câu hỏi khi có dấu ? trong nội dung
  return /\?/.test(lastAi.message);
};

/**
 * Đếm số lượt AI liên tiếp (tính theo assistant turns) đặt câu hỏi.
 * Bỏ qua user messages xen kẽ — kiểm tra các assistant turn gần nhất.
 */
const countConsecutiveAiQuestions = (history = []) => {
  // Lọc chỉ assistant messages, lấy 4 cái gần nhất
  const aiTurns = history.filter(h => h.sender === 'assistant').slice(-4);
  let count = 0;
  // Duyệt từ gần nhất về trước
  for (const turn of [...aiTurns].reverse()) {
    if (/\?/.test(turn.message)) count++;
    else break; // Gặp turn không có ? → dừng đếm
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
  }

  // ── HEALTH METRICS ────────────────────────────────────
  if (logsSummary) {
    const metrics = [];
    if (logsSummary.latest_glucose) {
      const g = logsSummary.latest_glucose;
      metrics.push(`đường huyết gần nhất ${g.value} ${g.unit || 'mg/dL'}`);
    }
    if (logsSummary.latest_bp) {
      const bp = logsSummary.latest_bp;
      metrics.push(`huyết áp gần nhất ${bp.systolic}/${bp.diastolic} mmHg`);
    }
    if (metrics.length) {
      lines.push(`Chỉ số sức khoẻ gần nhất: ${metrics.join(', ')}.`);
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
  lines.push('- Mỗi lượt TỐI ĐA 1 câu hỏi. Phải đưa ra câu trả lời/lời khuyên cụ thể TRƯỚC, rồi mới hỏi thêm nếu thực sự cần.');
  lines.push('- CHỈ hỏi khi thiếu thông tin mà không có cách nào trả lời nếu thiếu nó. Nếu hồ sơ hoặc lịch sử hội thoại đã đủ → KHÔNG hỏi, trả lời luôn.');
  lines.push('- Kiểm tra lịch sử: nếu đã hỏi câu tương tự trước đó → KHÔNG hỏi lại, dùng những gì người dùng đã chia sẻ.');

  // Dynamic stop injection based on conversation state
  const consecutiveQuestions = countConsecutiveAiQuestions(history);
  const prevWasQuestion = lastAiTurnWasQuestion(history);

  if (consecutiveQuestions >= 2) {
    lines.push('');
    lines.push('⛔ CẢNH BÁO VÒNG LẶP: Bạn đã hỏi liên tiếp nhiều lượt. Lần này PHẢI đưa ra câu trả lời/lời khuyên cụ thể dựa trên thông tin đã có. KHÔNG được hỏi thêm bất kỳ câu nào.');
  } else if (prevWasQuestion) {
    lines.push('');
    lines.push('⚠️ Lượt trước bạn đã hỏi người dùng. Lần này ưu tiên đưa ra câu trả lời hoặc lời khuyên dựa trên thông tin người dùng vừa chia sẻ. Nếu vẫn cần hỏi thêm, hỏi tối đa 1 câu sau khi đã trả lời.');
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
    const [glucoseResult, bpResult] = await Promise.all([
      pool.query(
        `SELECT d.value, d.unit, c.occurred_at
         FROM logs_common c
         JOIN glucose_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'glucose'
           AND c.occurred_at >= NOW() - INTERVAL '7 days'
         ORDER BY c.occurred_at DESC LIMIT 1`,
        [userId]
      ),
      pool.query(
        `SELECT d.systolic, d.diastolic, c.occurred_at
         FROM logs_common c
         JOIN blood_pressure_logs d ON d.log_id = c.id
         WHERE c.user_id = $1 AND c.log_type = 'bp'
           AND c.occurred_at >= NOW() - INTERVAL '7 days'
         ORDER BY c.occurred_at DESC LIMIT 1`,
        [userId]
      )
    ]);
    return {
      latest_glucose: glucoseResult.rows[0] || null,
      latest_bp: bpResult.rows[0] || null,
    };
  } catch (err) {
    console.warn('[chat.service] getHealthLogsSummary failed:', err?.message);
    return { latest_glucose: null, latest_bp: null };
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
        console.warn('[chat.service] onboarding context fetch failed:', err?.message || err);
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
        console.warn('[chat.service] context fetch failed:', err?.message || err);
      }
      await saveUserMessage(pool, userId, message, now);
    }

    // Get AI reply — pass conversation history and system prompt for Gemini
    const providerContext = { ...context, user_id: userId };
    const replyResult = await getChatReply(finalMessage, providerContext, conversationHistory, systemPrompt);
    const reply = replyResult.reply || '';
    const replyProvider = replyResult.provider || 'mock';

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
    console.error('[chat.service] processChat failed:', err);
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
