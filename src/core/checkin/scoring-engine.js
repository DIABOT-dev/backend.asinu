'use strict';

/**
 * Scoring Engine — Deterministic rule evaluator
 *
 * Evaluates scoring_rules + condition_modifiers from triage script JSON.
 * ZERO AI calls. Pure logic.
 *
 * Input: script.scoring_rules + user answers + user profile
 * Output: { severity, followUpHours, needsDoctor, needsFamilyAlert, matchedRule }
 */

// ─── Operator evaluators ──────────────────────────────────────────────────────

const OPERATORS = {
  eq:       (a, b) => a === b,
  neq:      (a, b) => a !== b,
  gt:       (a, b) => Number(a) > Number(b),
  gte:      (a, b) => Number(a) >= Number(b),
  lt:       (a, b) => Number(a) < Number(b),
  lte:      (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  in:       (a, b) => Array.isArray(b) && b.includes(a),
  not_in:   (a, b) => Array.isArray(b) && !b.includes(a),
};

/**
 * Evaluate a single condition against answers map.
 *
 * @param {{ field: string, op: string, value: any }} condition
 * @param {Map<string, any>} answersMap - { question_id → answer_value }
 * @returns {boolean}
 */
function evaluateCondition(condition, answersMap) {
  const { field, op, value } = condition;
  const answer = answersMap.get(field);

  // If question wasn't answered, condition fails
  if (answer === undefined || answer === null) return false;

  const evalFn = OPERATORS[op];
  if (!evalFn) {
    console.warn(`[ScoringEngine] Unknown operator: ${op}`);
    return false;
  }

  return evalFn(answer, value);
}

/**
 * Evaluate a scoring rule (array of conditions with combine logic).
 *
 * @param {{ conditions: Array, combine?: string }} rule
 * @param {Map<string, any>} answersMap
 * @returns {boolean}
 */
function evaluateRule(rule, answersMap) {
  const { conditions = [], combine = 'and' } = rule;

  if (conditions.length === 0) return false;

  if (combine === 'or') {
    return conditions.some(c => evaluateCondition(c, answersMap));
  }
  // Default: AND
  return conditions.every(c => evaluateCondition(c, answersMap));
}

/**
 * Apply condition modifiers (e.g. user has diabetes → bump severity).
 *
 * @param {string} currentSeverity
 * @param {Array} modifiers - from script.condition_modifiers
 * @param {Map<string, any>} answersMap
 * @param {string[]} userConditions - medical conditions from profile
 * @returns {{ severity: string, modifiersApplied: string[] }}
 */
function applyModifiers(currentSeverity, modifiers = [], answersMap, userConditions = []) {
  const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];
  let severity = currentSeverity;
  const modifiersApplied = [];

  for (const mod of modifiers) {
    // Check if user has the required medical condition
    const conditionMatch = !mod.user_condition ||
      userConditions.some(c => c.toLowerCase().includes(mod.user_condition.toLowerCase()));

    if (!conditionMatch) continue;

    // Check extra conditions on answers
    const extraMatch = !mod.extra_conditions ||
      mod.extra_conditions.every(c => evaluateCondition(c, answersMap));

    if (!extraMatch) continue;

    // Apply the modifier action
    if (mod.action === 'bump_severity') {
      const currentIdx = SEVERITY_ORDER.indexOf(severity);
      const targetIdx = SEVERITY_ORDER.indexOf(mod.to);
      if (targetIdx > currentIdx) {
        severity = mod.to;
        modifiersApplied.push(`${mod.user_condition || 'rule'} → ${mod.to}`);
      }
    }
  }

  return { severity, modifiersApplied };
}

// ─── Main scoring function ─────────────────────────────────────────────────

/**
 * Evaluate all scoring rules against user answers.
 * Rules are evaluated in ORDER — first match wins (highest severity first).
 *
 * @param {object} scriptData - script_data from triage_scripts table
 * @param {Array<{ question_id: string, answer: any }>} answers
 * @param {{ medical_conditions?: string[], age?: number, isElderly?: boolean }} profile
 * @returns {{
 *   severity: string,
 *   followUpHours: number,
 *   needsDoctor: boolean,
 *   needsFamilyAlert: boolean,
 *   matchedRuleIndex: number,
 *   modifiersApplied: string[],
 *   hasRedFlag: boolean,
 * }}
 */
function evaluateScript(scriptData, answers, profile = {}) {
  // Guard against explicit null/undefined
  profile = profile || {};

  // Build answers map: question_id → value
  const answersMap = new Map();
  for (const a of answers) {
    answersMap.set(a.question_id, a.answer);
  }

  const rules = scriptData.scoring_rules || [];
  const modifiers = scriptData.condition_modifiers || [];
  const userConditions = profile.medical_conditions || [];

  // Default result (if no rules match)
  let result = {
    severity: 'low',
    followUpHours: 6,
    needsDoctor: false,
    needsFamilyAlert: false,
    matchedRuleIndex: -1,
    modifiersApplied: [],
    hasRedFlag: false,
  };

  // Evaluate rules in order — first match wins
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (evaluateRule(rule, answersMap)) {
      result = {
        severity: rule.severity || 'low',
        followUpHours: rule.follow_up_hours || _defaultFollowUp(rule.severity),
        needsDoctor: rule.needs_doctor || false,
        needsFamilyAlert: rule.needs_family_alert || false,
        matchedRuleIndex: i,
        modifiersApplied: [],
        hasRedFlag: rule.severity === 'high' || rule.severity === 'critical',
      };
      break;
    }
  }

  // Apply condition modifiers (may bump severity up)
  if (modifiers.length > 0) {
    const { severity, modifiersApplied } = applyModifiers(
      result.severity, modifiers, answersMap, userConditions
    );
    if (severity !== result.severity) {
      result.severity = severity;
      result.modifiersApplied = modifiersApplied;
      result.followUpHours = _defaultFollowUp(severity);
      result.hasRedFlag = severity === 'critical';
      // needsDoctor chỉ khi CRITICAL hoặc rule gốc đã set
      // Modifier bump MEDIUM→HIGH không tự động khuyên bác sĩ
      // Chỉ khuyên khi: rule gốc set needsDoctor, hoặc severity=critical
      if (severity === 'critical') {
        result.needsDoctor = true;
        result.needsFamilyAlert = true;
      }
    }
  }

  // Elderly modifier — THẬN TRỌNG, không cảnh báo quá mức:
  //
  // Nguyên tắc:
  //   - LOW → MEDIUM: OK (theo dõi kỹ hơn, nhưng KHÔNG khuyên bác sĩ)
  //   - MEDIUM → giữ MEDIUM (theo dõi, khuyên đi khám NẾU không đỡ sau 24h)
  //   - MEDIUM → HIGH: CHỈ KHI có red flag hoặc progression=worse
  //   - needsDoctor = true: CHỈ KHI severity=HIGH VÀ có dấu hiệu rõ ràng
  //   - needsFamilyAlert = true: CHỈ KHI severity=HIGH VÀ (red flag HOẶC không phản hồi)
  //
  // TRÁNH: hơi đau đầu nhẹ → báo gia đình (gây hoảng loạn không cần thiết)
  if (profile.age >= 60 && userConditions.length > 0) {
    if (result.severity === 'low' && answers.length > 0) {
      // Elderly + conditions + triệu chứng → tối thiểu MEDIUM (theo dõi kỹ hơn)
      result.severity = 'medium';
      result.followUpHours = 3;
      result.needsDoctor = false;        // KHÔNG khuyên bác sĩ ngay cho case nhẹ
      result.needsFamilyAlert = false;   // KHÔNG báo gia đình cho case nhẹ
      result.modifiersApplied.push('elderly+conditions → medium (theo dõi kỹ)');
    }
    // MEDIUM giữ nguyên MEDIUM — không tự động bump lên HIGH
    // HIGH giữ nguyên HIGH — needsDoctor đã set bởi rule
  }

  return result;
}

/**
 * Evaluate follow-up answers (simpler scoring).
 *
 * @param {object} scriptData
 * @param {Array<{ question_id: string, answer: any }>} answers
 * @param {string} previousSeverity
 * @returns {{ severity: string, followUpHours: number, needsDoctor: boolean, needsFamilyAlert: boolean, action: string }}
 */
function evaluateFollowUp(scriptData, answers, previousSeverity = 'medium') {
  const answersMap = new Map();
  for (const a of answers) {
    answersMap.set(a.question_id, a.answer);
  }

  // Check standard follow-up patterns
  const statusAnswer = answersMap.get('fu1') || answersMap.get('followup_status');
  const newSymptomsAnswer = answersMap.get('fu2') || answersMap.get('followup_detail');

  // Determine direction
  const isBetter = _matchesBetter(statusAnswer);
  const isWorse = _matchesWorse(statusAnswer);
  const hasNewSymptoms = newSymptomsAnswer && !_matchesNo(newSymptomsAnswer);

  if (isBetter && !hasNewSymptoms) {
    return {
      severity: 'low',
      followUpHours: _defaultFollowUp('low'),
      needsDoctor: false,
      needsFamilyAlert: false,
      action: 'monitoring',  // → hẹn tối
    };
  }

  if (isWorse && hasNewSymptoms) {
    // Nặng hơn VÀ có triệu chứng mới → nghiêm trọng
    return {
      severity: 'high',
      followUpHours: 1,
      needsDoctor: true,
      needsFamilyAlert: previousSeverity === 'high', // CHỈ báo gia đình nếu lần trước đã HIGH
      action: 'escalate',
    };
  }

  if (isWorse && !hasNewSymptoms) {
    // Nặng hơn nhưng KHÔNG có triệu chứng mới → tăng severity, theo dõi sát
    // CHƯA khuyên bác sĩ ngay — hẹn follow-up sớm hơn, nếu lần sau vẫn nặng → mới escalate
    const bumpedSeverity = previousSeverity === 'low' ? 'medium' : 'high';
    return {
      severity: bumpedSeverity,
      followUpHours: bumpedSeverity === 'high' ? 1 : 2,
      needsDoctor: bumpedSeverity === 'high' && previousSeverity === 'high', // CHỈ khi đã HIGH lần trước
      needsFamilyAlert: false,
      action: bumpedSeverity === 'high' ? 'escalate' : 'continue_followup',
    };
  }

  if (!isWorse && hasNewSymptoms) {
    // Không nặng hơn nhưng có triệu chứng mới → theo dõi kỹ
    return {
      severity: previousSeverity === 'low' ? 'medium' : previousSeverity,
      followUpHours: 2,
      needsDoctor: false,
      needsFamilyAlert: false,
      action: 'continue_followup',
    };
  }

  // Same / unclear → giữ nguyên severity, tiếp tục theo dõi
  return {
    severity: previousSeverity,
    followUpHours: _defaultFollowUp(previousSeverity),
    needsDoctor: false,  // KHÔNG tự động khuyên bác sĩ cho "vẫn vậy"
    needsFamilyAlert: false,
    action: 'continue_followup',
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _defaultFollowUp(severity) {
  switch (severity) {
    case 'critical': return 0.5;
    case 'high':     return 1;
    case 'medium':   return 3;
    default:         return 6;
  }
}

function _matchesBetter(answer) {
  if (!answer) return false;
  const s = String(answer).toLowerCase();
  return s.includes('đỡ') || s.includes('better') || s.includes('tốt hơn');
}

function _matchesWorse(answer) {
  if (!answer) return false;
  const s = String(answer).toLowerCase();
  return s.includes('nặng hơn') || s.includes('worse') || s.includes('tệ hơn');
}

function _matchesNo(answer) {
  if (!answer) return true;
  const s = String(answer).toLowerCase();
  return s.includes('không') || s.includes('no') || s === 'không có';
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  evaluateScript,
  evaluateFollowUp,
  evaluateCondition,
  evaluateRule,
  applyModifiers,
};
