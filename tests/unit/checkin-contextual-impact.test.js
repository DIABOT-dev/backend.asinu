'use strict';
jest.mock('../../src/security/openbao-keyring.cjs', () => ({ keyringEnabled: () => false, keyringReady: () => true }));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/core/checkin/triage-ai-layer', () => ({
  ...jest.requireActual('../../src/core/checkin/triage-ai-layer'),
  classifySymptomSeverity: jest.fn().mockResolvedValue({ severity: 'mild' }),
  generateConclusion: jest.fn().mockResolvedValue({ summary: 'Recorded', recommendation: 'Monitor' }),
}));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { getCompactNextStep, validateQuestion, validateCompactAnswers } = require('../../src/services/checkin/compact-interview.service');
const { readAdaptiveState, protectAdaptiveState } = require('../../src/services/checkin/adaptive-question.service');
const { providerResponse } = require('../fixtures/compact-interview');

const itchOptions = () => [
  { id: 'unaffected', label: 'Ngứa nhẹ nhưng vẫn sinh hoạt bình thường', impact_code: 'normal' },
  { id: 'sleep', label: 'Ngứa làm khó ngủ hoặc thức giấc giữa đêm', impact_code: 'slowed' },
  { id: 'pause_tasks', label: 'Phải dừng việc đang làm để gãi', impact_code: 'slowed' },
  { id: 'concentration', label: 'Ngứa làm khó tập trung vào việc đang làm', impact_code: 'slowed' },
];
let choices, reviewerCodes;
beforeEach(() => {
  jest.clearAllMocks(); choices = itchOptions(); reviewerCodes = null;
  callTextAi.mockImplementation(async (params) => {
    const payload = JSON.parse(params.prompt), context = payload.CONTEXT;
    if (context.field === 'impact') {
      if (params.system.startsWith('Review one health intake')) return { content: JSON.stringify({ valid: true, errors: [],
        impact_codes: reviewerCodes || choices.map(c => ({ id: c.id, code: c.impact_code })),
      }) };
      return { content: JSON.stringify({ field: 'impact',
        question: 'Cơn ngứa có làm giấc ngủ hay việc thường ngày của chú bị gián đoạn không?', options: choices,
      }) };
    }
    return providerResponse(params);
  });
});
async function openImpact() {
  const input = { assessmentVersion: 3, interviewLayout: 'eight_groups', adaptiveEnabled: true,
    phase: 'initial', status: 'tired', lang: 'vi', profile: { age: 56, gender: 'Nam' },
    bodyLocations: ['skin'], bodyLocationOther: 'Da vùng cổ', healthContext: {}, previousAnswers: [],
    adaptiveState: { version: 1, sources: [], questions: [] },
  };
  let next;
  const advance = async (answer) => {
    if (answer !== undefined) input.previousAnswers.push({ step: next.step, question: next.question, answer });
    next = await getNextTriageQuestion(input); input.adaptiveState = next._adaptiveState || input.adaptiveState;
    return next;
  };
  await advance(); await advance('Ngứa'); await advance('Không có');
  expect(next.step).toBe('compact_impact');
  return { input, advance, get next() { return next; } };
}

test('itch receives reviewed contextual answers, accepts coexisting impacts and never forces mobility/dependence', async () => {
  const flow = await openImpact();
  expect(flow.next.questionSource).toBe('ai');
  expect(flow.next.options).toEqual(expect.arrayContaining(choices.map(c => c.label)));
  expect(flow.next.multiSelect).toBe(true);
  expect(flow.next.exclusiveOptions).toContain(choices[0].label);
  expect(flow.next.options.join(' ')).not.toMatch(/chậm hơn|người giúp|đi lại/iu);
  const generation = callTextAi.mock.calls.map(([p]) => p).find(p => {
    const c = JSON.parse(p.prompt).CONTEXT;
    return c.field === 'impact' && !p.system.startsWith('Review');
  });
  const context = JSON.parse(generation.prompt).CONTEXT;
  expect(context.required_option_ids).toBeNull();
  expect(context.impact_choices_mode).toBe('patient_context');
  expect(context.target_concerns.map(c => c.label)).toContain('Ngứa');
  expect(generation.provider).toBe('medgemma'); expect(generation.strictProvider).toBe(true);
  const review = callTextAi.mock.calls.map(([p]) => p).find(p =>
    p.system.startsWith('Review one health intake') && JSON.parse(p.prompt).CONTEXT.field === 'impact');
  const reviewedChoices = JSON.parse(review.prompt).QUESTION.choices;
  expect(reviewedChoices.every(c => !('impactCode' in c) && !('impact_code' in c))).toBe(true);
  const answer = `${choices[1].label}, ${choices[2].label}`;
  const following = await flow.advance(answer);
  expect(following.step).toBe('compact_timeline');
  const state = getCompactNextStep(flow.input).state;
  expect(state.functionalImpact).toBe('slowed');
  expect(state.compactAssessment.answers.find(a => a.group === 'impact').answer).toBe(answer);
  expect(flow.input.adaptiveState.compact.coverage.global.impact.codes).toEqual(['slowed']);
});

test('an off-region impact draft rejected by review is regenerated with the same patient context', async () => {
  const original = callTextAi.getMockImplementation(); let wrongDraft = true;
  callTextAi.mockImplementation(async params => {
    const payload = JSON.parse(params.prompt);
    if (payload.CONTEXT.field === 'impact' && wrongDraft) {
      if (params.system.startsWith('Review one health intake')) {
        wrongDraft = false;
        return { content: JSON.stringify({ valid: false, errors: ['Mobility choices are unrelated to the reported itch at the neck.'] }) };
      }
      return { content: JSON.stringify({ field: 'impact', question: 'Khớp gối có làm chú khó đi lại không?', options: [
        { id: 'normal', label: 'Vẫn sinh hoạt bình thường', impact_code: 'normal' },
        { id: 'slowed', label: 'Đi lại chậm hơn', impact_code: 'slowed' },
        { id: 'unable', label: 'Có việc không tự làm được, cần người giúp', impact_code: 'unable' },
      ] }) };
    }
    return original(params);
  });
  const flow = await openImpact();
  expect(flow.next.questionSource).toBe('ai');
  expect(flow.next.options).toEqual(expect.arrayContaining(itchOptions().map(c => c.label)));
  expect(flow.next.question).not.toContain('Khớp gối');
  const retried = callTextAi.mock.calls.map(([p]) => p).find(p => {
    const payload = JSON.parse(p.prompt);
    return payload.CONTEXT.field === 'impact' && payload.CORRECTION;
  });
  expect(JSON.parse(retried.prompt).CONTEXT.exact_location).toBe('Da vùng cổ');
  expect(JSON.parse(retried.prompt).CORRECTION).toEqual(['Mobility choices are unrelated to the reported itch at the neck.']);
});

test('the same reviewed contextual question survives resume with its exact labels and code mapping', async () => {
  const flow = await openImpact(); const calls = callTextAi.mock.calls.length;
  const adaptiveState = readAdaptiveState(97, protectAdaptiveState(97, flow.input.adaptiveState));
  const replay = await getNextTriageQuestion({ ...flow.input, adaptiveState });
  expect(replay.options).toEqual(flow.next.options); expect(replay.question).toBe(flow.next.question);
  expect(replay.multiSelect).toBe(true); expect(callTextAi).toHaveBeenCalledTimes(calls);
  expect(adaptiveState.compact.questions.at(-1).choices[1].impactCode).toBe('slowed');
});

test('an unanswered old generic impact menu is refreshed without deleting the existing answers', async () => {
  const flow = await openImpact();
  const question = flow.input.adaptiveState.compact.questions.at(-1);
  question.question = 'Những khó chịu này ảnh hưởng thế nào đến sinh hoạt hằng ngày của chú?';
  delete question.impactChoicesMode;
  question.choices = [
    { id: 'normal', label: 'Vẫn sinh hoạt bình thường' },
    { id: 'slowed', label: 'Làm chậm hơn nhưng vẫn tự làm được' },
    { id: 'unable', label: 'Có việc cần người giúp' },
  ];
  const answers = structuredClone(flow.input.previousAnswers);
  const resumed = await getNextTriageQuestion(flow.input);
  expect(resumed.question).not.toBe(question.question);
  expect(resumed.options).toEqual(expect.arrayContaining(itchOptions().map(c => c.label)));
  expect(resumed.multiSelect).toBe(true);
  expect(flow.input.previousAnswers).toEqual(answers);
  expect(resumed._adaptiveState.compact.questions).toHaveLength(flow.input.adaptiveState.compact.questions.length);
});

test('an old generic menu already answered is retained and its functioning code is not reinterpreted', async () => {
  const flow = await openImpact();
  const question = flow.input.adaptiveState.compact.questions.at(-1);
  delete question.impactChoicesMode;
  question.choices = [
    { id: 'normal', label: 'Vẫn sinh hoạt bình thường' },
    { id: 'slowed', label: 'Làm chậm hơn nhưng vẫn tự làm được' },
    { id: 'unable', label: 'Có việc cần người giúp' },
  ];
  const before = callTextAi.mock.calls.length;
  await flow.advance('Làm chậm hơn nhưng vẫn tự làm được');
  expect(getCompactNextStep(flow.input).state.functionalImpact).toBe('slowed');
  expect(flow.input.adaptiveState.compact.questions.filter(q => q.field === 'impact')).toHaveLength(1);
  expect(callTextAi.mock.calls.slice(before).some(([p]) => JSON.parse(p.prompt).CONTEXT.field === 'impact')).toBe(false);
});

test('an explicit inability remains the strongest selected impact regardless of choice order', async () => {
  choices[3] = { id: 'needs_help', label: 'Có việc không tự làm được, cần người giúp', impact_code: 'unable' };
  const flow = await openImpact(); await flow.advance(`${choices[1].label}, ${choices[3].label}`);
  expect(getCompactNextStep(flow.input).state.functionalImpact).toBe('unable');
  expect(flow.input.adaptiveState.compact.coverage.global.impact.codes).toEqual(['slowed', 'unable']);
});

test('the server rejects mutually contradictory unaffected and affected choices', async () => {
  const flow = await openImpact();
  expect(() => validateCompactAnswers(flow.input.adaptiveState, [...flow.input.previousAnswers,
    { step: flow.next.step, question: flow.next.question, answer: `${choices[0].label}, ${choices[1].label}` },
  ])).toThrow();
});

test.each(['mismatch', 'missing', 'duplicated'])('a %s reviewer mapping cannot publish generated impact choices', async (kind) => {
  reviewerCodes = choices.map(c => ({ id: c.id, code: c.impact_code }));
  if (kind === 'mismatch') reviewerCodes[1].code = 'normal';
  if (kind === 'missing') reviewerCodes.pop();
  if (kind === 'duplicated') reviewerCodes[3] = reviewerCodes[1];
  const flow = await openImpact();
  expect(flow.next.questionSource).toBe('fallback');
  expect(flow.next.options).not.toEqual(expect.arrayContaining(choices.map(c => c.label)));
});

test.each([
  ['Ngứa làm khó ngủ hoặc thức giấc giữa đêm', 'unable'],
  ['Không ngủ được vì ngứa', 'unable'],
  ['Cannot sleep because of itching', 'unable'],
  ['Cannot sleep and work is interrupted', 'unable'],
  ['Ngứa làm khó tập trung', 'normal'],
  ['Vẫn sinh hoạt bình thường', 'unable'],
  ['Có việc không tự làm được, cần người giúp', 'normal'],
])('visible wording cannot be processed as the wrong impact: %s / %s', (label, code) => {
  const value = { field: 'impact', question: 'Cơn ngứa ảnh hưởng thế nào đến sinh hoạt của chú?', options: itchOptions() };
  value.options[1] = { id: 'changed', label, impact_code: code };
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' },
    previous_questions: [], required_options: [], impact_choices_mode: 'patient_context' };
  expect(validateQuestion(JSON.stringify(value), 'impact', context)).toBeNull();
});

test('uncertainty is preserved rather than recorded as no impact', async () => {
  const flow = await openImpact(); await flow.advance('Không rõ');
  expect(flow.input.adaptiveState.compact.coverage.global.impact.status).toBe('unknown');
  expect(getCompactNextStep(flow.input).state.functionalImpact).toBeNull();
});
