'use strict';

/**
 * Triage V2 — Integration layer
 *
 * Connects the three new triage modules:
 *   1. emergency-detector  — instant keyword-based emergency detection
 *   2. triage-engine       — deterministic state machine (what to ask next)
 *   3. triage-ai-layer     — natural Vietnamese text generation
 *
 * Exposes a single entry point: getNextTriageQuestion(input)
 * with the SAME return shape as the legacy function in checkin.ai.service.js.
 */

const { detectEmergency } = require('./emergency-detector');
const { getNextStep, calculateConclusion, buildState } = require('../../core/checkin/triage-engine');
const { formatQuestion, generateConclusion, generateMappingForSymptom, classifySymptomSeverity } = require('../../core/checkin/triage-ai-layer');
const { resolveComplaint } = require('./clinical-mapping');

// ─── Emergency type mapping ─────────────────────────────────────────────────
// emergency-detector returns UPPERCASE types (e.g. 'STROKE', 'MI').
// triage-ai-layer templates use lowercase keys (e.g. 'stroke', 'mi').

const EMERGENCY_TYPE_MAP = {
  STROKE: 'stroke',
  MI: 'mi',
  MENINGITIS: 'meningitis',
  PE: 'pe',
  CAUDA_EQUINA: 'cauda_equina',
  INTERNAL_HEMORRHAGE: 'hemorrhage',
  ANAPHYLAXIS: 'anaphylaxis',
  DENGUE_HEMORRHAGIC: 'dengue',
  DKA: 'dka',
  SEIZURE: 'seizure',
  TRAUMA: 'trauma',
};

// ─── Emergency result formatter ─────────────────────────────────────────────

/**
 * Build the final return object for an emergency detection.
 * Uses the fixed templates from triage-ai-layer (no GPT call).
 *
 * @param {Object} emergency - result from detectEmergency()
 * @param {Object} profile   - user profile
 * @returns {Promise<Object>} same shape as getNextTriageQuestion return value
 */
async function formatEmergencyResult(emergency, profile) {
  const templateKey = EMERGENCY_TYPE_MAP[emergency.type] || null;

  // Build a minimal state object so generateConclusion can pick the template.
  const state = {
    emergencyType: templateKey,
    severity: emergency.severity,
    needsDoctor: emergency.needsDoctor,
  };

  const aiConclusion = await generateConclusion(state, profile, 'vi');

  return {
    isDone: true,
    summary: aiConclusion.summary,
    recommendation: aiConclusion.recommendation,
    closeMessage: aiConclusion.closeMessage,
    severity: emergency.severity,
    needsDoctor: emergency.needsDoctor,
    needsFamilyAlert: emergency.needsFamilyAlert,
    hasRedFlag: true,
    followUpHours: emergency.followUpHours,
  };
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Get the next triage question or conclusion.
 *
 * @param {Object} input
 * @param {string}      input.status                - user self-reported status
 * @param {string}      input.phase                 - 'initial' | 'followup'
 * @param {string}      input.lang                  - language code (default 'vi')
 * @param {Object}      input.profile               - { birth_year, gender, full_name, age, ... }
 * @param {Object}      input.healthContext          - { medical_conditions: string[], ... }
 * @param {Array}       input.previousAnswers        - [{ step, answer }, ...]
 * @param {Object|null} input.previousSessionSummary - summary from last session
 * @returns {Promise<{
 *   isDone: boolean,
 *   question?: string,
 *   options?: string[],
 *   multiSelect?: boolean,
 *   allowFreeText?: boolean,
 *   summary?: string,
 *   severity?: string,
 *   recommendation?: string,
 *   needsDoctor?: boolean,
 *   needsFamilyAlert?: boolean,
 *   hasRedFlag?: boolean,
 *   followUpHours?: number,
 *   closeMessage?: string,
 * }>}
 */
async function getNextTriageQuestion(input) {
  const {
    status,
    phase,
    lang = 'vi',
    profile = {},
    healthContext = {},
    previousAnswers = [],
    previousSessionSummary = null,
    bodyLocation = null,            // legacy single
    bodyLocations = null,           // new array
    bodyLocationOther = null,       // free-text
  } = input;

  // ── Normalize profile: ensure age is set ──
  const normalizedProfile = { ...profile };
  if (!normalizedProfile.age && normalizedProfile.birth_year) {
    normalizedProfile.age = new Date().getFullYear() - normalizedProfile.birth_year;
  }

  // ── Normalize healthContext: ensure medical_conditions at top level ──
  const normalizedHC = { ...healthContext };
  if (!normalizedHC.medical_conditions && normalizedProfile.medical_conditions) {
    normalizedHC.medical_conditions = normalizedProfile.medical_conditions;
  }

  // ── Convert previousAnswers from {question, answer} to {step, answer} ──
  // The API sends {question, answer} but engine expects {step, answer}.
  // Infer step from answer index and question content.
  const STEP_ORDER = phase === 'followup'
    ? ['followup_status', 'followup_detail', 'conclude']
    : ['symptoms', 'associated', 'onset', 'progression', 'red_flags', 'cause', 'action', 'conclude'];

  const normalizedAnswers = previousAnswers.map((a, i) => {
    if (a.step) return a; // already has step
    // Infer step from position
    const step = STEP_ORDER[i] || 'unknown';
    return { step, answer: a.answer, question: a.question };
  });

  // 1. Extract all symptom texts from previous answers for emergency scanning.
  const allSymptomTexts = normalizedAnswers
    .map((a) => {
      if (Array.isArray(a.answer)) return a.answer.join(' ');
      return a.answer;
    })
    .filter(Boolean);

  // 2. Emergency check — pure keyword matching, instant, zero-cost.
  const emergency = detectEmergency(allSymptomTexts, normalizedProfile);
  if (emergency.isEmergency) {
    return formatEmergencyResult(emergency, normalizedProfile);
  }

  // 2b. AI safety classifier — chạy khi user VỪA khai symptom (chỉ 1 answer).
  // Backup cho các emergency NGOÀI keyword list (long tail symptoms).
  // Cost: 1 GPT call ~150 tokens, cache theo symptom.
  if (normalizedAnswers.length === 1 && normalizedAnswers[0].step === 'symptoms') {
    const symptomText = Array.isArray(normalizedAnswers[0].answer)
      ? normalizedAnswers[0].answer.join(' ')
      : String(normalizedAnswers[0].answer || '');
    if (symptomText && symptomText.length >= 2) {
      try {
        const safety = await classifySymptomSeverity(symptomText, normalizedProfile);
        if (safety.severity === 'emergency') {
          // Bypass triage, conclude ngay với severity='emergency' (giữ nguyên,
          // không downgrade về 'high' như trước — emergency là level cao nhất
          // báo người thân + gợi ý gọi 115 ngay).
          const aiConclusion = await generateConclusion(
            { primarySymptom: symptomText, severity: 'emergency', needsDoctor: true, allSymptoms: [symptomText] },
            normalizedProfile, lang,
          );
          return {
            isDone: true,
            summary: aiConclusion.summary || `Triệu chứng "${symptomText}" có dấu hiệu nguy cấp.`,
            recommendation: aiConclusion.recommendation || `🚨 Gọi 115 hoặc cấp cứu ngay. ${safety.reason}`,
            closeMessage: aiConclusion.closeMessage,
            severity: 'emergency',
            needsDoctor: true,
            needsFamilyAlert: true,
            hasRedFlag: true,
            followUpHours: 1,
            autoEmergency: true,
            _safetyClassifier: { triggered: true, severity: safety.severity, reason: safety.reason },
          };
        }
        if (safety.severity === 'urgent') {
          // Cho phép tiếp tục triage nhưng đánh dấu để conclusion sau bump severity
          input._safetyHint = { severity: 'urgent', reason: safety.reason, needsDoctor: true };
        }
      } catch (err) {
        console.error('[Triage V2] safety classifier error:', err.message);
      }
    }
  }

  // 3. Get next step from the deterministic engine.
  const engineResult = getNextStep({
    status,
    phase,
    profile: normalizedProfile,
    healthContext: normalizedHC,
    previousAnswers: normalizedAnswers,
    previousSessionSummary,
    bodyLocation,
    bodyLocations,
    bodyLocationOther,
  });

  // 4. If the engine says conclude → generate the conclusion via AI layer.
  if (engineResult.action === 'conclude') {
    const state = buildState(normalizedAnswers, normalizedProfile, normalizedHC);
    const conclusion = calculateConclusion(state, status);

    // Merge engine state + conclusion fields for the AI layer prompt.
    const conclusionInput = {
      ...state,
      ...conclusion,
      primarySymptom: state.primarySymptom || engineResult.primarySymptom,
    };

    const aiConclusion = await generateConclusion(conclusionInput, profile, lang);

    return {
      isDone: true,
      summary: aiConclusion.summary,
      recommendation: aiConclusion.recommendation,
      closeMessage: aiConclusion.closeMessage,
      severity: conclusion.severity,
      needsDoctor: conclusion.needsDoctor,
      needsFamilyAlert: conclusion.needsFamilyAlert,
      hasRedFlag: conclusion.hasRedFlag,
      followUpHours: conclusion.followUpHours,
    };
  }

  // 5. If options empty for associated/red_flags/cause → AI generates mapping
  const needsAIMapping = ['associated', 'red_flags', 'cause'].includes(engineResult.step)
    && (!engineResult.options || engineResult.options.length === 0 || (engineResult.options.length === 1 && engineResult.options[0] === 'không có'));

  if (needsAIMapping) {
    // Find the primary symptom from first answer
    const firstAnswer = normalizedAnswers[0]?.answer || '';
    const resolved = resolveComplaint(firstAnswer);
    const primarySymptom = resolved?.key || firstAnswer;
    // Set primarySymptom on engineResult so AI layer can use it in templates
    engineResult.primarySymptom = primarySymptom;

    try {
      const aiMapping = await generateMappingForSymptom(primarySymptom);
      if (aiMapping) {
        if (engineResult.step === 'associated') {
          engineResult.options = aiMapping.associatedSymptoms.map(s => s.text);
          if (!engineResult.options.includes('không có')) engineResult.options.push('không có');
        } else if (engineResult.step === 'red_flags') {
          engineResult.options = aiMapping.redFlags.slice(0, 6);
          if (!engineResult.options.includes('không có')) engineResult.options.push('không có');
        } else if (engineResult.step === 'cause') {
          engineResult.options = aiMapping.causes.slice(0, 6);
          if (!engineResult.options.includes('không rõ')) engineResult.options.push('không rõ');
        }
      }
    } catch (err) {
      console.error('[Triage V2] AI mapping failed:', err.message);
    }
  }

  // 6. Format the question via the AI layer (template, no GPT).
  const formatted = formatQuestion(
    {
      ...engineResult,
      previousSessionSummary,
      bodyLocation,
      bodyLocations,
      bodyLocationOther,
    },
    normalizedProfile,
    normalizedAnswers,
  );

  return {
    isDone: false,
    question: formatted.question,
    options: formatted.options || engineResult.options,
    optionsGrouped: engineResult.optionsGrouped || null,  // pass T2-grouped symptoms cho FE render section
    multiSelect: formatted.multiSelect,
    allowFreeText: formatted.allowFreeText,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getNextTriageQuestion,
};
