/**
 * AI Logger Service
 * Logs all AI interactions for debugging and audit.
 */

async function logAiInteraction(pool, {
  userId,
  type, // 'triage' | 'chat' | 'onboarding'
  model = 'gpt-4o',
  promptSummary = '',
  responseSummary = '',
  tokensUsed = 0,
  durationMs = 0,
  isFallback = false,
  safetyFiltered = false,
  error = null,
}) {
  try {
    await pool.query(
      `INSERT INTO ai_logs (user_id, type, model, prompt_summary, response_summary, tokens_used, duration_ms, is_fallback, safety_filtered, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        type,
        model,
        (promptSummary || '').slice(0, 500),
        (responseSummary || '').slice(0, 1000),
        tokensUsed,
        durationMs,
        isFallback,
        safetyFiltered,
        error,
      ]
    );
  } catch (err) {
    // Don't let logging failure break the main flow
    console.error('[AI Logger] Failed to log:', err.message);
  }
}

module.exports = { logAiInteraction };
