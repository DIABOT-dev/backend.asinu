'use strict';

const { t } = require('../../i18n');
const { getHonorifics } = require('../../lib/honorifics');
const { getNextStep, buildQuestion, calculateConclusion } = require('./triage-engine');
const { normalizeLang, localizeOption } = require('./triage-i18n');
const {
  textOf,
  isNone,
  isUnknown,
  affirmativeParts,
  progressionOf,
  conditionsOf,
} = require('./triage-facts');
const {
  BODY_LOCATIONS,
  LOCATION_LABELS,
  getSymptomsForLocation,
  normalizeSymptomForEngine,
} = require('../../services/checkin/body-location');

const FIELDS = [
  'onset',
  'progression',
  'severity',
  'impact',
  'character',
  'pattern',
  'episode_duration',
  'radiation',
  'radiation_location',
  'aggravating',
  'relieving',
  'associated',
  'actions',
];
const MAX_DETAILED_ANSWERS = 128;
const detailStep = (region, field) => `detail_${region}_${field}`;
function parseDetailStep(step) {
  return (
    [...BODY_LOCATIONS, 'general']
      .flatMap((region) => FIELDS.map((field) => ({ region, field })))
      .find((item) => detailStep(item.region, item.field) === step) || null
  );
}
const isDetailedStep = (step) => step === 'detail_history' || Boolean(parseDetailStep(step));
function detailedQuestionsEnabled(input, env = process.env) {
  const requested =
    input.assessmentVersion === 2 ||
    input.previousAnswers?.some((item) => isDetailedStep(item.step));
  return (
    requested &&
    (env.CHECKIN_DETAILED_QUESTIONS_ENABLED === undefined
      ? ['development', 'test'].includes(env.NODE_ENV)
      : ['true', '1'].includes(env.CHECKIN_DETAILED_QUESTIONS_ENABLED))
  );
}
const canonical = (value) => normalizeSymptomForEngine(value).toLowerCase().trim();
function groupsFor(state, lang) {
  const selected = [...new Set(state.bodyLocations || [])].filter((region) =>
    BODY_LOCATIONS.includes(region)
  );
  const symptoms = state.currentSymptoms.length ? state.currentSymptoms : state.allSymptoms;
  const groups = selected
    .map((region) => {
      const known = getSymptomsForLocation(region, 'vi').map(canonical);
      const matched = symptoms.filter((symptom) =>
        known.some((label) => canonical(symptom).includes(label))
      );
      const position = String(state.bodyLocationOther || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) =>
          ['vi', 'en'].some((locale) =>
            part.startsWith(`${LOCATION_LABELS[locale][region].label}:`)
          )
        )
        ?.split(':')
        .slice(1)
        .join(':')
        .trim();
      return {
        region,
        label: LOCATION_LABELS[lang][region].label,
        symptoms: matched,
        ...(position ? { position } : {}),
      };
    })
    .filter((group) => group.symptoms.length);
  const unmatched = symptoms.filter(
    (symptom) => !groups.some((group) => group.symptoms.includes(symptom))
  );
  if (!groups.length && selected.length === 1) {
    groups.push({ region: selected[0], label: LOCATION_LABELS[lang][selected[0]].label, symptoms });
  } else if (unmatched.length || !selected.length) {
    groups.push({
      region: 'general',
      label: t('checkin.detail.general', lang),
      symptoms: unmatched.length ? unmatched : symptoms,
    });
  }
  return groups;
}
const painReported = (group) =>
  group.symptoms.some((symptom) => /đau|nhức|chuột rút|pain|ache|cramp/i.test(symptom));
const key = (name) => `checkin.detail.${name}`;
function configuredChoices(field, group) {
  switch (field) {
    case 'severity':
      return [
        'mild',
        'moderate',
        'severe',
        painReported(group) ? 'no_pain_now' : 'no_discomfort_now',
        'unknown',
      ];
    case 'impact':
      return ['impact_none', 'impact_some', 'impact_much', 'unknown'];
    case 'character':
      return ['dull', 'sharp', 'throbbing', 'tight', 'burning', 'unknown'];
    case 'pattern':
      return ['constant', 'episodes', 'occasional', 'unknown'];
    case 'episode_duration':
      return ['under_minute', 'few_minutes', 'several_minutes', 'long_episode', 'unknown'];
    case 'radiation':
      return ['stays_here', 'spreads', 'unknown'];
    case 'radiation_location':
      return (
        {
          head: [
            'radiates_neck_nape',
            'radiates_face_eyes',
            'radiates_shoulder_arm',
            'radiates_back',
          ],
          chest: [
            'radiates_shoulder_arm',
            'radiates_neck_jaw',
            'radiates_back',
            'radiates_upper_abdomen',
          ],
          abdomen: ['radiates_back', 'radiates_shoulder_arm', 'radiates_groin', 'radiates_chest'],
        }[group.region] || [
          'radiates_neck_shoulder',
          'radiates_back',
          'radiates_hand',
          'radiates_leg_foot',
        ]
      ).concat('unknown');
    case 'aggravating':
      if (group.region === 'mental')
        return ['stress', 'short_sleep_context', 'social_pressure', 'no_trigger', 'unknown'];
      if (group.region === 'skin')
        return ['heat_sweat', 'rubbing', 'skin_contact', 'no_trigger', 'unknown'];
      if (['whole_body', 'general'].includes(group.region))
        return ['activity', 'short_sleep_context', 'stress', 'no_trigger', 'unknown'];
      return [
        'movement',
        'activity',
        ...(group.region === 'head' ? ['light_noise', 'screen'] : []),
        ...(group.region === 'abdomen' ? ['after_meal', 'empty_stomach'] : []),
        'stress',
        'no_trigger',
        'unknown',
      ];
    case 'relieving':
      if (group.region === 'mental')
        return [
          'rest_helps',
          'quiet_place_helps',
          'talking_helps',
          'nothing_helps',
          'not_tried',
          'unknown',
        ];
      if (group.region === 'skin')
        return ['less_rubbing_helps', 'cool_place_helps', 'nothing_helps', 'not_tried', 'unknown'];
      return [
        'rest_helps',
        'less_movement_helps',
        'quiet_place_helps',
        'nothing_helps',
        'not_tried',
        'unknown',
      ];
    case 'actions':
      return [
        'recorded_reading',
        'family_help',
        'clinical_contact',
        'seen_clinician',
        'no_extra_action',
        'unknown',
      ];
    case 'associated':
      return (
        {
          head: ['nausea', 'dizziness', 'fever', 'blurred_vision'],
          chest: ['breathlessness', 'palpitations', 'sweating', 'dizziness'],
          abdomen: ['nausea', 'vomiting', 'diarrhea', 'bloating', 'fever'],
          limbs: ['swelling', 'redness_heat', 'numbness', 'weakness', 'injury'],
          skin: ['itching', 'rash', 'swelling', 'fever'],
          whole_body: ['fever', 'chills', 'fatigue', 'poor_appetite'],
          mental: ['poor_sleep', 'poor_appetite', 'sadness', 'anxiety'],
          general: ['fever', 'fatigue', 'nausea', 'dizziness'],
        }[group.region] || []
      ).concat('none', 'unknown');
    default:
      return [];
  }
}
function regionalQuestion(field, group, lang, profile = {}) {
  let options;
  if (field === 'onset') options = buildQuestion('onset', {}, lang).options;
  else if (field === 'progression')
    options = ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'].map((value) =>
      localizeOption(value, lang)
    );
  else options = configuredChoices(field, group).map((choice) => t(key(`option.${choice}`), lang));
  if (field === 'associated')
    options = options.filter(
      (option) => !group.symptoms.some((symptom) => canonical(symptom) === canonical(option))
    );
  const unknown = t(key('option.unknown'), lang);
  if (!options.includes(unknown)) options.push(unknown);
  const questionField = field === 'severity' && !painReported(group) ? 'discomfort' : field;
  const hasPhysicalArea = ['head', 'chest', 'abdomen', 'limbs', 'skin'].includes(group.region);
  return {
    action: 'ask',
    step: detailStep(group.region, field),
    question: t(key(`question.${hasPhysicalArea ? 'area_' : ''}${questionField}`), lang, {
      ...getHonorifics({ ...profile, lang }),
      area: lang === 'vi' && group.region === 'skin' ? 'vùng da này' : group.label.toLowerCase(),
    }),
    options,
    multiSelect: [
      'character',
      'radiation_location',
      'aggravating',
      'relieving',
      'associated',
      'actions',
    ].includes(field),
    allowFreeText: true,
    exclusiveOptions: [
      'unknown',
      'none',
      'no_trigger',
      'nothing_helps',
      'not_tried',
      'no_action',
      'no_extra_action',
    ].map((choice) => t(key(`option.${choice}`), lang)),
  };
}
function canonicalDetailAnswer(value) {
  // Keep free text verbatim; translate only an exact configured English choice.
  const keys = [
    'mild',
    'moderate',
    'severe',
    'no_pain_now',
    'no_discomfort_now',
    'impact_none',
    'impact_some',
    'impact_much',
    'dull',
    'sharp',
    'throbbing',
    'tight',
    'burning',
    'constant',
    'episodes',
    'occasional',
    'stays_here',
    'spreads',
    'radiates_neck_nape',
    'radiates_face_eyes',
    'radiates_shoulder_arm',
    'radiates_back',
    'radiates_neck_jaw',
    'radiates_upper_abdomen',
    'radiates_groin',
    'radiates_chest',
    'radiates_neck_shoulder',
    'radiates_hand',
    'radiates_leg_foot',
    'under_minute',
    'few_minutes',
    'several_minutes',
    'long_episode',
    'movement',
    'activity',
    'light_noise',
    'screen',
    'after_meal',
    'empty_stomach',
    'stress',
    'short_sleep_context',
    'social_pressure',
    'heat_sweat',
    'rubbing',
    'skin_contact',
    'talking_helps',
    'less_rubbing_helps',
    'cool_place_helps',
    'no_trigger',
    'rest',
    'less_movement',
    'quiet_place',
    'rest_helps',
    'less_movement_helps',
    'quiet_place_helps',
    'nothing_helps',
    'not_tried',
    'recorded_reading',
    'no_action',
    'family_help',
    'clinical_contact',
    'seen_clinician',
    'no_extra_action',
    'nausea',
    'dizziness',
    'fever',
    'blurred_vision',
    'breathlessness',
    'palpitations',
    'sweating',
    'vomiting',
    'diarrhea',
    'bloating',
    'swelling',
    'redness_heat',
    'numbness',
    'weakness',
    'injury',
    'itching',
    'rash',
    'chills',
    'fatigue',
    'poor_appetite',
    'poor_sleep',
    'sadness',
    'anxiety',
    'none',
    'unknown',
    'no_conditions',
    'diabetes',
    'hypertension',
    'dyslipidemia',
    'heart_condition',
  ];
  const translate = (item) => {
    // Keep the meaning of answers submitted by clients with the old labels.
    if (textOf(item).toLowerCase() === 'about 1–5 minutes') return 'Khoảng 1–5 phút';
    const match = keys.find(
      (choice) => t(key(`option.${choice}`), 'en').toLowerCase() === textOf(item).toLowerCase()
    );
    return match ? t(key(`option.${match}`), 'vi') : item;
  };
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item).split(/,\s*/).map(translate).join(', '))
    .join(', ');
}

function getDetailedNextStep(input) {
  const lang = normalizeLang(input.lang);
  const answers = input.previousAnswers || [];
  const core = answers.filter((item) => !isDetailedStep(item.step));
  const declared = answers.find((item) => item.step === 'detail_history');
  const profileConditions = conditionsOf(
    input.healthContext?.medical_conditions || input.profile?.medical_conditions
  );
  const historyText = declared ? canonicalDetailAnswer(declared.answer) : null;
  const historyNone =
    historyText && (isNone(historyText) || historyText === t(key('option.no_conditions'), 'vi'));
  const conditions = profileConditions.length
    ? profileConditions
    : historyText && !historyNone && !isUnknown(historyText)
      ? conditionsOf(historyText.split(/[,;]/).map((value) => value.trim())).filter(
          (value) => value !== t(key('option.no_conditions'), 'vi')
        )
      : [];
  const clinicalInput = {
    ...input,
    healthContext: { ...input.healthContext, medical_conditions: conditions },
  };
  const initial = getNextStep({ ...clinicalInput, previousAnswers: core });
  const state = initial.state;
  if (
    (input.phase === 'followup' && (!state.newSymptoms || state.newSymptomPending)) ||
    (!state.allSymptoms.length && initial.action === 'conclude')
  )
    return initial;
  const groups = groupsFor(state, lang);
  for (const group of groups) {
    const associated = answers.find(
      (item) => item.step === detailStep(group.region, 'associated')
    )?.answer;
    const pain = affirmativeParts(associated).filter((part) => painReported({ symptoms: [part] }));
    group.symptoms = [...new Set([...group.symptoms, ...pain])];
  }
  // Newly reported pain must open the corresponding detail fields. Only use a
  // region established by the server; never infer one from an AI question.
  for (const extra of input.supplementalAnswers || []) {
    const group = groups.find((item) => item.region === extra.region);
    if (!group) continue;
    const pain = affirmativeParts(extra.answer).filter((part) =>
      painReported({ symptoms: [part] })
    );
    group.symptoms = [...new Set([...group.symptoms, ...pain])];
  }
  const details = groups.map((group) => ({
    region: group.region,
    label: group.label,
    ...(group.position ? { position: group.position } : {}),
    symptoms: group.symptoms,
    answers: Object.fromEntries(
      FIELDS.flatMap((field) => {
        const entry = answers.find((item) => item.step === detailStep(group.region, field));
        if (!entry && groups.length === 1 && field === 'onset' && state.completedSteps.has('onset'))
          return [[field, state.onset]];
        if (
          !entry &&
          groups.length === 1 &&
          field === 'progression' &&
          state.completedSteps.has('progression')
        )
          return [
            [
              field,
              { better: 'đang đỡ dần', same: 'vẫn như cũ', worse: 'có vẻ nặng hơn' }[
                state.progression
              ],
            ],
          ];
        return entry ? [[field, canonicalDetailAnswer(entry.answer)]] : [];
      })
    ),
  }));
  for (const detail of details) {
    const associated = detail.answers.associated;
    if (associated && !isNone(associated) && !isUnknown(associated))
      core.push({ step: 'associated', answer: affirmativeParts(associated) });
    if (detail.answers.actions && !isUnknown(detail.answers.actions))
      core.push({ step: 'action', answer: detail.answers.actions });
  }
  const careActions = answers.find((item) => item.step === detailStep('general', 'actions'));
  const careActionsAnswer = careActions ? canonicalDetailAnswer(careActions.answer) : null;
  if (
    careActions &&
    !isUnknown(careActions.answer) &&
    careActionsAnswer !== t(key('option.no_extra_action'), 'vi')
  )
    core.push({ step: 'action', answer: careActionsAnswer });
  const knownOnsets = details
    .map((detail) => detail.answers.onset)
    .filter((value) => value && !isUnknown(value));
  if (knownOnsets.length)
    core.push({
      step: 'onset',
      answer:
        [...new Set(knownOnsets)].length === 1
          ? knownOnsets[0]
          : details
              .filter((detail) => detail.answers.onset)
              .map((detail) => `${detail.label}: ${detail.answers.onset}`)
              .join('; '),
    });
  const progressions = details
    .map((detail) => progressionOf(detail.answers.progression))
    .filter(Boolean);
  const progression = ['worse', 'same', 'better'].find((value) => progressions.includes(value));
  if (progression)
    core.push({
      step: 'progression',
      answer: { worse: 'có vẻ nặng hơn', same: 'vẫn như cũ', better: 'đang đỡ dần' }[progression],
    });
  const projected = getNextStep({ ...clinicalInput, previousAnswers: core });
  projected.state.regionDetails = details;
  projected.state.careActionsAnswer = careActionsAnswer;
  projected.state.detailedAssessmentVersion = 2;
  projected.state.conditions = conditions;
  projected.state.hasConditions = conditions.length > 0;
  projected.state.historyAssessment = profileConditions.length
    ? 'profile'
    : historyNone
      ? 'none_reported'
      : declared
        ? isUnknown(historyText)
          ? 'unknown'
          : 'answered'
        : 'not_asked';

  const plan = [
    ...(input.phase === 'followup' ? [] : [{ step: 'symptoms' }]),
    { step: 'red_flags' },
    ...(!profileConditions.length ? [{ step: 'detail_history' }] : []),
    ...groups.flatMap((group) =>
      FIELDS.filter((field) => {
        // Self-care/contact with family or clinicians is asked once for the
        // interview. Repeating it after every area collects the same answer.
        if (field === 'actions') return false;
        if (
          !painReported(group) &&
          ['character', 'radiation', 'radiation_location'].includes(field)
        )
          return false;
        const detail = details.find((item) => item.region === group.region);
        if (
          ['onset', 'progression'].includes(field) &&
          detail?.answers[field] &&
          !answers.some((item) => item.step === detailStep(group.region, field))
        )
          return false;
        if (field === 'episode_duration')
          return (
            ['episodes', 'occasional'].some(
              (choice) => detail?.answers.pattern === t(key(`option.${choice}`), 'vi')
            ) ||
            /từng (?:đợt|cơn|lúc)|thỉnh thoảng|cứ .{1,40}(?:lại|một lần)|comes and goes|episode|intermittent/iu.test(
              affirmativeParts(detail?.answers.pattern).join(' ')
            )
          );
        if (field === 'radiation_location')
          return (
            detail?.answers.radiation === t(key('option.spreads'), 'vi') ||
            /(?:^|\s)lan(?:\s|$)|radiat|spread/iu.test(
              affirmativeParts(detail?.answers.radiation).join(' ')
            )
          );
        return true;
      }).map((field) => ({ step: detailStep(group.region, field), group, field }))
    ),
    ...(!answers.some((item) => parseDetailStep(item.step)?.field === 'actions') || careActions
      ? [
          {
            step: detailStep('general', 'actions'),
            group: { region: 'general', label: t(key('general'), lang) },
            field: 'actions',
          },
        ]
      : []),
  ];
  const observed = new Set(answers.map((item) => item.step));
  const pending = plan.find((item) => !observed.has(item.step));
  // The clinical safety question is clarified once; optional detail uncertainty
  // is accepted without repeating the interview or claiming it was answered.
  const coreClarification =
    initial.clarification && ['symptoms', 'red_flags'].includes(initial.step);
  let next = coreClarification ? { step: initial.step } : pending;
  if (input.forceConclusion || projected.state.redFlagsFound.length) next = null;
  if (!next) {
    const completed = getNextStep({
      ...clinicalInput,
      previousAnswers: core,
      forceConclusion: Boolean(
        input.forceConclusion ||
        projected.state.redFlagsFound.length ||
        projected.action !== 'conclude'
      ),
    });
    completed.state.regionDetails = details;
    completed.state.careActionsAnswer = projected.state.careActionsAnswer;
    completed.state.historyAssessment = projected.state.historyAssessment;
    completed.state.detailedAssessmentComplete = !pending;
    completed.state.detailedAssessmentVersion = 2;
    if (
      details.some(
        (detail) =>
          !detail.answers.onset ||
          isUnknown(detail.answers.onset) ||
          !progressionOf(detail.answers.progression)
      )
    ) {
      completed.state.assessmentIncomplete = true;
      completed.conclusion = calculateConclusion(completed.state, input.status);
    }
    return completed;
  }
  let question;
  if (next.group) question = regionalQuestion(next.field, next.group, lang, input.profile);
  else if (next.step === 'detail_history')
    question = {
      action: 'ask',
      step: next.step,
      question: t(key('question.history'), lang, getHonorifics({ ...input.profile, lang })),
      options: [
        'no_conditions',
        'diabetes',
        'hypertension',
        'dyslipidemia',
        'heart_condition',
        'unknown',
      ].map((choice) => t(key(`option.${choice}`), lang)),
      multiSelect: true,
      allowFreeText: true,
      exclusiveOptions: ['no_conditions', 'unknown'].map((choice) =>
        t(key(`option.${choice}`), lang)
      ),
    };
  else
    question = {
      ...initial,
      ...buildQuestion(next.step, initial.state, lang),
      action: 'ask',
      step: next.step,
      ...(next.step === 'red_flags'
        ? {
            exclusiveOptions: [
              t('checkin.triage.option.none', lang),
              t('checkin.triage.option.unknown', lang),
            ],
          }
        : {}),
    };
  return {
    ...question,
    pendingTemplateFields: plan
      .filter((item) => !observed.has(item.step))
      .map((item) => item.field || item.step),
    pendingTemplateQuestions: plan
      .filter((item) => !observed.has(item.step))
      .map((item) =>
        item.group
          ? regionalQuestion(item.field, item.group, lang, input.profile).question
          : item.step === 'detail_history'
            ? t(key('question.history'), lang, getHonorifics({ ...input.profile, lang }))
            : item.step
      ),
    state: projected.state,
    detailedQuestion: Boolean(next.group || next.step === 'detail_history'),
    questionProgress: {
      current: answers.length + 1,
      total: Math.max(answers.length + 1, plan.length + answers.length - observed.size),
    },
    symptoms: state.currentSymptoms.length ? state.currentSymptoms : state.allSymptoms,
    questionGroup:
      next.group && groups.includes(next.group)
        ? {
            key: next.group.region,
            label: next.group.label,
            index: groups.indexOf(next.group) + 1,
            total: groups.length,
          }
        : null,
  };
}

module.exports = {
  getDetailedNextStep,
  detailedQuestionsEnabled,
  isDetailedStep,
  MAX_DETAILED_ANSWERS,
};
