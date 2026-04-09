'use strict';

/**
 * AI Script Generator
 *
 * Takes AI symptom analysis -> creates a full triage script
 * that can be cached and run without AI.
 *
 * Flow:
 *   1. ai-symptom-analyzer returns analysis
 *   2. This service builds a complete script_data JSON
 *   3. Script is saved to triage_scripts table
 *   4. Next time -> script runs from cache, 0 AI
 */

const { validateScript } = require('../../core/checkin/script-runner');
const { AI_MODEL } = require('../../core/agent/ai-symptom-analyzer');

// ─── Standard follow-up questions (reused across all generated scripts) ─────

const STANDARD_FOLLOWUP_QUESTIONS = [
  {
    id: 'fu1',
    text: 'So với lúc trước, {honorific} thấy thế nào?',
    type: 'single_choice',
    options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'],
  },
  {
    id: 'fu2',
    text: 'Có triệu chứng mới không?',
    type: 'single_choice',
    options: ['Không', 'Có'],
  },
];

const STANDARD_FALLBACK_QUESTIONS = [
  { id: 'fb1', text: 'Đau mức nào?', type: 'slider', min: 0, max: 10 },
  { id: 'fb2', text: 'Từ khi nào?', type: 'single_choice', options: ['Vừa mới', 'Vài giờ trước', 'Từ sáng', 'Từ hôm qua', 'Vài ngày'] },
  { id: 'fb3', text: 'Nặng hơn không?', type: 'single_choice', options: ['Đang đỡ', 'Vẫn vậy', 'Nặng hơn'] },
];

// ─── Generate script from AI analysis ───────────────────────────────────────

/**
 * Generate a complete script from AI analysis.
 *
 * @param {object} analysis - from ai-symptom-analyzer.analyzeSymptom()
 * @param {object} profile - user profile { name, age, gender, conditions, medications }
 * @returns {object} script_data ready to save to triage_scripts
 */
function generateFromAnalysis(analysis, profile = {}) {
  if (!analysis || !analysis.suggestedQuestions) {
    console.warn('[AIScriptGen] Invalid analysis, using fallback structure');
    return _buildFallbackScript(analysis, profile);
  }

  // Build questions: tag each with cluster key
  const questions = analysis.suggestedQuestions.map(q => ({
    ...q,
    cluster: analysis.clusterKey,
  }));

  // Build condition modifiers based on user's medical conditions
  const conditionModifiers = _buildConditionModifiers(questions, profile);

  // Build personalized greeting
  const displayName = analysis.displayName || analysis.understood || 'triệu chứng';
  const greeting = `{CallName} ơi, {selfRef} hỏi thăm {honorific} về ${displayName} nhé`;

  // Build script_data
  const scriptData = {
    greeting,
    questions,
    scoring_rules: analysis.scoringRules || [],
    condition_modifiers: conditionModifiers,
    conclusion_templates: analysis.conclusionTemplates || _defaultConclusionTemplates(),
    followup_questions: STANDARD_FOLLOWUP_QUESTIONS,
    fallback_questions: STANDARD_FALLBACK_QUESTIONS,
    metadata: {
      source: 'ai',
      model: AI_MODEL,
      analyzed_at: new Date().toISOString(),
      category: analysis.category || 'unknown',
      urgency: analysis.urgency || 'unknown',
      possible_causes: analysis.possibleCauses || [],
      confidence: analysis.confidence || 0,
      understood_as: analysis.understood || '',
    },
  };

  // Validate
  const { valid, errors } = validateScript(scriptData);
  if (!valid) {
    console.warn('[AIScriptGen] Generated script has validation issues:', errors);
    // Still return it - scoring engine handles missing fields gracefully
  }

  return scriptData;
}

// ─── Save generated script to DB ────────────────────────────────────────────

/**
 * Save generated script to DB and cache.
 *
 * @param {object} pool - database pool
 * @param {number} userId
 * @param {string} clusterKey
 * @param {string} displayName
 * @param {object} scriptData - from generateFromAnalysis()
 * @returns {Promise<{ cluster: object, script: object }>}
 */
async function saveGeneratedScript(pool, userId, clusterKey, displayName, scriptData) {
  // 1. Create or update problem_cluster
  const { rows: clusterRows } = await pool.query(
    `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source)
     VALUES ($1, $2, $3, 'ai_realtime')
     ON CONFLICT (user_id, cluster_key) DO UPDATE SET
       display_name = $3, is_active = TRUE, updated_at = NOW()
     RETURNING *`,
    [userId, clusterKey, displayName]
  );
  const cluster = clusterRows[0];

  // 2. Deactivate old scripts for this cluster
  await pool.query(
    `UPDATE triage_scripts SET is_active = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND cluster_key = $2 AND script_type = 'initial' AND is_active = TRUE`,
    [userId, clusterKey]
  );

  // 3. Save new script
  const { rows: scriptRows } = await pool.query(
    `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by)
     VALUES ($1, $2, $3, 'initial', $4::jsonb, 'ai_realtime')
     RETURNING *`,
    [userId, cluster.id, clusterKey, JSON.stringify(scriptData)]
  );
  const script = scriptRows[0];

  console.log(`[AIScriptGen] Saved script for user=${userId}, cluster=${clusterKey}, script_id=${script.id}`);

  return { cluster, script };
}

// ─── Condition modifiers builder ────────────────────────────────────────────

function _buildConditionModifiers(questions, profile) {
  const modifiers = [];
  const conditions = profile.conditions || profile.medical_conditions || [];

  // Find the first slider question (severity indicator)
  const sliderQ = questions.find(q => q.type === 'slider');
  const sliderField = sliderQ ? sliderQ.id : null;

  // Diabetes: lower threshold for severity bump
  if (sliderField) {
    modifiers.push({
      user_condition: 'tiểu đường',
      extra_conditions: [{ field: sliderField, op: 'gte', value: 5 }],
      action: 'bump_severity',
      to: 'high',
    });

    modifiers.push({
      user_condition: 'đái tháo đường',
      extra_conditions: [{ field: sliderField, op: 'gte', value: 5 }],
      action: 'bump_severity',
      to: 'high',
    });

    // Heart conditions
    modifiers.push({
      user_condition: 'bệnh tim',
      extra_conditions: [{ field: sliderField, op: 'gte', value: 4 }],
      action: 'bump_severity',
      to: 'high',
    });

    // Hypertension
    modifiers.push({
      user_condition: 'cao huyết áp',
      extra_conditions: [{ field: sliderField, op: 'gte', value: 5 }],
      action: 'bump_severity',
      to: 'high',
    });
  }

  return modifiers;
}

// ─── Fallback script (when AI analysis is incomplete) ───────────────────────

function _buildFallbackScript(analysis, profile) {
  const displayName = (analysis && analysis.displayName) || 'triệu chứng';

  return {
    greeting: `{CallName} ơi, {selfRef} hỏi thăm {honorific} thêm nhé`,
    questions: STANDARD_FALLBACK_QUESTIONS,
    scoring_rules: [
      {
        conditions: [{ field: 'fb1', op: 'gte', value: 7 }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: true,
      },
      {
        conditions: [{ field: 'fb3', op: 'eq', value: 'Nặng hơn' }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'fb1', op: 'gte', value: 4 }],
        combine: 'and',
        severity: 'medium',
        follow_up_hours: 3,
        needs_doctor: false,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'fb1', op: 'lt', value: 4 }],
        combine: 'and',
        severity: 'low',
        follow_up_hours: 6,
        needs_doctor: false,
        needs_family_alert: false,
      },
    ],
    condition_modifiers: [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: 'fb1', op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
    ],
    conclusion_templates: _defaultConclusionTemplates(),
    followup_questions: STANDARD_FOLLOWUP_QUESTIONS,
    fallback_questions: STANDARD_FALLBACK_QUESTIONS,
    metadata: {
      source: 'ai_fallback',
      model: AI_MODEL,
      analyzed_at: new Date().toISOString(),
    },
  };
}

function _defaultConclusionTemplates() {
  return {
    low: {
      summary: '{Honorific} có triệu chứng nhẹ.',
      recommendation: 'Nghỉ ngơi, uống đủ nước. Theo dõi trong 24h.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} tối nay nhé.',
    },
    medium: {
      summary: '{Honorific} có triệu chứng mức trung bình, cần theo dõi.',
      recommendation: 'Nghỉ ngơi, uống thuốc nếu có. Nếu không đỡ sau 24h nên đi khám.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} sau 3 tiếng nhé.',
    },
    high: {
      summary: '{Honorific} có triệu chứng nặng, cần được bác sĩ đánh giá.',
      recommendation: '{Honorific} nên đi khám bác sĩ hôm nay.',
      close_message: '{selfRef} sẽ hỏi lại {honorific} sau 1 tiếng. Đi khám sớm nhé.',
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  generateFromAnalysis,
  saveGeneratedScript,
};
