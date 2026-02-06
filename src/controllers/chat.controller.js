/**
 * Chat Controller
 * HTTP handlers for AI chat endpoints
 */

const { chatRequestSchema } = require('../validation/validation.schemas');
const { processChat } = require('../services/chat.service');

/**
 * POST /api/chat
 * Process user message and get AI reply
 */
async function postChat(pool, req, res) {
  // Validate request
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
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

module.exports = { postChat };
