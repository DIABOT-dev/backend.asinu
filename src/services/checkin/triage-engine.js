/**
 * Triage Engine — Deterministic State Machine
 * Asinu Health Companion
 *
 * Decides WHAT question to ask next based on the current check-in state.
 * NO AI/GPT calls — pure rule-based logic using clinical-mapping.js data.
 *
 * Two flows:
 *   INITIAL  — up to 8 steps: symptoms → associated → onset → progression →
 *              red_flags → cause → action → conclude
 *   FOLLOWUP — up to 3 steps: followup_status → followup_detail → conclude
 *
 * Skip-logic rules are applied deterministically to shorten the flow
 * when clinical context allows it (e.g. progression === 'better' → skip red_flags).
 */

const {
  resolveComplaint,
  getAssociatedSymptoms,
  getRedFlags,
  getCauses,
} = require('./clinical-mapping');

// ─── Step sequences ─────────────────────────────────────────────────────────

/** Maximum 8 questions for a brand-new check-in. */
const INITIAL_STEPS = [
  'symptoms',     // 1. What's your main complaint?
  'associated',   // 2. Any associated symptoms?
  'onset',        // 3. When did it start?
  'progression',  // 4. Getting better / same / worse?
  'red_flags',    // 5. Any red-flag symptoms?
  'cause',        // 6. Possible causes?
  'action',       // 7. What have you done so far?
  'conclude',     // 8. Wrap up — deterministic severity
];

/** Maximum 3 questions for a follow-up visit. */
const FOLLOWUP_STEPS = [
  'followup_status',  // 1. How are you feeling compared to last time?
  'followup_detail',  // 2. Any new or worsening symptoms?
  'conclude',         // 3. Wrap up
];

// ─── Hardcoded option sets (Vietnamese) ─────────────────────────────────────

const ONSET_OPTIONS = [
  'vừa mới',
  'vài giờ trước',
  'từ sáng',
  'từ hôm qua',
  'vài ngày nay',
];

const PROGRESSION_OPTIONS = [
  'đang đỡ dần',    // better
  'vẫn như cũ',     // same
  'có vẻ nặng hơn', // worse
];

const ACTION_OPTIONS = [
  'nghỉ ngơi',
  'uống thuốc',
  'uống nước',
  'chưa làm gì',
];

const FOLLOWUP_STATUS_OPTIONS = [
  'đỡ hơn nhiều',
  'đỡ hơn một chút',
  'vẫn như cũ',
  'có vẻ nặng hơn',
];

const FOLLOWUP_DETAIL_OPTIONS = [
  'không có triệu chứng mới',
  'có thêm triệu chứng mới',
  'triệu chứng cũ nặng hơn',
];

// ─── Progression value mapping ──────────────────────────────────────────────
// Maps the Vietnamese answer text to an internal progression key.

const PROGRESSION_MAP = {
  'đang đỡ dần': 'better',
  'vẫn như cũ': 'same',
  'có vẻ nặng hơn': 'worse',
};

// ─── State builder ──────────────────────────────────────────────────────────

/**
 * Build a triage state object from the list of previous answers, user profile,
 * and health context. This is the single source of truth for skip-logic and
 * conclusion calculations.
 *
 * @param {Array<{ step: string, answer: string|string[] }>} previousAnswers
 * @param {{ age?: number }} profile
 * @param {{ medical_conditions?: string[] }} healthContext
 * @returns {object} state
 */
function buildState(previousAnswers = [], profile = {}, healthContext = {}) {
  const completedSteps = new Set();
  let primarySymptom = null;   // resolved key from clinical-mapping
  let primaryMapping = null;   // full data object from clinical-mapping
  const allSymptoms = [];
  let onset = null;
  let progression = null;      // 'better' | 'same' | 'worse' | null
  const redFlagsFound = [];
  const causesFound = [];
  const actionsFound = [];

  // Walk through every answered step and extract structured data.
  for (const entry of previousAnswers) {
    const { step, answer } = entry;
    completedSteps.add(step);

    const answers = Array.isArray(answer) ? answer : [answer];

    switch (step) {
      case 'symptoms': {
        // First answer is the chief complaint — resolve via clinical-mapping.
        const raw = answers[0] || '';
        const resolved = resolveComplaint(raw);
        if (resolved) {
          primarySymptom = resolved.key;
          primaryMapping = resolved.data;
        }
        allSymptoms.push(...answers);
        break;
      }

      case 'associated':
        allSymptoms.push(...answers);
        // Check if any selected associated symptom is a danger-level item.
        if (primaryMapping) {
          const dangerItems = (primaryMapping.associatedSymptoms || [])
            .filter(s => s.dangerLevel === 'danger')
            .map(s => s.text.toLowerCase());
          for (const a of answers) {
            if (dangerItems.includes((a || '').toLowerCase())) {
              redFlagsFound.push(a);
            }
          }
        }
        break;

      case 'onset':
        onset = answers[0] || null;
        break;

      case 'progression':
        progression = PROGRESSION_MAP[answers[0]] || answers[0] || null;
        break;

      case 'red_flags':
        // Any selected red flag is recorded.
        for (const a of answers) {
          if (a && a.toLowerCase() !== 'không có') {
            redFlagsFound.push(a);
          }
        }
        break;

      case 'cause':
        causesFound.push(...answers.filter(Boolean));
        break;

      case 'action':
        actionsFound.push(...answers.filter(Boolean));
        break;

      case 'followup_status':
        // Map follow-up status to a pseudo-progression for conclusion logic.
        if (answers[0] === 'có vẻ nặng hơn') progression = 'worse';
        else if (answers[0] === 'vẫn như cũ') progression = 'same';
        else progression = 'better';
        break;

      case 'followup_detail':
        // If user reports new or worsening symptoms, treat like a mini red-flag.
        if (answers[0] === 'triệu chứng cũ nặng hơn') {
          progression = 'worse';
        }
        allSymptoms.push(...answers);
        break;

      default:
        break;
    }
  }

  // Derived flags from profile / healthContext
  const age = profile.age || 0;
  const isElderly = age >= 60;
  const conditions = healthContext.medical_conditions || [];
  const hasConditions = conditions.length > 0;

  return {
    completedSteps,
    primarySymptom,
    primaryMapping,
    allSymptoms,
    onset,
    progression,
    redFlagsFound,
    causesFound,
    actionsFound,
    isElderly,
    hasConditions,
    conditions,
  };
}

// ─── Skip-logic helpers ─────────────────────────────────────────────────────

/**
 * Given the current state and input status, return the ordered list of steps
 * that should actually be executed (after applying skip rules).
 *
 * @param {string[]} baseSteps - INITIAL_STEPS or FOLLOWUP_STEPS
 * @param {object}   state     - from buildState()
 * @param {string}   status    - e.g. 'very_tired', 'ok', etc.
 * @returns {string[]} filtered step list
 */
function applySkipLogic(baseSteps, state, status) {
  const steps = [...baseSteps];

  // ── Rule 1: status === 'very_tired' → skip 'cause' and 'action' ──
  if (status === 'very_tired') {
    removeStep(steps, 'cause');
    removeStep(steps, 'action');
  }

  // ── Rule 2: progression === 'worse' → force red_flags next, skip cause/action ──
  if (state.progression === 'worse') {
    removeStep(steps, 'cause');
    removeStep(steps, 'action');
    // red_flags stays (or is already present)
  }

  // ── Rule 3: progression === 'better' → can skip red_flags ──
  //    UNLESS elderly + conditions + non-low concern (Rule 4 overrides).
  if (state.progression === 'better') {
    const mustKeepRedFlags =
      state.isElderly && state.hasConditions && state.allSymptoms.length > 0;
    if (!mustKeepRedFlags) {
      removeStep(steps, 'red_flags');
    }
  }

  // ── Rule 4: elderly + conditions + any symptoms → MUST include red_flags ──
  if (state.isElderly && state.hasConditions && state.allSymptoms.length > 0) {
    if (!steps.includes('red_flags')) {
      // Re-insert red_flags before 'conclude'
      const concludeIdx = steps.indexOf('conclude');
      if (concludeIdx !== -1) {
        steps.splice(concludeIdx, 0, 'red_flags');
      } else {
        steps.push('red_flags');
      }
    }
  }

  return steps;
}

/** Utility: remove a step from an array in place. */
function removeStep(steps, name) {
  const idx = steps.indexOf(name);
  if (idx !== -1) steps.splice(idx, 1);
}

// ─── Step → question builders ───────────────────────────────────────────────

/**
 * Build the question payload for a specific step.
 *
 * @param {string} step
 * @param {object} state - from buildState()
 * @returns {{ question: string, options: string[], multiSelect: boolean, allowFreeText: boolean }}
 */
function buildQuestion(step, state) {
  const mapping = state.primaryMapping; // may be null for generic flow

  switch (step) {
    // ── INITIAL FLOW ──────────────────────────────────────────────────────

    case 'symptoms':
      return {
        question: 'Hôm nay bạn cảm thấy thế nào? Triệu chứng chính là gì?',
        options: [],  // free-text expected; the AI layer can suggest common complaints
        multiSelect: false,
        allowFreeText: true,
      };

    case 'associated': {
      // Use clinical-mapping associated symptoms if available.
      const options = mapping
        ? mapping.associatedSymptoms.map(s => s.text)
        : [];
      // Always add a "none" escape hatch.
      if (options.length && !options.includes('không có')) {
        options.push('không có');
      }
      return {
        question: mapping
          ? 'Bạn có thêm triệu chứng nào đi kèm?'
          : 'Bạn có triệu chứng nào khác không?',
        options,
        multiSelect: true,
        allowFreeText: true,
      };
    }

    case 'onset':
      return {
        question: 'Triệu chứng này bắt đầu từ khi nào?',
        options: ONSET_OPTIONS,
        multiSelect: false,
        allowFreeText: true,
      };

    case 'progression':
      return {
        question: 'So với lúc đầu, triệu chứng hiện tại thế nào?',
        options: PROGRESSION_OPTIONS,
        multiSelect: false,
        allowFreeText: false,
      };

    case 'red_flags': {
      const flags = mapping ? mapping.redFlags : [];
      // Show at most 6 most critical flags to avoid overwhelming the user.
      const displayFlags = flags.slice(0, 6);
      if (displayFlags.length && !displayFlags.includes('không có')) {
        displayFlags.push('không có');
      }
      return {
        question: 'Bạn có gặp tình trạng nào sau đây không? (Quan trọng)',
        options: displayFlags.length ? displayFlags : ['không có'],
        multiSelect: true,
        allowFreeText: false,
      };
    }

    case 'cause': {
      const causes = mapping ? mapping.causes : [];
      const displayCauses = causes.slice(0, 6);
      if (displayCauses.length && !displayCauses.includes('không rõ')) {
        displayCauses.push('không rõ');
      }
      return {
        question: 'Bạn nghĩ nguyên nhân có thể là gì?',
        options: displayCauses.length ? displayCauses : ['không rõ'],
        multiSelect: true,
        allowFreeText: true,
      };
    }

    case 'action':
      return {
        question: 'Bạn đã làm gì để giảm triệu chứng chưa?',
        options: ACTION_OPTIONS,
        multiSelect: true,
        allowFreeText: true,
      };

    // ── FOLLOW-UP FLOW ────────────────────────────────────────────────────

    case 'followup_status':
      return {
        question: 'So với lần trước, bạn cảm thấy thế nào?',
        options: FOLLOWUP_STATUS_OPTIONS,
        multiSelect: false,
        allowFreeText: false,
      };

    case 'followup_detail':
      return {
        question: 'Bạn có triệu chứng mới hoặc thay đổi gì không?',
        options: FOLLOWUP_DETAIL_OPTIONS,
        multiSelect: false,
        allowFreeText: true,
      };

    default:
      return {
        question: '',
        options: [],
        multiSelect: false,
        allowFreeText: false,
      };
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Determine the next step in the triage flow.
 *
 * @param {object} input
 * @param {string}        input.status              - user's self-reported status (e.g. 'very_tired')
 * @param {string}        input.phase               - 'initial' | 'followup'
 * @param {object}        input.profile             - { age, ... }
 * @param {object}        input.healthContext        - { medical_conditions: string[], ... }
 * @param {Array}         input.previousAnswers      - [{ step, answer }, ...]
 * @param {object|null}   input.previousSessionSummary - summary from last session (for follow-ups)
 * @returns {{ action: string, step?: string, question?: string, options?: string[],
 *             multiSelect?: boolean, allowFreeText?: boolean, primarySymptom?: string,
 *             conclusion?: object }}
 */
function getNextStep(input) {
  const {
    status,
    phase,
    profile = {},
    healthContext = {},
    previousAnswers = [],
    previousSessionSummary = null,
  } = input;

  // 1. Rebuild current state from all previous answers.
  const state = buildState(previousAnswers, profile, healthContext);

  // 2. Pick the right step sequence and apply skip-logic.
  const isFollowUp = phase === 'followup';
  const baseSteps = isFollowUp ? [...FOLLOWUP_STEPS] : [...INITIAL_STEPS];
  const steps = applySkipLogic(baseSteps, state, status);

  // 3. Find the first step that hasn't been completed yet.
  const nextStep = steps.find(s => !state.completedSteps.has(s));

  // 4. If no step remains or we've reached 'conclude', wrap up.
  if (!nextStep || nextStep === 'conclude') {
    const conclusion = calculateConclusion(state, status);
    return {
      action: 'conclude',
      primarySymptom: state.primarySymptom || null,
      conclusion,
    };
  }

  // 5. Build the question for this step.
  const questionData = buildQuestion(nextStep, state);

  return {
    action: 'ask',
    step: nextStep,
    question: questionData.question,
    options: questionData.options,
    multiSelect: questionData.multiSelect,
    allowFreeText: questionData.allowFreeText,
    primarySymptom: state.primarySymptom || null,
  };
}

// ─── Conclusion calculator ──────────────────────────────────────────────────

/**
 * Calculate the deterministic triage conclusion based on accumulated state.
 *
 * Severity ladder:
 *   low    → routine, no urgent action
 *   medium → monitor closely, may need medical attention
 *   high   → seek medical help promptly
 *
 * @param {object} state  - from buildState()
 * @param {string} status - user's self-reported status
 * @returns {{ severity: string, needsDoctor: boolean, needsFamilyAlert: boolean,
 *             hasRedFlag: boolean, followUpHours: number }}
 */
function calculateConclusion(state, status) {
  let severity = 'low';
  let needsDoctor = false;
  let needsFamilyAlert = false;
  const hasRedFlag = state.redFlagsFound.length > 0;
  let followUpHours = 6;

  // ── Severity rules (evaluated in order of priority) ───────────────────

  if (hasRedFlag) {
    // Any red flag immediately escalates to high.
    severity = 'high';
  } else if (state.progression === 'worse') {
    // Worsening + vulnerable population = high; otherwise medium.
    severity = (state.isElderly || state.hasConditions) ? 'high' : 'medium';
  } else if (state.progression === 'same' && (state.isElderly || state.hasConditions)) {
    // Stagnant symptoms in vulnerable population = medium.
    severity = 'medium';
  }

  // 'very_tired' status bumps low → medium (does not downgrade).
  if (status === 'very_tired' && severity === 'low') {
    severity = 'medium';
  }

  // ── needsDoctor ───────────────────────────────────────────────────────

  if (severity === 'high') {
    needsDoctor = true;
  }
  if (state.isElderly && state.hasConditions && severity !== 'low') {
    needsDoctor = true;
  }
  if (hasRedFlag) {
    needsDoctor = true;
  }
  // Worsening symptoms → always needsDoctor
  if (state.progression === 'worse') {
    needsDoctor = true;
  }

  // ── followUpHours ─────────────────────────────────────────────────────

  if (severity === 'high') {
    followUpHours = 1;
  } else if (severity === 'medium') {
    followUpHours = 3;
  } else {
    followUpHours = state.isElderly ? 4 : 6;
  }

  // ── needsFamilyAlert ──────────────────────────────────────────────────

  if (severity === 'high' && (state.isElderly || state.hasConditions)) {
    needsFamilyAlert = true;
  }
  if (hasRedFlag) {
    needsFamilyAlert = true;
  }

  return {
    severity,
    needsDoctor,
    needsFamilyAlert,
    hasRedFlag,
    followUpHours,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getNextStep,
  calculateConclusion,
  buildState,

  // Exposed for testing / downstream introspection
  INITIAL_STEPS,
  FOLLOWUP_STEPS,
  ONSET_OPTIONS,
  PROGRESSION_OPTIONS,
  ACTION_OPTIONS,
};
