/**
 * Daily/monthly usage accounting for the chatbot feature.
 *
 * Two reads:
 *   - getDailyMessageCount(userId)    → message count today
 *   - getMonthlyTokenCount(userId)    → tokens consumed this month
 *
 * One write:
 *   - recordChatbotUse(userId, tokens) → upserts today's row
 *
 * Best-effort: write failures log but never break the chat reply flow.
 */

const logger = require('../../lib/logger');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function thisMonthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function getDailyMessageCount(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(message_count, 0) AS n
       FROM chatbot_usage
      WHERE user_id = $1 AND day_key = $2`,
    [userId, todayKey()]
  );
  return rows[0]?.n || 0;
}

async function getMonthlyTokenCount(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(tokens_used), 0)::INTEGER AS n
       FROM chatbot_usage
      WHERE user_id = $1 AND month_key = $2`,
    [userId, thisMonthKey()]
  );
  return rows[0]?.n || 0;
}

async function recordChatbotUse(pool, userId, tokens = 0) {
  try {
    await pool.query(
      `INSERT INTO chatbot_usage (user_id, day_key, month_key, message_count, tokens_used)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, day_key)
       DO UPDATE SET
         message_count = chatbot_usage.message_count + 1,
         tokens_used   = chatbot_usage.tokens_used + EXCLUDED.tokens_used,
         updated_at    = NOW()`,
      [userId, todayKey(), thisMonthKey(), tokens]
    );
  } catch (err) {
    logger.warn('chatbot_usage.record_failed', { user_id: userId, err });
  }
}

module.exports = {
  getDailyMessageCount,
  getMonthlyTokenCount,
  recordChatbotUse,
};
