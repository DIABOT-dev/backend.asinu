/**
 * Chat Controller
 * HTTP handlers for AI chat endpoints
 */

const { chatRequestSchema } = require('../validation/validation.schemas');
const { processChat, getChatHistory, RETENTION_DAYS_FREE, RETENTION_DAYS_PREMIUM } = require('../services/chat.service');
const { t, getLang } = require('../i18n');

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

module.exports = { postChat, getChatHistoryHandler };
