/**
 * AI Logger Service
 *
 * Records every AI invocation so we can:
 *  - debug bad responses,
 *  - track spend by feature/provider,
 *  - detect runaway cost trends.
 *
 * Writes are best-effort: logging failures NEVER break the main request.
 */

const logger = require('../../lib/logger');
const { estimateCost } = require('./ai-cost.service');

const PROMPT_PREVIEW_LIMIT = 500;
const RESPONSE_PREVIEW_LIMIT = 1000;

/**
 * @param {object} pool      pg pool
 * @param {object} entry
 * @param {number} entry.userId
 * @param {string} entry.type             — legacy column: 'triage' | 'chat' | 'onboarding'
 * @param {string} [entry.feature]        — new column: 'checkin' | 'script_generation' | 'alert_filter' | 'chat' | 'symptom_analysis' | 'triage_conclusion'
 * @param {string} [entry.action]         — finer-grained: e.g. 'risk_assessment', 'whisper_transcribe'
 * @param {string} [entry.provider]       — 'openai' | 'medgemma' | 'gemini' | 'diabrain'
 * @param {string} [entry.model]
 * @param {string} [entry.promptSummary]
 * @param {string} [entry.responseSummary]
 * @param {number} [entry.inputTokens]
 * @param {number} [entry.outputTokens]
 * @param {number} [entry.tokensUsed]     — fallback when input/output not split
 * @param {number} [entry.estimatedCost]  — USD; auto-computed if omitted
 * @param {number} [entry.latencyMs]
 * @param {number} [entry.durationMs]     — legacy alias for latencyMs
 * @param {boolean}[entry.isFallback]
 * @param {boolean}[entry.safetyFiltered]
 * @param {boolean}[entry.success]
 * @param {string} [entry.error]
 */
async function logAiInteraction(pool, entry = {}) {
  try {
    const {
      userId,
      type,
      feature = type || null,
      action = null,
      provider = null,
      model = 'gpt-4o',
      promptSummary = '',
      responseSummary = '',
      inputTokens = null,
      outputTokens = null,
      tokensUsed = (inputTokens || 0) + (outputTokens || 0),
      latencyMs = entry.durationMs || 0,
      durationMs = latencyMs,
      isFallback = false,
      safetyFiltered = false,
      error = null,
    } = entry;

    const success = entry.success != null ? entry.success : !error;
    const estimatedCost = entry.estimatedCost != null
      ? entry.estimatedCost
      : estimateCost({ provider, model, inputTokens, outputTokens });

    await pool.query(
      `INSERT INTO ai_logs (
         user_id, type, feature, action, provider, model,
         prompt_summary, response_summary,
         input_tokens, output_tokens, tokens_used, estimated_cost,
         latency_ms, duration_ms,
         is_fallback, safety_filtered, success, error
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8,
         $9, $10, $11, $12,
         $13, $14,
         $15, $16, $17, $18
       )`,
      [
        userId,
        type || feature,
        feature,
        action,
        provider,
        model,
        (promptSummary || '').slice(0, PROMPT_PREVIEW_LIMIT),
        (responseSummary || '').slice(0, RESPONSE_PREVIEW_LIMIT),
        inputTokens,
        outputTokens,
        tokensUsed || null,
        estimatedCost,
        latencyMs || null,
        durationMs || null,
        isFallback,
        safetyFiltered,
        success,
        error,
      ]
    );
  } catch (err) {
    logger.warn('ai_logger.write_failed', { err });
  }
}

module.exports = { logAiInteraction };
