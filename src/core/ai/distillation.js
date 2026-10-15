'use strict';

/**
 * Distillation Pipeline — "Càng dùng càng rẻ"
 *
 * Chiến lược:
 *   1. COLLECT: Ghi lại mọi Big Model output vào distillation_data
 *   2. CURATE: Đánh giá chất lượng (quality_score) — tự động hoặc thủ công
 *   3. ENHANCE: Dùng top-rated outputs làm few-shot examples cho Small Model
 *
 * Kết quả: Sau thời gian, Small Model trả lời chính xác hơn → ít cần Big Model
 */

// Collection and cross-user few-shot reuse are suspended until training
// consent, subject ownership, retention and deletion are implemented.
// Service/AI consent is not consent to train on patient conversations.
async function collectOutput() {
  return null;
}

// ─── Curate: Rate quality ───────────────────────────────────────────────────

/**
 * Auto-rate quality based on response properties.
 * Called automatically after collecting Big Model output.
 *
 * Rules:
 *   - Has all expected fields → +0.3
 *   - Response length reasonable → +0.2
 *   - No error/fallback indicators → +0.3
 *   - Valid JSON structure → +0.2
 */
function autoRateQuality(outputData) {
  let score = 0;

  // Check if output has content
  if (outputData && typeof outputData === 'object') {
    score += 0.2; // valid object

    // Has text/question/summary
    const hasContent = outputData.text || outputData.question || outputData.summary;
    if (hasContent) score += 0.3;

    // Reasonable length (not empty, not truncated)
    const text = String(outputData.text || outputData.question || outputData.summary || '');
    if (text.length > 10 && text.length < 2000) score += 0.2;

    // No error indicators
    const textLower = text.toLowerCase();
    if (
      !textLower.includes('error') &&
      !textLower.includes('sorry') &&
      !textLower.includes('i cannot')
    ) {
      score += 0.3;
    }
  }

  return Math.min(score, 1.0);
}

async function rateOutput(pool, id, qualityScore) {
  await pool.query(`UPDATE distillation_data SET quality_score = $2 WHERE id = $1`, [
    id,
    qualityScore,
  ]);
}

// ─── Enhance: Build few-shot examples ───────────────────────────────────────

/**
 * Get top-rated examples for a task type to use as few-shot prompts.
 * Returns examples that haven't been used yet, sorted by quality.
 *
 * @param {object} pool
 * @param {string} taskType
 * @param {number} limit - max examples to return (default 3)
 * @returns {Array<{input: object, output: object, score: number}>}
 */
async function getFewShotExamples() {
  return [];
}

/**
 * Build enhanced messages array with few-shot examples prepended.
 * Adds top-rated Big Model outputs as example conversations before the actual prompt.
 *
 * @param {object} pool
 * @param {string} taskType
 * @param {Array} originalMessages - the messages you'd normally send
 * @returns {{ messages: Array, enhancedWith: number }}
 */
async function enhanceWithFewShot(pool, taskType, originalMessages) {
  const examples = await getFewShotExamples(pool, taskType, 3);

  if (examples.length === 0) {
    return { messages: originalMessages, enhancedWith: 0 };
  }

  // Build few-shot messages
  const fewShotMessages = [];
  for (const ex of examples) {
    // Extract user message from input
    const userMsg = Array.isArray(ex.input)
      ? ex.input.find((m) => m.role === 'user')?.content || ''
      : JSON.stringify(ex.input);

    // Extract assistant response from output
    const assistantMsg = typeof ex.output === 'string' ? ex.output : JSON.stringify(ex.output);

    fewShotMessages.push({ role: 'user', content: userMsg });
    fewShotMessages.push({ role: 'assistant', content: assistantMsg });
  }

  // Insert few-shot examples after system message but before user query
  const systemMsg = originalMessages.find((m) => m.role === 'system');
  const restMessages = originalMessages.filter((m) => m.role !== 'system');

  const enhanced = [...(systemMsg ? [systemMsg] : []), ...fewShotMessages, ...restMessages];

  // Mark examples as used
  // (Not critical — just for tracking)

  return { messages: enhanced, enhancedWith: examples.length };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

async function getDistillationStats(pool) {
  const { rows } = await pool.query(`
    SELECT
      task_type,
      model_used,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE quality_score >= 0.7)::int AS high_quality,
      AVG(quality_score)::numeric(4,2) AS avg_quality,
      COUNT(*) FILTER (WHERE used_as_fewshot)::int AS used_as_fewshot
    FROM distillation_data
    GROUP BY task_type, model_used
    ORDER BY task_type, model_used
  `);
  return rows;
}

async function getGlobalDistillationStats(pool) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_collected,
      COUNT(*) FILTER (WHERE quality_score >= 0.7)::int AS high_quality,
      COUNT(*) FILTER (WHERE model_used = 'gpt-4o')::int AS big_model_outputs,
      COUNT(*) FILTER (WHERE model_used = 'gpt-4o-mini')::int AS small_model_outputs,
      AVG(quality_score)::numeric(4,2) AS avg_quality
    FROM distillation_data
  `);
  return rows[0];
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  collectOutput,
  autoRateQuality,
  rateOutput,
  getFewShotExamples,
  enhanceWithFewShot,
  getDistillationStats,
  getGlobalDistillationStats,
};
