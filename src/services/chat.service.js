/**
 * Chat Service
 * Business logic cho AI chat
 * - Build onboarding context
 * - Format user messages
 * - Process AI replies
 */

// =====================================================
// CONSTANTS
// =====================================================

const FALLBACK_CONTEXT =
  'Người dùng chưa có hồ sơ onboarding chi tiết. Hãy trả lời thấu cảm, ngắn gọn, không giả định dữ liệu cá nhân.';

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
  notes.push(`Giới tính: ${profile.gender}. Nhóm tuổi: ${profile.age}.`);
  notes.push(`Mục tiêu: ${profile.goal}. Thể trạng: ${profile.body_type}.`);
  
  if (medical) notes.push(`Bệnh lý: ${medical}.`);
  if (symptoms) notes.push(`Triệu chứng: ${symptoms}.`);
  if (joints) notes.push(`Vấn đề khớp: ${joints}.`);
  
  notes.push(
    `Thói quen: linh hoạt ${profile.flexibility}, leo thang ${profile.stairs_performance}, ` +
    `tập luyện ${profile.exercise_freq}, đi bộ ${profile.walking_habit}, ` +
    `nước ${profile.water_intake}, ngủ ${profile.sleep_duration}.`
  );
  
  notes.push('Hãy trả lời thấu cảm, dễ hiểu, có bước hành động cụ thể; nhắc lại mục tiêu hoặc triệu chứng chính ít nhất một lần.');
  
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
    return `Mục tiêu của bạn là ${profile.goal}, triệu chứng chính là ${primarySymptom}.`;
  }
  if (profile.goal) {
    return `Mục tiêu của bạn là ${profile.goal}.`;
  }
  if (primarySymptom) {
    return `Triệu chứng chính là ${primarySymptom}.`;
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
// DATABASE OPERATIONS
// =====================================================

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

    // Save user message
    await saveUserMessage(pool, userId, message, now);

    // Get AI provider
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    let finalMessage = message;
    let onboardingProfile = null;

    // Build context for DiaBrain provider
    if (provider === 'diabrain') {
      try {
        onboardingProfile = await getOnboardingProfile(pool, userId);
        const contextText = buildOnboardingContext(onboardingProfile);
        finalMessage = formatMessageWithContext(message, contextText);
      } catch (err) {
        console.warn('[chat.service] onboarding context fetch failed:', err?.message || err);
        finalMessage = formatMessageWithContext(message, FALLBACK_CONTEXT);
      }
    }

    // Get AI reply
    const providerContext = { ...context, user_id: userId };
    const replyResult = await getChatReply(finalMessage, providerContext);
    let reply = replyResult.reply || '';
    const replyProvider = replyResult.provider || 'mock';

    // Add mention hint for DiaBrain if needed
    if (replyProvider === 'diabrain' && onboardingProfile) {
      reply = enhanceReplyWithProfile(reply, onboardingProfile);
    }

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
    return { ok: false, error: 'Server error' };
  }
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Constants
  FALLBACK_CONTEXT,
  
  // Helpers
  collectIssueItems,
  formatIssueList,
  
  // Context building
  buildOnboardingContext,
  buildMentionHint,
  replyMentionsProfile,
  formatMessageWithContext,
  enhanceReplyWithProfile,
  
  // Database operations
  getOnboardingProfile,
  saveUserMessage,
  saveAssistantReply,
  
  // Main
  processChat,
};
