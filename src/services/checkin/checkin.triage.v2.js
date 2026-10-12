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
const { getNextStep, calculateConclusion } = require('../../core/checkin/triage-engine');
const {
  formatQuestion,
  generateConclusion,
  generateMappingForSymptom,
  classifySymptomSeverity,
} = require('../../core/checkin/triage-ai-layer');
const { t } = require('../../i18n');
const { normalizeLang } = require('../../core/checkin/triage-i18n');
const { getHonorifics } = require('../../lib/honorifics');
const {
  normalizeProfile,
  normalizeAnswers,
  conditionsOf,
} = require('../../core/checkin/triage-facts');

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
async function formatEmergencyResult(emergency, profile, lang = 'vi') {
  const templateKey = EMERGENCY_TYPE_MAP[emergency.type] || null;

  // Build a minimal state object so generateConclusion can pick the template.
  const state = {
    emergencyType: templateKey,
    severity: 'emergency',
    needsDoctor: emergency.needsDoctor,
  };

  const aiConclusion = await generateConclusion(state, profile, normalizeLang(lang));

  return {
    isDone: true,
    summary: aiConclusion.summary,
    recommendation: aiConclusion.recommendation,
    closeMessage: aiConclusion.closeMessage,
    severity: 'emergency',
    needsDoctor: emergency.needsDoctor,
    needsFamilyAlert: emergency.needsFamilyAlert,
    hasRedFlag: true,
    followUpHours: emergency.followUpHours,
    autoEmergency: true,
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
    previousTriageMessages = [],
    previousSeverity = null,
    forceConclusion = false,
    bodyLocation = null, // legacy single
    bodyLocations = null, // new array
    bodyLocationOther = null, // free-text
  } = input;

  // ── Normalize profile: ensure age is set ──
  const normalizedProfile = normalizeProfile(profile);
  const normalizedHC = {
    ...healthContext,
    medical_conditions: conditionsOf(
      healthContext.medical_conditions || normalizedProfile.medical_conditions
    ),
  };

  // New clients send an explicit step id. Question-text inference remains only
  // for older installed builds and in-progress legacy sessions.
  const STEP_ORDER =
    phase === 'followup'
      ? ['followup_status', 'followup_detail', 'conclude']
      : ['symptoms', 'onset', 'progression', 'red_flags', 'conclude'];

  const inferLegacyStep = (question, index, order = STEP_ORDER) => {
    const value = String(question || '').toLowerCase();
    if (/(lần trước|so với lần|compared to)/.test(value)) return 'followup_status';
    if (/(triệu chứng mới|thay đổi gì|new symptom)/.test(value)) return 'followup_detail';
    if (/(bắt đầu|từ khi nào|từ lúc nào|bao lâu|how long|when did)/.test(value)) return 'onset';
    if (/(đỡ hơn|nặng hơn|so với lúc đầu|thay đổi thế nào|progress)/.test(value)) {
      return 'progression';
    }
    if (/(quan trọng|dấu hiệu nghiêm trọng|dấu hiệu nào|warning sign|khẩn cấp)/.test(value)) {
      return 'red_flags';
    }
    if (/(đi kèm|triệu chứng nào khác|associated)/.test(value)) return 'associated';
    if (/(nguyên nhân|dẫn đến|cause)/.test(value)) return 'cause';
    if (/(đã làm gì|giảm triệu chứng|what have you done)/.test(value)) return 'action';
    if (/(triệu chứng|vấn đề là gì|khó chịu|symptom)/.test(value)) return 'symptoms';
    return order[index] || 'unknown';
  };

  const answersWithSteps = previousAnswers.map((a, i) => {
    if (a.step) return a;
    const step = inferLegacyStep(a.question, i);
    return { step, answer: a.answer, question: a.question };
  });
  const normalizedAnswers = normalizeAnswers(answersWithSteps);
  const baselineAnswers = normalizeAnswers(
    previousTriageMessages.map((entry, index) => ({
      ...entry,
      step:
        entry.step ||
        inferLegacyStep(entry.question, index, ['symptoms', 'onset', 'progression', 'red_flags']),
    }))
  );
  const engineResult = getNextStep({
    status,
    phase,
    profile: normalizedProfile,
    healthContext: normalizedHC,
    previousAnswers: normalizedAnswers,
    baselineAnswers,
    previousSeverity,
    forceConclusion,
    bodyLocation,
    bodyLocations,
    bodyLocationOther,
    lang,
  });

  // 1. Extract all symptom texts from previous answers for emergency scanning.
  const allSymptomTexts = answersWithSteps
    .map((a) => {
      if (Array.isArray(a.answer)) return a.answer.join(' ');
      return a.answer;
    })
    .filter(Boolean);

  // 2. Emergency check — pure keyword matching, instant, zero-cost.
  const emergency = detectEmergency(allSymptomTexts, normalizedProfile);
  if (emergency.isEmergency) {
    return formatEmergencyResult(emergency, normalizedProfile, lang);
  }

  // 2b. AI safety classifier. Re-evaluate the first symptom on each request;
  // the provider layer caches it, while the safety hint remains available when
  // the later request reaches a conclusion.
  // Backup cho các emergency NGOÀI keyword list (long tail symptoms).
  // Cost: 1 GPT call ~150 tokens, cache theo symptom.
  let safetyHint = null;
  const symptomText = engineResult.state.currentSymptoms.join(', ');
  if (symptomText) {
    if (symptomText && symptomText.length >= 2) {
      try {
        const safety = await classifySymptomSeverity(symptomText, normalizedProfile);
        if (safety.severity === 'emergency') {
          // Bypass triage, conclude ngay với severity='emergency' (giữ nguyên,
          // không downgrade về 'high' như trước — emergency là level cao nhất
          // báo người thân + gợi ý gọi 115 ngay).
          const resolvedLang = normalizeLang(lang);
          return {
            isDone: true,
            summary: t('checkin.triage.emergency.detected_summary', resolvedLang, {
              symptom: symptomText,
            }),
            recommendation: t('checkin.triage.emergency.detected_recommendation', resolvedLang),
            closeMessage: t(
              'checkin.triage.emergency.close_family',
              resolvedLang,
              getHonorifics({ ...normalizedProfile, lang: resolvedLang })
            ),
            severity: 'emergency',
            needsDoctor: true,
            needsFamilyAlert: true,
            hasRedFlag: true,
            followUpHours: 1,
            autoEmergency: true,
            _safetyClassifier: {
              triggered: true,
              severity: safety.severity,
            },
          };
        }
        safetyHint = safety;
      } catch (err) {
        console.error('[Triage V2] safety classifier error:', err.message);
      }
    }
  }

  // 4. If the engine says conclude → generate the conclusion via AI layer.
  if (engineResult.action === 'conclude') {
    const state = engineResult.state;
    const conclusion = calculateConclusion(state, status);
    const severityRank = { low: 0, medium: 1, high: 2, emergency: 3 };
    const applySeverityFloor = (severity, needsDoctor, needsFamilyAlert, followUpHours) => {
      if ((severityRank[severity] || 0) > (severityRank[conclusion.severity] || 0)) {
        conclusion.severity = severity;
      }
      conclusion.needsDoctor = conclusion.needsDoctor || needsDoctor;
      conclusion.needsFamilyAlert = conclusion.needsFamilyAlert || needsFamilyAlert;
      conclusion.followUpHours = Math.min(conclusion.followUpHours, followUpHours);
    };

    // Keep deterministic, non-emergency risk findings in the final result.
    if (emergency.severity === 'high') {
      applySeverityFloor('high', emergency.needsDoctor, emergency.needsFamilyAlert, 1);
    } else if (emergency.severity === 'medium') {
      applySeverityFloor('medium', emergency.needsDoctor, emergency.needsFamilyAlert, 3);
    }

    if (safetyHint?.severity === 'urgent') {
      const vulnerable = normalizedProfile.age >= 60 || state.hasConditions;
      applySeverityFloor(
        vulnerable ? 'high' : 'medium',
        true,
        Boolean(safetyHint.needsFamilyAlert) || vulnerable,
        vulnerable ? 1 : 3
      );
    } else if (safetyHint?.severity === 'moderate' && safetyHint.needsDoctor) {
      applySeverityFloor('medium', true, Boolean(safetyHint.needsFamilyAlert), 6);
    }

    // Merge engine state + conclusion fields for the AI layer prompt.
    const conclusionInput = {
      ...state,
      ...conclusion,
      primarySymptom: state.primarySymptom || engineResult.primarySymptom,
    };

    const aiConclusion = await generateConclusion(conclusionInput, normalizedProfile, lang);

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
      assessmentIncomplete: Boolean(state.assessmentIncomplete),
      recordedSymptoms: state.allSymptoms,
    };
  }

  // 5. If options empty for associated/red_flags/cause → AI generates mapping
  const needsAIMapping =
    ['associated', 'cause'].includes(engineResult.step) &&
    (!engineResult.options ||
      engineResult.options.length === 0 ||
      (engineResult.options.length === 1 &&
        ['không có', 'không rõ', 'none', 'unsure'].includes(
          String(engineResult.options[0]).toLowerCase()
        )));

  if (needsAIMapping) {
    // Find the primary symptom from first answer
    const primarySymptom = engineResult.state.allSymptoms.join(', ');
    // Set primarySymptom on engineResult so AI layer can use it in templates
    engineResult.primarySymptom = primarySymptom;

    try {
      const aiMapping = await generateMappingForSymptom(primarySymptom);
      if (aiMapping) {
        if (engineResult.step === 'associated') {
          engineResult.options = aiMapping.associatedSymptoms.map((s) => s.text);
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
    lang
  );

  return {
    isDone: false,
    step: engineResult.step,
    question: formatted.question,
    options: formatted.options || engineResult.options,
    optionsGrouped: engineResult.optionsGrouped || null, // pass T2-grouped symptoms cho FE render section
    multiSelect: formatted.multiSelect,
    allowFreeText: formatted.allowFreeText,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getNextTriageQuestion,
};
