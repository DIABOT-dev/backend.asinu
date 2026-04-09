/**
 * Chat Controller
 * HTTP handlers for AI chat endpoints
 */

const { chatRequestSchema } = require('../validation/validation.schemas');
const { processChat, getChatHistory, RETENTION_DAYS_FREE, RETENTION_DAYS_PREMIUM } = require('../services/chat/chat.service');
const { getWhisperTranscription } = require('../services/ai/providers/openai');
const { VOICE_MONTHLY_LIMIT, getVoiceUsageThisMonth, incrementVoiceUsage } = require('../services/payment/subscription.service');
const { t, getLang } = require('../i18n');
const feedbackService = require('../services/chat/chat-feedback.service');

/**
 * POST /api/chat
 * Process user message and get AI reply
 */
async function postChat(pool, req, res) {
  // Validate request
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: t('error.invalid_payload', getLang(req)), details: parsed.error.issues });
  }

  const { message, client_ts, context } = parsed.data;

  // Call service
  const result = await processChat(pool, req.user.id, message, context);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json({
    ok: true,
    reply: result.reply,
    chat_id: result.chat_id,
    provider: result.provider,
    created_at: result.created_at,
    client_ts
  });
}

/**
 * GET /api/mobile/chat/history
 * Get chat history for display
 */
async function getChatHistoryHandler(pool, req, res) {
  try {
    const userId = req.user.id;
    const isPremium = req.user.subscription_tier === 'premium';
    const retentionDays = isPremium ? RETENTION_DAYS_PREMIUM : RETENTION_DAYS_FREE;
    const messages = await getChatHistory(pool, userId, 200, retentionDays);

    return res.status(200).json({
      ok: true,
      messages: messages.map(m => ({
        id: String(m.id),
        role: m.sender === 'assistant' ? 'assistant' : 'user',
        text: m.message,
        timestamp: new Date(m.created_at).toISOString()
      }))
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * POST /api/mobile/chat/transcribe
 * Transcribe audio to text using Whisper
 */
async function transcribeAudio(pool, req, res) {
  if (!req.file) return res.status(400).json({ ok: false, error: t('error.missing_audio', getLang(req)) });

  const voiceUsed = await getVoiceUsageThisMonth(pool, req.user.id);
  if (voiceUsed >= VOICE_MONTHLY_LIMIT) {
    return res.status(429).json({
      ok: false,
      code: 'VOICE_LIMIT_EXCEEDED',
      error: t('error.voice_limit_exceeded', getLang(req), { limit: VOICE_MONTHLY_LIMIT }),
      voiceUsed,
      voiceLimit: VOICE_MONTHLY_LIMIT,
    });
  }

  try {
    const lang = req.headers['accept-language']?.startsWith('en') ? 'en' : 'vi';
    const text = await getWhisperTranscription(req.file.buffer, req.file.originalname, lang);
    await incrementVoiceUsage(pool, req.user.id);
    return res.status(200).json({ ok: true, text, voiceUsed: voiceUsed + 1, voiceLimit: VOICE_MONTHLY_LIMIT });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /api/mobile/chat/feedback
 * Like / dislike / note a chat message
 */
async function postChatFeedback(pool, req, res) {
  const { messageId, messageText, feedbackType } = req.body;
  const userId = req.user.id;
  if (!['like', 'dislike', 'note'].includes(feedbackType) || !messageId || !messageText) {
    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
  }
  try {
    if (feedbackType === 'note') {
      const existing = await feedbackService.checkExistingNote(pool, userId, messageId);
      if (existing.length > 0) {
        return res.json({ ok: true, action: 'already_noted' });
      }
      await feedbackService.saveChatNote(pool, userId, messageId, messageText);
      return res.json({ ok: true, action: 'saved' });
    }
    // like / dislike — toggle or switch
    const rows = await feedbackService.getExistingFeedback(pool, userId, messageId);
    if (rows.length > 0) {
      if (rows[0].feedback_type === feedbackType) {
        await feedbackService.deleteFeedback(pool, rows[0].id);
        return res.json({ ok: true, action: 'removed' });
      }
      await feedbackService.updateFeedbackType(pool, rows[0].id, feedbackType);
      return res.json({ ok: true, action: 'updated' });
    }
    await feedbackService.saveFeedback(pool, userId, messageId, messageText, feedbackType);
    return res.json({ ok: true, action: 'saved' });
  } catch {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * GET /api/mobile/chat/notes
 * Get all noted messages
 */
async function getChatNotes(pool, req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    const { notes, total } = await feedbackService.getChatNotes(pool, req.user.id, page, limit);

    return res.json({
      ok: true,
      notes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * DELETE /api/mobile/chat/notes/:id
 * Delete a noted message
 */
async function deleteChatNote(pool, req, res) {
  try {
    await feedbackService.deleteNote(pool, parseInt(req.params.id), req.user.id);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * GET /api/mobile/chat/feedbacks
 * Return like/dislike feedback map for UI state
 */
async function getChatFeedbacks(pool, req, res) {
  try {
    const rows = await feedbackService.getChatFeedbacks(pool, req.user.id);
    const map = {};
    for (const r of rows) map[r.message_id] = r.feedback_type;
    return res.json({ ok: true, feedbacks: map });
  } catch {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

/**
 * GET /api/mobile/chat/noted-ids
 * Return list of message_ids that user has noted (for UI state)
 */
async function getChatNotedIds(pool, req, res) {
  try {
    const rows = await feedbackService.getChatNotedIds(pool, req.user.id);
    return res.json({ ok: true, ids: rows.map(r => r.message_id) });
  } catch {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

module.exports = {
  postChat,
  getChatHistoryHandler,
  transcribeAudio,
  postChatFeedback,
  getChatNotes,
  deleteChatNote,
  getChatFeedbacks,
  getChatNotedIds,
};
