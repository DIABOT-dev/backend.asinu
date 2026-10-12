/**
 * Triage Engine — Deterministic State Machine
 * Asinu Health Companion
 *
 * Decides WHAT question to ask next based on the current check-in state.
 * NO AI/GPT calls — pure rule-based logic using clinical-mapping.js data.
 *
 * Two flows:
 *   INITIAL  — symptoms → onset → progression →
 *              red_flags → conclude
 *   FOLLOWUP — followup_status → followup_detail → safety checks if needed → conclude
 *
 * Skip-logic rules are applied deterministically to shorten the flow
 * when clinical context allows it (e.g. progression === 'better' → skip red_flags).
 */

const {
  textOf,
  isUnknown,
  isNone,
  affirmativeParts,
  progressionOf,
  onsetOf,
  complaintsOf,
  conditionsOf,
  normalizeProfile,
} = require('./triage-facts');
const { t } = require('../../i18n');
const { localizeOptions, normalizeLang } = require('./triage-i18n');

// Common chief complaints để hiển thị options ở step `symptoms`.
// Lấy từ KB clinical-mapping (14 triệu chứng chính).
const COMMON_SYMPTOMS_ORDERED = [
  'mệt mỏi',
  'đau đầu',
  'đau bụng',
  'sốt',
  'ho',
  'khó thở',
  'đau ngực',
  'chóng mặt',
  'buồn nôn',
  'mất ngủ',
  'đau họng',
  'tiêu chảy',
  'đau vai',
  'tê tay chân',
];
const _SYMPTOMS_OTHER = 'khác (mô tả thêm)';

// Map bệnh nền → triệu chứng thường gặp (đẩy lên đầu danh sách options
// ở step `symptoms` để user dễ chọn). Key chứa keyword normalize lowercase.
const CONDITION_TO_PRIORITY_SYMPTOMS = {
  'tiểu đường': ['chóng mặt', 'mệt mỏi', 'buồn nôn', 'tê tay chân', 'khó thở'],
  'đái tháo đường': ['chóng mặt', 'mệt mỏi', 'buồn nôn', 'tê tay chân', 'khó thở'],
  'cao huyết áp': ['đau đầu', 'chóng mặt', 'đau ngực', 'khó thở'],
  'huyết áp': ['đau đầu', 'chóng mặt', 'đau ngực', 'khó thở'],
  'tim mạch': ['đau ngực', 'khó thở', 'mệt mỏi', 'chóng mặt'],
  tim: ['đau ngực', 'khó thở', 'mệt mỏi', 'chóng mặt'],
  'hen suyễn': ['khó thở', 'ho', 'đau ngực'],
  hen: ['khó thở', 'ho', 'đau ngực'],
  copd: ['khó thở', 'ho', 'mệt mỏi'],
  phổi: ['khó thở', 'ho', 'đau ngực'],
  'thoái hoá khớp': ['đau vai', 'tê tay chân'],
  'thoái hóa khớp': ['đau vai', 'tê tay chân'],
  khớp: ['đau vai', 'tê tay chân'],
  'mất ngủ': ['mất ngủ', 'mệt mỏi', 'đau đầu'],
  'rối loạn lo âu': ['mất ngủ', 'mệt mỏi', 'đau đầu', 'đau ngực'],
  'trầm cảm': ['mất ngủ', 'mệt mỏi', 'đau đầu'],
  'dạ dày': ['đau bụng', 'buồn nôn', 'tiêu chảy'],
  'tiêu hoá': ['đau bụng', 'buồn nôn', 'tiêu chảy'],
  gan: ['đau bụng', 'buồn nôn', 'mệt mỏi'],
  thận: ['đau bụng', 'mệt mỏi', 'buồn nôn'],
};

/**
 * Sắp xếp lại COMMON_SYMPTOMS_ORDERED, đẩy các triệu chứng liên quan đến
 * bệnh nền của user lên đầu (giữ order tương đối).
 *
 * KHÔNG append "khác (mô tả thêm)" vì step `symptoms` có allowFreeText=true
 * → FE đã render sẵn ô input + mic ở dưới. User gõ thẳng vào input nếu
 * triệu chứng không có trong list (tránh trùng UX, tránh AI nhận chuỗi
 * "khác (mô tả thêm)" làm primarySymptom).
 *
 * @param {string[]} conditions - medical_conditions của user
 * @returns {string[]} options đã sort
 */
/**
 * Build symptom options for T3 step — phối hợp T2 bodyLocations + condition priority.
 *
 * Strategy:
 *   1. Nếu có bodyLocations (T2 đã pick): options = symptoms theo các vùng đó
 *      (merge + dedupe). Ưu tiên thứ tự: location[0] symptoms trước, rồi [1]...
 *      Sau đó: condition-priority symptoms (vd: tiểu đường → "khát nước, đi
 *      tiểu nhiều") đẩy lên đầu trong từng cluster.
 *   2. Nếu KHÔNG có bodyLocations (FE cũ chưa update / fallback):
 *      → dùng buildPrioritizedSymptomOptions(conditions) như cũ.
 *
 * @param {string[]|null} bodyLocations - T2 location keys
 * @param {string[]} conditions - medical_conditions của user
 * @returns {string[]} options cho T3
 */
function buildSymptomOptions(bodyLocations, conditions, lang = 'vi') {
  const resolvedLang = normalizeLang(lang);
  if (!Array.isArray(bodyLocations) || bodyLocations.length === 0) {
    return localizeOptions(buildPrioritizedSymptomOptions(conditions), resolvedLang);
  }
  const { getSymptomsForLocations } = require('../../services/checkin/body-location');
  const merged = getSymptomsForLocations(bodyLocations, resolvedLang);
  if (merged.length === 0) {
    return localizeOptions(buildPrioritizedSymptomOptions(conditions), resolvedLang);
  }
  // Optional condition priority boost — nếu user có bệnh nền liên quan,
  // đẩy symptom đó lên đầu trong list merged (nếu match).
  if (Array.isArray(conditions) && conditions.length > 0) {
    const priority = new Set();
    for (const cond of conditions) {
      const normalized = String(cond).toLowerCase().trim();
      for (const [key, symptoms] of Object.entries(CONDITION_TO_PRIORITY_SYMPTOMS)) {
        if (normalized.includes(key)) symptoms.forEach((s) => priority.add(s.toLowerCase()));
      }
    }
    if (priority.size > 0) {
      const prioritized = merged.filter((s) => priority.has(s.toLowerCase()));
      const rest = merged.filter((s) => !priority.has(s.toLowerCase()));
      return [...prioritized, ...rest];
    }
  }
  return merged;
}

function buildPrioritizedSymptomOptions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return [...COMMON_SYMPTOMS_ORDERED];
  }

  const priority = new Set();
  for (const cond of conditions) {
    const normalized = String(cond).toLowerCase().trim();
    for (const [key, symptoms] of Object.entries(CONDITION_TO_PRIORITY_SYMPTOMS)) {
      if (normalized.includes(key)) {
        symptoms.forEach((s) => priority.add(s));
      }
    }
  }

  if (priority.size === 0) {
    return [...COMMON_SYMPTOMS_ORDERED];
  }

  // Đầu: các triệu chứng ưu tiên (giữ order theo COMMON_SYMPTOMS_ORDERED)
  const prioritized = COMMON_SYMPTOMS_ORDERED.filter((s) => priority.has(s));
  // Sau: các triệu chứng còn lại (giữ order)
  const rest = COMMON_SYMPTOMS_ORDERED.filter((s) => !priority.has(s));
  return [...prioritized, ...rest];
}

// ─── Step sequences ─────────────────────────────────────────────────────────

/** Adaptive 2-4 question flow for a brand-new check-in. */
const INITIAL_STEPS = ['symptoms', 'onset', 'progression', 'red_flags', 'conclude'];

/** Follow-up baseline; new complaints and unresolved risk need additional checks. */
const FOLLOWUP_STEPS = [
  'followup_status', // 1. How are you feeling compared to last time?
  'followup_detail', // 2. Any new or worsening symptoms?
  'conclude', // 3. Wrap up
];

// ─── Hardcoded option sets (Vietnamese) ─────────────────────────────────────

const ONSET_OPTIONS = ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay'];

const PROGRESSION_OPTIONS = [
  'đang đỡ dần', // better
  'vẫn như cũ', // same
  'có vẻ nặng hơn', // worse
];

const ACTION_OPTIONS = ['nghỉ ngơi', 'uống thuốc', 'uống nước', 'chưa làm gì'];

const FOLLOWUP_STATUS_OPTIONS = ['đỡ hơn nhiều', 'đỡ hơn một chút', 'vẫn như cũ', 'có vẻ nặng hơn'];

const FOLLOWUP_DETAIL_OPTIONS = [
  'không có triệu chứng mới',
  'có thêm triệu chứng mới',
  'triệu chứng cũ nặng hơn',
];

// ─── Progression value mapping ──────────────────────────────────────────────
// Maps the Vietnamese answer text to an internal progression key.

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
function buildState(previousAnswers = [], profile = {}, healthContext = {}, context = {}) {
  const completedSteps = new Set();
  const unknownSteps = new Set();
  const attempts = {};
  const complaints = [];
  const currentSymptoms = [];
  const redFlagsFound = [];
  const causesFound = [];
  const actionsFound = [];
  let onset = null;
  let progression = null;
  let newSymptoms = false;
  let newSymptomPending = false;

  const addComplaints = (value, current = false) => {
    const found = complaintsOf(value);
    for (const complaint of found) {
      if (!complaints.some((item) => item.text.toLowerCase() === complaint.text.toLowerCase()))
        complaints.push(complaint);
      if (current && !currentSymptoms.includes(complaint.text))
        currentSymptoms.push(complaint.text);
    }
    return found.length > 0;
  };

  // Historical symptoms are context, never evidence of improvement today.
  for (const entry of context.baselineAnswers || []) {
    if (['symptoms', 'associated', 'followup_detail'].includes(entry.step))
      addComplaints(entry.answer);
    if (entry.step === 'onset' && !isUnknown(entry.answer)) onset = textOf(entry.answer);
    onset ||= onsetOf(entry.answer);
  }

  const baselineSymptoms = complaints.map((item) => item.text);

  for (const { step, answer } of previousAnswers) {
    attempts[step] = (attempts[step] || 0) + 1;
    const text = textOf(answer);
    let known = Boolean(text) && !isUnknown(answer);
    switch (step) {
      case 'symptoms':
      case 'associated': {
        known = addComplaints(answer, true);
        const embeddedOnset = onsetOf(answer);
        if (embeddedOnset) {
          onset = embeddedOnset;
          completedSteps.add('onset');
        }
        const embeddedProgression = progressionOf(answer);
        if (embeddedProgression) {
          progression = embeddedProgression;
          completedSteps.add('progression');
        }
        break;
      }
      case 'onset':
        if (known) onset = text;
        break;
      case 'progression':
      case 'followup_status':
        progression = progressionOf(answer);
        known = Boolean(progression);
        break;
      case 'red_flags':
        redFlagsFound.push(...affirmativeParts(answer));
        if ((Array.isArray(answer) ? answer : text.split(/[,;]+/)).some(isUnknown)) known = false;
        break;
      case 'cause':
        if (known && !isNone(answer)) causesFound.push(...affirmativeParts(answer));
        break;
      case 'action':
        if (known) actionsFound.push(text);
        break;
      case 'followup_detail':
        if (/^(?:có thêm triệu chứng mới|new symptoms)$/i.test(text)) {
          newSymptoms = true;
          newSymptomPending = true;
          onset = null;
          progression = null;
          completedSteps.delete('onset');
          completedSteps.delete('progression');
        } else if (/^(?:triệu chứng cũ nặng hơn|existing symptoms are worse)$/i.test(text)) {
          progression = 'worse';
        } else if (!isNone(answer) && known) {
          const found = addComplaints(answer, true);
          if (found) {
            if (!newSymptoms) {
              onset = null;
              progression = null;
            }
            newSymptoms = true;
            newSymptomPending = false;
            const embeddedOnset = onsetOf(answer);
            if (embeddedOnset) {
              onset = embeddedOnset;
              completedSteps.add('onset');
            }
            const embeddedProgression = progressionOf(answer);
            if (embeddedProgression) {
              progression = embeddedProgression;
              completedSteps.add('progression');
            }
          }
          known = found;
        }
        break;
      default:
        break;
    }
    if (known) {
      completedSteps.add(step);
      unknownSteps.delete(step);
    } else {
      completedSteps.delete(step);
      unknownSteps.add(step);
    }
  }

  const normalizedProfile = normalizeProfile(profile);
  const conditions = conditionsOf(
    healthContext.medical_conditions || normalizedProfile.medical_conditions
  );
  return {
    completedSteps,
    unknownSteps,
    attempts,
    complaints,
    currentSymptoms,
    baselineSymptoms,
    primarySymptom: complaints[0]?.key || complaints[0]?.text || null,
    primaryMapping: complaints.find((item) => item.mapping)?.mapping || null,
    mappings: [...new Set(complaints.map((item) => item.mapping).filter(Boolean))],
    allSymptoms: complaints.map((item) => item.text),
    onset,
    progression,
    redFlagsFound: [...new Set(redFlagsFound)],
    causesFound,
    actionsFound,
    newSymptoms,
    newSymptomPending,
    isElderly: normalizedProfile.age >= 60,
    hasConditions: conditions.length > 0,
    conditions,
    previousSeverity: context.previousSeverity || null,
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
    const mustKeepRedFlags = state.isElderly && state.hasConditions && state.allSymptoms.length > 0;
    if (!mustKeepRedFlags) {
      removeStep(steps, 'red_flags');
    }
  }

  if (
    ['high', 'emergency'].includes(state.previousSeverity) &&
    state.allSymptoms.length &&
    !steps.includes('red_flags')
  ) {
    steps.splice(steps.indexOf('conclude'), 0, 'red_flags');
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
function buildQuestion(step, state, lang = 'vi') {
  const resolvedLang = normalizeLang(lang);
  const mapping = state.primaryMapping; // may be null for generic flow

  switch (step) {
    // ── INITIAL FLOW ──────────────────────────────────────────────────────

    case 'symptoms': {
      // T3 Chief Complaint — options PHẢI logic với T2 location đã pick.
      // Ưu tiên: symptoms từ bodyLocations (T2) → fallback condition priority
      // → fallback COMMON_SYMPTOMS_ORDERED. allowFreeText=true để user gõ
      // triệu chứng ngoài list.
      const flatOptions = buildSymptomOptions(state.bodyLocations, state.conditions, resolvedLang);
      // optionsGrouped — chỉ emit khi có bodyLocations để FE render section
      // header theo vùng (tránh user phải tự đoán symptom thuộc vùng nào).
      let optionsGrouped = null;
      if (Array.isArray(state.bodyLocations) && state.bodyLocations.length > 0) {
        const { getGroupedSymptoms } = require('../../services/checkin/body-location');
        optionsGrouped = getGroupedSymptoms(state.bodyLocations, resolvedLang);
      }
      return {
        question: 'Cụ thể vấn đề là gì? (chọn 1 hoặc nhiều)',
        options: flatOptions,
        optionsGrouped, // null nếu không có T2 — FE fallback render flat
        multiSelect: true,
        allowFreeText: true,
      };
    }

    case 'associated': {
      // Use clinical-mapping associated symptoms if available.
      const options =
        resolvedLang === 'en'
          ? ['Nausea', 'Fever', 'Dizziness', 'Weakness']
          : mapping
            ? mapping.associatedSymptoms.map((s) => s.text)
            : [];
      // Always add a "none" escape hatch.
      const none = t('checkin.triage.option.none', resolvedLang);
      if (options.length && !options.includes(none)) {
        options.push(none);
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
        options: localizeOptions(ONSET_OPTIONS, resolvedLang),
        multiSelect: false,
        allowFreeText: true,
      };

    case 'progression':
      return {
        question: 'So với lúc đầu, triệu chứng hiện tại thế nào?',
        options: localizeOptions(PROGRESSION_OPTIONS, resolvedLang),
        multiSelect: false,
        allowFreeText: false,
      };

    case 'red_flags': {
      const mappings = state.mappings || (mapping ? [mapping] : []);
      const flags = [];
      // Round-robin keeps each reported complaint represented in the six choices.
      for (let index = 0; index < 6 && flags.length < 6; index++) {
        for (const item of mappings) {
          const flag = item.redFlags?.[index];
          if (flag && !flags.includes(flag)) flags.push(flag);
          if (flags.length === 6) break;
        }
      }
      const generic = ['severe_shortness_of_breath', 'chest_pain_sweating', 'faint_or_drowsy'];
      const displayFlags =
        resolvedLang === 'vi' && flags.length
          ? flags
          : generic.map((key) => t(`checkin.triage.option.${key}`, resolvedLang));
      return {
        question: 'Có dấu hiệu nào cần chú ý không?',
        options: [
          ...displayFlags,
          t('checkin.triage.option.none', resolvedLang),
          t('checkin.triage.option.unknown', resolvedLang),
        ],
        multiSelect: true,
        allowFreeText: true,
      };
    }

    case 'cause': {
      const causes = resolvedLang === 'en' ? [] : mapping ? mapping.causes : [];
      const displayCauses = causes.slice(0, 6);
      const unknown = t('checkin.triage.option.unknown', resolvedLang);
      if (displayCauses.length && !displayCauses.includes(unknown)) {
        displayCauses.push(unknown);
      }
      return {
        question: 'Bạn nghĩ nguyên nhân có thể là gì?',
        options: displayCauses.length ? displayCauses : [unknown],
        multiSelect: true,
        allowFreeText: true,
      };
    }

    case 'action':
      return {
        question: 'Bạn đã làm gì để giảm triệu chứng chưa?',
        options: localizeOptions(ACTION_OPTIONS, resolvedLang),
        multiSelect: true,
        allowFreeText: true,
      };

    // ── FOLLOW-UP FLOW ────────────────────────────────────────────────────

    case 'followup_status':
      return {
        question: 'So với lần trước, bạn cảm thấy thế nào?',
        options: localizeOptions(FOLLOWUP_STATUS_OPTIONS, resolvedLang),
        multiSelect: false,
        allowFreeText: false,
      };

    case 'followup_detail':
      return {
        question: 'Bạn có triệu chứng mới hoặc thay đổi gì không?',
        options: localizeOptions(FOLLOWUP_DETAIL_OPTIONS, resolvedLang),
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
    baselineAnswers = [],
    previousSeverity = null,
    forceConclusion = false,
    bodyLocation = null, // legacy single
    bodyLocations = null, // new T2 array
    bodyLocationOther = null,
    lang = 'vi',
  } = input;

  // 1. Rebuild current state from all previous answers.
  const state = buildState(previousAnswers, profile, healthContext, {
    baselineAnswers,
    previousSeverity,
  });
  // Inject T2 location info into state for buildQuestion to use
  state.bodyLocations = bodyLocations || (bodyLocation ? [bodyLocation] : null);
  state.bodyLocationOther = bodyLocationOther;

  // 2. Pick the right step sequence and apply skip-logic.
  const isFollowUp = phase === 'followup';
  const baseSteps = isFollowUp
    ? [
        ...FOLLOWUP_STEPS.slice(0, -1),
        ...(state.newSymptoms ? ['onset', 'progression', 'red_flags'] : []),
        'conclude',
      ]
    : [...INITIAL_STEPS];
  const steps = applySkipLogic(baseSteps, state, status);

  // Clarify an ambiguous response once. A finite budget produces an explicitly
  // incomplete assessment, never a fabricated 'enough information' conclusion.
  const clarification = [...state.unknownSteps].find((step) => state.attempts[step] < 2);
  const noComplaintAfterClarification =
    !isFollowUp && !state.allSymptoms.length && state.attempts.symptoms >= 2;
  const nextStep =
    forceConclusion || noComplaintAfterClarification
      ? 'conclude'
      : state.newSymptomPending
        ? 'followup_detail'
        : clarification ||
          steps.find((step) => !state.completedSteps.has(step) && !state.unknownSteps.has(step));
  state.assessmentIncomplete = Boolean(
    forceConclusion ||
    state.unknownSteps.size ||
    !state.allSymptoms.length ||
    noComplaintAfterClarification ||
    state.newSymptomPending
  );

  // 4. If no step remains or we've reached 'conclude', wrap up.
  if (!nextStep || nextStep === 'conclude') {
    const conclusion = calculateConclusion(state, status);
    return {
      action: 'conclude',
      primarySymptom: state.primarySymptom || null,
      conclusion,
      state,
    };
  }

  // 5. Build the question for this step.
  const questionData = buildQuestion(nextStep, state, lang);

  return {
    action: 'ask',
    step: nextStep,
    question: questionData.question,
    options: questionData.options,
    optionsGrouped: questionData.optionsGrouped || null, // pass through cho FE render section
    multiSelect: questionData.multiSelect,
    allowFreeText: questionData.allowFreeText,
    primarySymptom: state.primarySymptom || null,
    symptoms: state.currentSymptoms.length ? state.currentSymptoms : state.allSymptoms,
    previousSymptoms: state.allSymptoms,
    clarification: state.newSymptomPending ? 'new_symptom' : clarification || null,
    state,
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
    severity = state.isElderly || state.hasConditions ? 'high' : 'medium';
  } else if (state.progression === 'same' && (state.isElderly || state.hasConditions)) {
    // Stagnant symptoms in vulnerable population = medium.
    severity = 'medium';
  }

  if (
    ['high', 'emergency'].includes(state.previousSeverity) &&
    !state.completedSteps.has('red_flags')
  ) {
    severity = 'high';
    needsDoctor = true;
  }

  if (state.assessmentIncomplete) {
    if (severity === 'low') severity = 'medium';
    needsDoctor = true;
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
