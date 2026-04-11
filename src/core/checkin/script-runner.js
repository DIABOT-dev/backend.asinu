'use strict';

/**
 * Script Runner — Deterministic Script Execution Engine
 *
 * Reads cached script JSON → returns next question → NO AI calls.
 * App chỉ đọc JSON và hiển thị UI.
 *
 * Flow:
 *   1. App calls GET /checkin/script → receives full script JSON
 *   2. User answers → App calls POST /checkin/script/answer
 *   3. Script Runner determines next question or conclusion
 *   4. When done → Scoring Engine evaluates → result returned
 */

const { evaluateScript, evaluateFollowUp } = require('./scoring-engine');
const { getHonorifics } = require('../../lib/honorifics');
const { applyIllusion } = require('./illusion-layer');

// ─── Get next question from script ─────────────────────────────────────────

/**
 * Given a script and current answers, return the next question or conclusion.
 *
 * @param {object} scriptData - script_data JSON from triage_scripts table
 * @param {Array<{ question_id: string, answer: any, answered_at?: string }>} answers - answers so far
 * @param {object} options
 * @param {string} options.sessionType - 'initial' | 'followup'
 * @param {object} options.profile - user profile for honorifics
 * @param {string} options.previousSeverity - severity from initial session (for follow-up)
 * @returns {{
 *   isDone: boolean,
 *   question?: object,
 *   conclusion?: object,
 *   currentStep: number,
 *   totalSteps: number,
 * }}
 */
function getNextQuestion(scriptData, answers = [], options = {}) {
  // Guard against null/undefined scriptData
  if (!scriptData || typeof scriptData !== 'object') {
    return { isDone: true, conclusion: null, currentStep: 0, totalSteps: 0 };
  }

  const { sessionType = 'initial', profile = {}, previousSeverity = null } = options;

  const questions = sessionType === 'followup'
    ? (scriptData.followup_questions || [])
    : (scriptData.questions || []);

  const currentStep = answers.length;
  const totalSteps = questions.length;

  // Check if all questions answered
  if (currentStep >= totalSteps) {
    // All done → evaluate scoring
    const conclusion = sessionType === 'followup'
      ? _buildFollowUpConclusion(scriptData, answers, previousSeverity, profile)
      : _buildInitialConclusion(scriptData, answers, profile);

    return {
      isDone: true,
      conclusion,
      currentStep,
      totalSteps,
    };
  }

  // Get next question
  const nextQ = questions[currentStep];

  // Guard against null/undefined question in array
  if (!nextQ || typeof nextQ !== 'object') {
    const paddedAnswers = [...answers, { question_id: `skip_${currentStep}`, answer: null, skipped: true }];
    return getNextQuestion(scriptData, paddedAnswers, options);
  }

  // Check skip_if condition
  if (nextQ.skip_if && _shouldSkip(nextQ.skip_if, answers)) {
    // Skip this question, try next
    const paddedAnswers = [...answers, { question_id: nextQ.id, answer: null, skipped: true }];
    return getNextQuestion(scriptData, paddedAnswers, options);
  }

  // Personalize question text with honorifics
  const personalizedText = _personalizeText(nextQ.text, profile);

  return {
    isDone: false,
    question: {
      id: nextQ.id,
      text: personalizedText,
      type: nextQ.type,         // 'slider' | 'single_choice' | 'multi_choice' | 'free_text'
      options: nextQ.options || null,
      min: nextQ.min,
      max: nextQ.max,
      cluster: nextQ.cluster || null,
    },
    currentStep,
    totalSteps,
  };
}

// ─── Build conclusions ─────────────────────────────────────────────────────

function _buildInitialConclusion(scriptData, answers, profile) {
  const scoring = evaluateScript(scriptData, answers, profile);
  const templates = scriptData.conclusion_templates || {};
  const template = templates[scoring.severity] || templates.low || {};

  return {
    severity: scoring.severity,
    followUpHours: scoring.followUpHours,
    needsDoctor: scoring.needsDoctor,
    needsFamilyAlert: scoring.needsFamilyAlert,
    hasRedFlag: scoring.hasRedFlag,
    matchedRuleIndex: scoring.matchedRuleIndex,
    modifiersApplied: scoring.modifiersApplied,
    summary: _personalizeText(template.summary || '', profile),
    recommendation: _personalizeText(template.recommendation || '', profile),
    closeMessage: _personalizeText(template.close_message || '', profile),
  };
}

function _buildFollowUpConclusion(scriptData, answers, previousSeverity, profile) {
  const scoring = evaluateFollowUp(scriptData, answers, previousSeverity);
  const templates = scriptData.conclusion_templates || {};
  const template = templates[scoring.severity] || templates.low || {};

  return {
    severity: scoring.severity,
    followUpHours: scoring.followUpHours,
    needsDoctor: scoring.needsDoctor,
    needsFamilyAlert: scoring.needsFamilyAlert,
    hasRedFlag: scoring.severity === 'high' || scoring.severity === 'critical',
    action: scoring.action,
    summary: _personalizeText(template.summary || '', profile),
    recommendation: _personalizeText(template.recommendation || '', profile),
    closeMessage: _personalizeText(template.close_message || '', profile),
  };
}

// ─── Skip logic ────────────────────────────────────────────────────────────

/**
 * Check if a question should be skipped based on previous answers.
 *
 * skip_if format:
 *   { "field": "q1", "op": "lt", "value": 4 }  — skip if q1 < 4
 *   { "any": [ {field, op, value}, ... ] }       — skip if ANY condition true
 *   { "all": [ {field, op, value}, ... ] }       — skip if ALL conditions true
 */
function _shouldSkip(skipIf, answers) {
  const answersMap = new Map();
  for (const a of answers) {
    if (a.question_id && a.answer !== null && a.answer !== undefined) {
      answersMap.set(a.question_id, a.answer);
    }
  }

  if (skipIf.any) {
    return skipIf.any.some(c => _evalSkipCondition(c, answersMap));
  }
  if (skipIf.all) {
    return skipIf.all.every(c => _evalSkipCondition(c, answersMap));
  }
  return _evalSkipCondition(skipIf, answersMap);
}

function _evalSkipCondition(condition, answersMap) {
  const { field, op, value } = condition;
  const answer = answersMap.get(field);
  if (answer === undefined || answer === null) return false;

  switch (op) {
    case 'eq':  return answer === value;
    case 'neq': return answer !== value;
    case 'gt':  return Number(answer) > Number(value);
    case 'gte': return Number(answer) >= Number(value);
    case 'lt':  return Number(answer) < Number(value);
    case 'lte': return Number(answer) <= Number(value);
    case 'contains': return String(answer).toLowerCase().includes(String(value).toLowerCase());
    default: return false;
  }
}

// ─── Text personalization ──────────────────────────────────────────────────

/**
 * Replace {honorific}, {selfRef}, {Honorific}, {callName} placeholders.
 */
function _personalizeText(text, profile) {
  if (!text) return '';

  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang: 'vi',
  });

  return text
    .replace(/\{honorific\}/g, h.honorific)
    .replace(/\{selfRef\}/g, h.selfRef)
    .replace(/\{Honorific\}/g, h.Honorific)
    .replace(/\{callName\}/g, h.callName)
    .replace(/\{CallName\}/g, h.callName.charAt(0).toUpperCase() + h.callName.slice(1));
}

// ─── Validate script structure ─────────────────────────────────────────────

/**
 * Validate that a script_data object has the required structure.
 * Used when saving AI-generated scripts.
 */
function validateScript(scriptData) {
  const errors = [];

  if (!scriptData.questions || !Array.isArray(scriptData.questions)) {
    errors.push('missing or invalid "questions" array');
  } else {
    for (let i = 0; i < scriptData.questions.length; i++) {
      const q = scriptData.questions[i];
      if (!q.id) errors.push(`questions[${i}]: missing "id"`);
      if (!q.text) errors.push(`questions[${i}]: missing "text"`);
      if (!q.type) errors.push(`questions[${i}]: missing "type"`);
      if (q.type === 'single_choice' || q.type === 'multi_choice') {
        if (!q.options || !Array.isArray(q.options) || q.options.length === 0) {
          errors.push(`questions[${i}]: choice type but missing "options"`);
        }
      }
      if (q.type === 'slider') {
        if (q.min === undefined || q.max === undefined) {
          errors.push(`questions[${i}]: slider type but missing "min"/"max"`);
        }
      }
    }
  }

  if (!scriptData.scoring_rules || !Array.isArray(scriptData.scoring_rules)) {
    errors.push('missing or invalid "scoring_rules" array');
  }

  if (!scriptData.conclusion_templates || typeof scriptData.conclusion_templates !== 'object') {
    errors.push('missing or invalid "conclusion_templates"');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Exports ────────────────────────────────────────────────────────────────

// ─── Illusion-enhanced question getter ────────────────────────────────────

/**
 * Get next question WITH illusion layer applied.
 * Falls back to plain getNextQuestion if illusion fails.
 *
 * @param {object} scriptData
 * @param {Array} answers
 * @param {object} options - same as getNextQuestion + { illusionContext, user }
 * @returns {object} Enhanced output
 */
function getNextQuestionWithIllusion(scriptData, answers, options = {}) {
  const { illusionContext, user, lastAnswer, ...baseOptions } = options;

  // Get base result
  const result = getNextQuestion(scriptData, answers, baseOptions);

  // Apply illusion if context + user provided
  if (illusionContext && user) {
    try {
      return applyIllusion(result, scriptData, illusionContext, user, { lastAnswer });
    } catch (err) {
      console.warn('[IllusionLayer] Failed, using original:', err.message);
      result._illusion = { applied: false, reason: 'error', error: err.message };
      return result;
    }
  }

  return result;
}

module.exports = {
  getNextQuestion,
  getNextQuestionWithIllusion,
  validateScript,
};
