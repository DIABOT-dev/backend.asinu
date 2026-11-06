'use strict';

const { z } = require('zod');
const { t } = require('../../i18n');
const {
  buildState,
  buildQuestion,
  calculateConclusion,
} = require('../../core/checkin/triage-engine');
const { normalizeProfile, isNone, isUnknown } = require('../../core/checkin/triage-facts');
const { detectEmergency } = require('../checkin/emergency-detector');

const STEPS = ['red_flags', 'associated', 'onset', 'progression', 'impact'];
const screeningAnswerSchema = z
  .object({
    step: z.enum(STEPS),
    values: z.array(z.string().trim().min(1).max(100)).max(12),
    text: z.string().trim().max(500).default(''),
  })
  .strict();
const screeningRequestSchema = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    answers: z.array(screeningAnswerSchema).max(STEPS.length).default([]),
    locale: z.enum(['vi', 'en']).default('vi'),
  })
  .strict();

const copy = (key, lang) => t(`doctor.screening.${key}`, lang);
const option = (value, label) => ({ value, label });

function questionFor(step, state, lang) {
  const question = {
    step,
    title: copy(`question.${step}`, lang),
    multiSelect: false,
    allowFreeText: false,
  };
  if (['red_flags', 'associated'].includes(step)) {
    const built = buildQuestion(step, state, lang);
    const generic = step === 'red_flags' ? buildQuestion(step, buildState([]), lang).options : [];
    const labels = [...new Set([...built.options, ...generic])]
      .filter((label) => !isNone(label) && !isUnknown(label))
      .slice(0, 9);
    return {
      ...question,
      multiSelect: true,
      allowFreeText: true,
      options: [
        ...labels.map((label, index) => option(`option:${index}`, label)),
        option('none', copy('none', lang)),
        ...(step === 'red_flags' ? [option('unsure', copy('unsure', lang))] : []),
      ],
    };
  }
  const values = {
    onset: ['today', 'two_to_seven_days', 'over_one_week', 'ongoing'],
    progression: ['improving', 'stable', 'worsening'],
    impact: ['mild', 'moderate', 'severe'],
  }[step];
  return {
    ...question,
    options: values.map((value) => option(value, copy(`option.${value}`, lang))),
  };
}

function invalidAnswer() {
  const error = new Error('Invalid or out-of-order screening answer.');
  error.statusCode = 400;
  error.code = 'INVALID_SCREENING_ANSWER';
  throw error;
}

// Replay only server-defined questions. Client-supplied verdicts and priorities
// never participate in the assessment. No check-in session or alert is created.
function evaluateConsultationScreening(input, profile = {}) {
  const parsed = screeningRequestSchema.safeParse(input);
  if (!parsed.success) invalidAnswer();
  const { summary, answers, locale: lang } = parsed.data;
  const normalizedProfile = normalizeProfile(profile);
  const engineAnswers = [{ step: 'symptoms', answer: summary }];
  const recorded = [];
  let impact = null;
  let dangerUnknown = false;
  let associatedDanger = [];
  const fields = {};

  const assess = () => {
    const state = buildState(engineAnswers, normalizedProfile);
    state.redFlagsFound.push(...associatedDanger);
    const emergency = detectEmergency(
      engineAnswers.map((answer) => answer.answer).flat(),
      normalizedProfile
    );
    const conclusion = calculateConclusion(
      state,
      impact === 'severe' ? 'very_tired' : 'specific_concern'
    );
    const rank = { low: 0, medium: 1, high: 2, emergency: 3 };
    if (rank[emergency.severity] > rank[conclusion.severity])
      conclusion.severity = emergency.severity;
    if (dangerUnknown && conclusion.severity === 'low') conclusion.severity = 'medium';
    const status = emergency.isEmergency
      ? 'emergency'
      : dangerUnknown
        ? 'incomplete'
        : state.redFlagsFound.length
          ? 'needs_in_person'
          : null;
    return { state, conclusion, status };
  };
  const resultFor = ({ conclusion, status }, complete = false) => ({
    status: status || (complete ? 'ready' : 'question'),
    isDone: Boolean(status || complete),
    suitable_for_remote_care: complete && !status,
    risk_level: conclusion.severity,
    message: status || complete ? copy(`result.${status || 'ready'}`, lang) : null,
    recorded_answers: recorded,
    screening_version: 'consultation-v2',
    ...(complete || status ? { screened_at: new Date().toISOString() } : {}),
    intake: fields,
  });

  for (let index = 0; index <= answers.length; index++) {
    const assessment = assess();
    if (assessment.status) {
      if (index !== answers.length) invalidAnswer();
      return resultFor(assessment);
    }
    const step = STEPS[index];
    if (!step) return resultFor(assessment, true);
    const question = questionFor(step, assessment.state, lang);
    const answer = answers[index];
    if (!answer) return { ...resultFor(assessment), question };
    const values = [...new Set(answer.values)];
    const exclusive = values.some((value) => ['none', 'unsure'].includes(value));
    if (
      answer.step !== step ||
      (!values.length && !answer.text) ||
      values.some((value) => !question.options.some((item) => item.value === value)) ||
      (!question.multiSelect && values.length !== 1) ||
      (!question.allowFreeText && answer.text) ||
      (exclusive && (values.length !== 1 || answer.text))
    )
      invalidAnswer();
    const labels = values.map(
      (value) => question.options.find((item) => item.value === value).label
    );
    recorded.push({
      step,
      question: question.title,
      answers: [...labels, ...(answer.text ? [answer.text] : [])],
    });
    if (step === 'red_flags') {
      dangerUnknown =
        values.includes('unsure') ||
        isUnknown(answer.text) ||
        /(?:không chắc|not sure)/i.test(answer.text);
      engineAnswers.push({
        step,
        answer: values.includes('none') ? 'không có' : [...labels, answer.text].filter(Boolean),
      });
    } else if (step === 'associated') {
      const positive = values.includes('none') ? [] : [...labels, answer.text].filter(Boolean);
      engineAnswers.push({ step, answer: positive.length ? positive : 'không có' });
      associatedDanger = assessment.state.mappings
        .flatMap((mapping) => mapping.associatedSymptoms || [])
        .filter((item) => item.dangerLevel === 'danger' && positive.includes(item.text))
        .map((item) => item.text);
    } else if (step === 'impact') {
      impact = values[0];
      fields.severity = impact;
    } else {
      fields[step === 'onset' ? 'symptom_onset' : step] = values[0];
      const engineValue =
        step === 'progression'
          ? { improving: 'better', stable: 'same', worsening: 'worse' }[values[0]]
          : labels[0];
      engineAnswers.push({ step, answer: engineValue });
    }
  }
  return invalidAnswer();
}

module.exports = { screeningAnswerSchema, screeningRequestSchema, evaluateConsultationScreening };
