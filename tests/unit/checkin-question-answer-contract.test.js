'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { getCompactNextStep, resolveCompactQuestion, validateQuestion } = require('../../src/services/checkin/compact-interview.service');
const { buildAnswerContract, questionReviewAccepted, VERSION } = require('../../src/services/checkin/question-answer-contract.service');
const { approvedQuestionReview } = require('../fixtures/compact-interview');

const context = extra => ({ lang: 'vi', addressing: { honorific: 'bạn', selfRef: 'mình' }, previous_questions: [],
  required_options: [], bundled_details: true, eight_group_interview: true,
  target_concerns: [{ id: 'c1', label: 'Ngứa da' }], ...extra });
const encode = (field, question, labels) => JSON.stringify({ field, question, options: labels.map((label, i) => ({ id: `option_${i}`, label })) });

test.each([
  ['character', 'Bạn thấy ngứa cụ thể ở chỗ nào?', ['Châm chích', 'Nóng rát']],
  ['character', 'Bạn thấy da khó chịu như thế nào?', ['Từ sáng nay', 'Từ hôm qua']],
  ['associated', 'Ngoài những điều đã kể, bạn còn biểu hiện nào khác không?', ['Ngứa da', 'Nóng rát']],
])('blocks a structurally valid %s menu that answers the wrong dimension: %s', (field, question, labels) => {
  expect(validateQuestion(encode(field, question, labels), field, context())).toBeNull();
});

test('a prior-event question cannot re-label primary symptoms as the six source directions', () => {
  const options = ['chronic', 'medication', 'nutrition', 'activity', 'environment', 'acute_illness']
    .map((id, i) => ({ id, label: ['Ngứa da', 'Đau nhức', 'Tê bì', 'Nóng rát', 'Sưng tấy', 'Đầy bụng'][i] }));
  expect(validateQuestion(JSON.stringify({ field: 'source', question: 'Trước lúc ngứa, bạn có gặp việc gì khác thường không?', options }), 'source', context())).toBeNull();
});

test('a focused symptom menu can contain two distinct options, without a fixed count quota', () => {
  const value = encode('symptoms', 'Bạn đang thấy chỗ da đó khó chịu như thế nào?', ['Ngứa', 'Đỏ da']);
  expect(validateQuestion(value, 'symptoms', context({ symptom_choices_mode: 'patient_context' })).choices).toHaveLength(2);
});

function reviewFixture() {
  const c = context({ field: 'character', missing_details: [{ concern_id: 'c1', field: 'character' }] });
  c.answer_contract = buildAnswerContract(c);
  const question = { choices: [{ id: 'warm', label: 'Cảm giác nóng rát' }, { id: 'tingling', label: 'Cảm giác châm chích' }] };
  const verdict = JSON.parse(approvedQuestionReview({ prompt: JSON.stringify({ CONTEXT: c, QUESTION: question }) }).content);
  return { c, question, verdict };
}

test('a blanket AI valid=true is not evidence that every choice matches', () => {
  const { c, question } = reviewFixture();
  expect(questionReviewAccepted(question, { valid: true, errors: [] }, c)).toBe(false);
});
test.each(['answers_question', 'context_relevant', 'not_repeated'])('one rejected %s check rejects the whole visible menu', key => {
  const { c, question, verdict } = reviewFixture();
  verdict.choice_checks[1][key] = false;
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
});
test('missing or duplicate choice IDs cannot silently bypass semantic review', () => {
  const { c, question, verdict } = reviewFixture();
  verdict.choice_checks[1].id = verdict.choice_checks[0].id;
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
  verdict.choice_checks.pop();
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
});
test('an associated symptom is not approved as the sensation of an existing complaint', () => {
  const { c, question, verdict } = reviewFixture();
  verdict.choice_checks[1].answer_kind = 'associated_symptom';
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
});
test('a reviewer must check the actual question intent and return a boolean coverage decision', () => {
  const { c, question, verdict } = reviewFixture();
  verdict.question_focus = 'location';
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
  verdict.question_focus = 'sensation';
  verdict.ordinary_answers_covered = false;
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
  verdict.ordinary_answers_covered = ['warm', 'tingling'];
  expect(questionReviewAccepted(question, verdict, c)).toBe(false);
});
test('new regions and legitimate descriptions do not require a fixed symptom dictionary', () => {
  const { c, question, verdict } = reviewFixture();
  expect(questionReviewAccepted(question, verdict, c)).toBe(true);
  expect(validateQuestion(encode('character', 'Chỗ ngứa ở đâu trên da của bạn?', ['Mặt trong hai khuỷu tay', 'Sau hai vành tai']), 'character', context())).not.toBeNull();
});

test('a detachable permission preface does not leave a dangling yes/no suffix on a how question', () => {
  const value = encode('character', 'Bạn ơi, bạn có thể cho mình biết cảm giác đầy hơi của bạn như thế nào không ạ?', ['Bụng căng như đầy khí', 'Bụng nặng tức', 'Bụng chướng lên']);
  const accepted = validateQuestion(value, 'character', context());
  expect(accepted.question).toBe('Cảm giác đầy hơi của bạn như thế nào ạ?');
  expect(accepted.choices).toHaveLength(3);
});

test('an older unanswered symptom menu is regenerated once and then resumes its checked choices', async () => {
  const request = input(), base = getCompactNextStep(request);
  const old = { step: base.step, field: 'symptoms', question: 'Bạn khó chịu ở đâu?', origin: 'ai', targets: [], choices: [{ id: 'burning', label: 'Nóng rát' }] };
  base.compactAdaptive.compact.questions.push(old);
  callTextAi.mockImplementation(async params => {
    if (params.system.startsWith('Review one')) return approvedQuestionReview(params);
    const c = JSON.parse(params.prompt).CONTEXT;
    return { content: encode('symptoms', `${c.addressing.honorific[0].toUpperCase() + c.addressing.honorific.slice(1)} thấy bụng khó chịu như thế nào?`, ['Bụng căng', 'Buồn nôn', 'Đau bụng']) };
  });
  const next = await resolveCompactQuestion(base, request);
  expect(next.question).not.toBe(old.question);
  expect(next.questionSource).toBe('ai');
  expect(next.options).toContain('Buồn nôn');
  const calls = callTextAi.mock.calls.length;
  const replay = await resolveCompactQuestion(base, request);
  expect(replay.question).toBe(next.question);
  expect(replay.options).toEqual(next.options);
  expect(callTextAi).toHaveBeenCalledTimes(calls);
});

test('a failed old-menu refresh preserves stored state and never serves the old mismatched choices', async () => {
  const request = input(), base = getCompactNextStep(request);
  const old = { step: base.step, field: 'symptoms', question: 'Bạn khó chịu ở đâu?', origin: 'ai', targets: [], choices: [{ id: 'burning', label: 'Nóng rát' }] };
  base.compactAdaptive.compact.questions.push(old);
  callTextAi.mockRejectedValueOnce(new Error('synthetic unavailable'));
  await expect(resolveCompactQuestion(base, request)).rejects.toMatchObject({ code: 'CHECKIN_QUESTION_RETRY' });
  expect(base.compactAdaptive.compact.questions).toEqual([old]);
});

const input = () => ({ assessmentVersion: 3, interviewLayout: 'eight_groups', adaptiveEnabled: true, phase: 'initial', status: 'tired', lang: 'vi', profile: { age: 35, gender: 'Nam' }, healthContext: {}, bodyLocations: ['abdomen'], bodyLocationOther: 'Bụng', previousAnswers: [], adaptiveState: { version: 1, sources: [], questions: [] } });
beforeEach(() => jest.clearAllMocks());
test('regeneration receives the rejected answer set and exact review failures, then returns a checked matching menu', async () => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character'; base.coverageGoal = { field: 'character', targets: ['c1'] };
  base.state.compactAssessment.concerns = [{ id: 'c1', label: 'Đầy hơi', facts: {}, region: 'abdomen' }];
  base.state.compactAssessment.missing = [{ concern_id: 'c1', field: 'character' }];
  base.state.compactAssessment.missing_optional = [];
  let generations = 0, reviews = 0;
  callTextAi.mockImplementation(async params => {
    if (params.system.startsWith('Review one')) {
      const verdict = approvedQuestionReview(params);
      if (++reviews === 1) {
        const data = JSON.parse(verdict.content);
        data.valid = false; data.errors = ['Nausea is associated, not the character of bloating'];
        data.choice_checks[0].answers_question = false;
        return { content: JSON.stringify(data) };
      }
      return verdict;
    }
    const c = JSON.parse(params.prompt);
    const labels = ++generations === 1 ? ['Buồn nôn', 'Ợ chua', 'Đau bụng'] : ['Bụng căng như đầy khí', 'Bụng nặng và tức', 'Bụng chướng lên'];
    if (generations === 2) {
      expect(c.REJECTED_QUESTION.options[0].label).toBe('Buồn nôn');
      expect(c.CORRECTION.failed_choices[0].answers_question).toBe(false);
      expect(c.CONTEXT.answer_contract.focus).toBe('sensation');
    }
    return { content: encode('character', `Cảm giác đầy hơi ở bụng của ${c.CONTEXT.addressing.honorific} giống như thế nào?`, labels) };
  });
  const result = await resolveCompactQuestion(base, request);
  expect(result.questionSource).toBe('ai');
  expect(result.options).toContain('Bụng căng như đầy khí');
  expect(result.options).not.toContain('Buồn nôn');
  expect(base.compactAdaptive.compact.questions.at(-1)).toMatchObject({ answerContractVersion: VERSION, answerFocus: 'sensation' });
  expect(generations).toBe(2);
});

test('different missing details are not mixed into the same question or assigned to another complaint', () => {
  const contract = buildAnswerContract(context({ field: 'character', target_concerns: [{ id: 'c1', label: 'Ngứa' }, { id: 'c2', label: 'Đau đầu' }], missing_details: [
    { concern_id: 'c1', field: 'location' }, { concern_id: 'c2', field: 'character' },
  ] }));
  expect(contract).toMatchObject({ focus: 'location', target_ids: ['c1'] });
});

test('a transparent free-answer fallback does not repeat the complaint prefix twice', async () => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character'; base.coverageGoal = { field: 'character', targets: ['c1'] };
  base.state.compactAssessment.concerns = [{ id: 'c1', label: 'Đầy hơi', region: 'abdomen', facts: {} }];
  base.state.compactAssessment.missing = [{ concern_id: 'c1', field: 'character' }];
  base.state.compactAssessment.missing_optional = [];
  callTextAi.mockRejectedValue(new Error('synthetic unavailable'));
  const result = await resolveCompactQuestion(base, request);
  expect(result.questionSource).toBe('fallback');
  expect(result.question.match(/Đầy hơi/gu)).toHaveLength(1);
  expect(result.options).not.toContain('Buồn nôn');
});

test('owned warning/timeline/clinical statuses are preserved instead of randomized for variety', () => {
  for (const field of ['red_flags', 'timeline', 'clinical_context', 'clarify'])
    expect(buildAnswerContract(context({ field }))).toBeNull();
});
