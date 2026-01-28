const { chatRequestSchema } = require('../validation/schemas');
const { getChatReply } = require('../services/chatProvider');

async function postChat(pool, req, res) {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  const { message, client_ts, context } = parsed.data;

  try {
    const userId = req.user.id;
    const now = new Date();

    await pool.query(
      `INSERT INTO chat_histories (user_id, message, sender, created_at)
       VALUES ($1, $2, 'user', $3)`,
      [userId, message, now]
    );

    const replyResult = await getChatReply(message, context);
    const reply = replyResult.reply || '';
    const provider = replyResult.provider || 'mock';

    const assistantResult = await pool.query(
      `INSERT INTO chat_histories (user_id, message, sender, created_at)
       VALUES ($1, $2, 'assistant', $3)
       RETURNING id, created_at`,
      [userId, reply, now]
    );

    const row = assistantResult.rows[0];
    return res.status(200).json({
      ok: true,
      reply,
      chat_id: row?.id,
      provider,
      created_at: row?.created_at ? new Date(row.created_at).toISOString() : now.toISOString(),
      client_ts
    });
  } catch (err) {
    console.error('chat failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = { postChat };
