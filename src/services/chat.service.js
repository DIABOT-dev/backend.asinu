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

/**
 * Build system prompt for Gemini from user profile.
 * @param {Object|null} profile - User onboarding profile
 * @param {number} historyLength - Number of prior messages in this conversation
 * @returns {string} - System prompt
 */
const buildSystemPrompt = (profile, historyLength = 0) => {
  const isFirstTurn = historyLength === 0;
  const lines = ['Bạn là Asinu — trợ lý sức khỏe cá nhân.', ''];

  // ── PROFILE ──────────────────────────────────────────
  if (profile) {
    const medical  = formatIssueList(profile.medical_conditions);
    const symptoms = formatIssueList(profile.chronic_symptoms);
    const joints   = formatIssueList(profile.joint_issues);

    lines.push('HỒ SƠ SỨC KHỎE (đã biết — KHÔNG hỏi lại những thông tin này):');
    if (profile.gender)    lines.push(`- Giới tính: ${profile.gender}`);
    if (profile.age)       lines.push(`- Nhóm tuổi: ${profile.age}`);
    if (profile.goal)      lines.push(`- Mục tiêu: ${profile.goal}`);
    if (profile.body_type) lines.push(`- Thể trạng: ${profile.body_type}`);
    if (medical)           lines.push(`- Bệnh lý nền: ${medical}`);
    if (symptoms)          lines.push(`- Triệu chứng mãn tính: ${symptoms}`);
    if (joints)            lines.push(`- Vấn đề khớp: ${joints}`);

    const habits = [];
    if (profile.exercise_freq)  habits.push(`tập ${profile.exercise_freq}`);
    if (profile.sleep_duration) habits.push(`ngủ ${profile.sleep_duration}`);
    if (profile.water_intake)   habits.push(`nước ${profile.water_intake}`);
    if (habits.length) lines.push(`- Thói quen: ${habits.join(', ')}`);

    // Build a concrete focus so the AI knows what to centre advice around
    const focuses = [];
    if (profile.goal) focuses.push(`"${profile.goal}"`);
    if (joints)       focuses.push(`khớp (${joints})`);
    if (symptoms)     focuses.push(symptoms);
    if (medical)      focuses.push(medical);

    if (focuses.length) {
      lines.push('');
      lines.push(`TRỌNG TÂM: Mọi câu hỏi và lời khuyên phải liên quan trực tiếp đến ${focuses.slice(0, 2).join(' và ')} của người dùng này.`);
    }
  } else {
    lines.push('HỒ SƠ SỨC KHỎE: chưa có — hỏi thăm sức khỏe chung một cách tự nhiên.');
  }

  // ── CONVERSATION RULES ───────────────────────────────
  lines.push('');
  lines.push('NGUYÊN TẮC:');

  if (isFirstTurn) {
    lines.push('- Tin ĐẦU TIÊN: chào ngắn (1 câu) rồi hỏi ĐÚNG 1 câu cụ thể dựa trên hồ sơ — không hỏi chung chung.');
  } else {
    lines.push('- Cuộc trò chuyện đang tiếp diễn: TUYỆT ĐỐI không chào lại — đi thẳng vào nội dung.');
  }

  lines.push('- Mỗi lượt hỏi TỐI ĐA 1 câu, phải cụ thể và chưa hỏi trong lịch sử trò chuyện.');
  lines.push('- Đọc lịch sử hội thoại: câu nào đã hỏi → KHÔNG hỏi lại dưới bất kỳ hình thức nào.');
  lines.push('- Sau 2-3 lượt hỏi-đáp về cùng chủ đề → DỪNG hỏi, đưa ra khuyến nghị cụ thể và hành động được.');
  lines.push('- Trả lời ngắn (2-4 câu). Nhắc trực tiếp đến tình trạng của họ: "Với [mục tiêu/triệu chứng] của bạn…"');
  lines.push('- Không phải bác sĩ — chỉ khuyến nghị khám chuyên khoa khi thật sự cần.');

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
 * @returns {Promise<Array<{message: string, sender: string}>>}
 */
async function getRecentHistory(pool, userId, limit = HISTORY_LIMIT) {
  const result = await pool.query(
    `SELECT message, sender FROM chat_histories
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.reverse(); // chronological order
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

  try {
    const now = new Date();
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    let finalMessage = message;
    let onboardingProfile = null;
    let conversationHistory = [];
    let systemPrompt = null;

    if (provider === 'diabrain') {
      // DiaBrain manages its own conversation state — keep existing behavior
      await saveUserMessage(pool, userId, message, now);
      try {
        onboardingProfile = await getOnboardingProfile(pool, userId);
        const contextText = buildOnboardingContext(onboardingProfile);
        finalMessage = formatMessageWithContext(message, contextText);
      } catch (err) {
        console.warn('[chat.service] onboarding context fetch failed:', err?.message || err);
        finalMessage = formatMessageWithContext(message, FALLBACK_CONTEXT);
      }
    } else {
      // Gemini/other: fetch history + profile BEFORE saving current message
      // so the current user turn is not duplicated in history
      try {
        [onboardingProfile, conversationHistory] = await Promise.all([
          getOnboardingProfile(pool, userId),
          getRecentHistory(pool, userId, HISTORY_LIMIT),
        ]);
        systemPrompt = buildSystemPrompt(onboardingProfile, conversationHistory.length);
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

  // Database operations
  getOnboardingProfile,
  getRecentHistory,
  saveUserMessage,
  saveAssistantReply,

  // Main
  processChat,
};
