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

test('patient uncertainty remains in the conclusion gaps but does not become the next question again', () => {
  const contract = buildAnswerContract(context({ field: 'character', target_concerns: [{ id: 'c1', label: 'Ngứa' }, { id: 'c2', label: 'Đau đầu' }], missing_details: [
    { concern_id: 'c1', field: 'character', status: 'unknown' },
    { concern_id: 'c1', field: 'location', status: 'missing' },
    { concern_id: 'c2', field: 'location', status: 'unknown' },
  ] }));
  expect(contract).toMatchObject({ focus: 'location', detail_field: 'location', target_ids: ['c1'] });
});

test.each([false, true])('the next question skips a previously unknown detail, including fallback=%s', async fallback => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character'; base.coverageGoal = { field: 'character', targets: ['c1'] };
  base.state.compactAssessment.concerns = [{ id: 'c1', label: 'Ngứa da', region: 'skin', facts: { character: { value: 'Không rõ', status: 'unknown' } } }];
  base.state.compactAssessment.missing = [{ concern_id: 'c1', field: 'character', status: 'unknown' }, { concern_id: 'c1', field: 'location', status: 'missing' }];
  base.state.compactAssessment.missing_optional = [];
  callTextAi.mockImplementation(async params => {
    if (fallback) throw new Error('Synthetic provider unavailable');
    if (params.system.startsWith('Review one')) return approvedQuestionReview(params);
    return { content: encode('character', 'Chỗ ngứa cụ thể nằm ở đâu?', ['Ở cẳng chân', 'Ở bàn tay']) };
  });
  const result = await resolveCompactQuestion(base, request);
  expect(result.questionSource).toBe(fallback ? 'fallback' : 'ai');
  expect(result.question).toMatch(/ở đâu/iu);
  expect(base.compactAdaptive.compact.questions.at(-1).answerDetailField).toBe('location');
  if (!fallback) {
    const generation = callTextAi.mock.calls.find(([p]) => p.system.startsWith('You generate ONE'))[0];
    expect(JSON.parse(generation.prompt).CONTEXT.answer_contract.focus).toBe('location');
  }
});

test.each(['character', 'impact'])('a provider following the documented %s review schema can approve a matching menu on its first attempt', async field => {
  const request = { ...input(), bodyLocations: ['skin'] }, base = getCompactNextStep(request);
  base.field = field; base.step = `compact_${field}`; base.coverageGoal = { field, targets: ['c1'] };
  base.state.compactAssessment.concerns = [{ id: 'c1', label: 'Ngứa da', facts: {}, region: 'skin' }];
  base.state.compactAssessment.missing = [{ concern_id: 'c1', field: 'character' }];
  base.state.compactAssessment.missing_optional = [];
  let generations = 0;
  callTextAi.mockImplementation(async params => {
    if (!params.system.startsWith('Review one')) {
      generations++;
      if (field === 'character') {
        expect(params.system).not.toContain('Combine closely related details');
        return { content: encode(field, 'Chỗ ngứa có cảm giác thế nào vậy?', ['Ngứa râm ran', 'Ngứa châm chích']) };
      }
      return { content: JSON.stringify({ field, question: 'Ngứa da ảnh hưởng thế nào đến các việc hằng ngày?', options: [
        { id: 'unchanged', label: 'Vẫn làm các việc như mọi khi', impact_code: 'normal' },
        { id: 'pause', label: 'Phải dừng việc để gãi', impact_code: 'slowed' },
      ] }) };
    }
    // Simulate a provider following the last output schema it was given.
    // A later two-key schema used to discard mandatory per-choice checks.
    const schemas = [...params.system.matchAll(/(?:Return ONE JSON object with this EXACT schema:|Return JSON) (\{[^\n]*?\})\./gu)];
    expect(schemas).toHaveLength(1);
    const template = JSON.parse(schemas.at(-1)[1].replaceAll('true|false', 'true'));
    const approved = JSON.parse(approvedQuestionReview(params).content);
    if (field === 'impact') approved.impact_codes = [
      { id: 'unchanged', code: 'normal' }, { id: 'pause', code: 'slowed' },
    ];
    return { content: JSON.stringify(Object.fromEntries(Object.keys(template).map(key => [key, approved[key]]))) };
  });
  const result = await resolveCompactQuestion(base, request);
  expect(result.questionSource).toBe('ai');
  expect(generations).toBe(1);
});

test.each([
  ['location', [{ id: 'c1', label: 'Chóng mặt', region: 'head', facts: {} }]],
  ['pattern', [{ id: 'c1', label: 'Chóng mặt', region: 'head', facts: {} }]],
  ['location', [{ id: 'c1', label: 'Ngứa da', region: 'skin', facts: {} }, { id: 'c2', label: 'Chóng mặt', region: 'head', facts: {} }]],
  ['character', [{ id: 'c1', label: 'Chóng mặt', region: 'head', facts: {} }]],
])('a %s question receives symptom-specific instructions only when its focus and owner match', async (detail, concerns) => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character';
  base.coverageGoal = { field: 'character', targets: concerns.map(c => c.id) };
  base.state.compactAssessment.concerns = concerns;
  base.state.compactAssessment.missing = [
    { concern_id: 'c1', field: detail },
    ...(concerns.length > 1 ? [{ concern_id: 'c2', field: 'character' }] : []),
  ];
  base.state.compactAssessment.missing_optional = [];
  callTextAi.mockImplementation(async params => {
    if (params.system.startsWith('Review one')) return approvedQuestionReview(params);
    const c = JSON.parse(params.prompt).CONTEXT;
    const question = detail === 'location' ? `${c.addressing.honorific} thấy khó chịu cụ thể ở đâu?`
      : detail === 'pattern' ? 'Cảm giác này xảy ra liên tục hay từng đợt?' : 'Cảm giác chóng mặt này giống như thế nào?';
    return { content: encode('character', question,
      detail === 'location' ? ['Ở trán', 'Ở phía sau đầu'] : detail === 'pattern' ? ['Liên tục', 'Từng đợt'] : ['Cảm giác như quay cuồng', 'Cảm giác chòng chành']) };
  });
  const result = await resolveCompactQuestion(base, request);
  const generation = callTextAi.mock.calls.find(([p]) => p.system.startsWith('You generate ONE'))[0];
  const c = JSON.parse(generation.prompt).CONTEXT;
  expect(c.answer_contract.detail_field).toBe(detail);
  expect(generation.system.includes('For this reported dizziness, clarify the sensation')).toBe(detail === 'character');
  expect(result.questionSource).toBe('ai');
});

test('an actual symptom measurement requests a user reading instead of an invented numeric menu', async () => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character'; base.coverageGoal = { field: 'character', targets: ['c1'] };
  base.state.compactAssessment.concerns = [{ id: 'c1', label: 'Sốt', region: null, facts: {} }];
  base.state.compactAssessment.missing = [{ concern_id: 'c1', field: 'measurement' }];
  base.state.compactAssessment.missing_optional = [];
  callTextAi.mockImplementation(async params => params.system.startsWith('Review one')
    ? approvedQuestionReview(params)
    : { content: encode('character', 'Nhiệt kế hiện bao nhiêu độ vậy?', []) });
  const result = await resolveCompactQuestion(base, request);
  const generation = callTextAi.mock.calls.find(([p]) => p.system.startsWith('You generate ONE'))[0];
  expect(JSON.parse(generation.prompt).CONTEXT.numericInput).toBe(true);
  expect(generation.system).toContain('Return zero ordinary numeric choices');
  const review = callTextAi.mock.calls.find(([p]) => p.system.startsWith('Review one'))[0];
  expect(review.system).toContain('Zero ordinary numeric choices is REQUIRED');
  expect(review.system).not.toContain('Reject a narrow list that omits ordinary likely answers');
  expect(result.questionSource).toBe('ai');
  expect(result.allowFreeText).toBe(true);
});

test('a grouped clinical question with ten owned statuses is not limited to an eight-choice menu', async () => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'clinical_context'; base.step = 'compact_clinical_context';
  base.coverageGoal = { field: 'clinical_context', targets: [], clinicalParts: ['medication_today', 'measurements_today'],
    measurementTypes: ['huyet_ap', 'duong_huyet'], requiredCodes: [
      'medication_as_planned', 'medication_issue', 'no_medication', 'medication_unknown',
      'huyet_ap_reading_available', 'huyet_ap_not_measured', 'huyet_ap_reading_unknown',
      'duong_huyet_reading_available', 'duong_huyet_not_measured', 'duong_huyet_reading_unknown',
    ] };
  callTextAi.mockImplementation(async params => {
    if (params.system.startsWith('Review one')) return approvedQuestionReview(params);
    const c = JSON.parse(params.prompt).CONTEXT;
    return { content: JSON.stringify({ field: c.field, question: `Hôm nay ${c.addressing.honorific} dùng thuốc và đo chỉ số như thế nào?`, options: c.required_options }) };
  });
  const result = await resolveCompactQuestion(base, request);
  const generation = callTextAi.mock.calls.find(([p]) => p.system.startsWith('You generate ONE'))[0];
  const c = JSON.parse(generation.prompt).CONTEXT;
  expect(c.required_options).toHaveLength(10);
  expect(generation.system).not.toContain('2-8 for readability');
  expect(result.questionSource).toBe('ai');
  for (const choice of c.required_options) expect(result.options).toContain(choice.label);
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

test('a fallback detail question names and updates only the complaints missing that same detail', async () => {
  const request = input(), base = getCompactNextStep(request);
  base.field = 'character'; base.step = 'compact_character'; base.coverageGoal = { field: 'character', targets: ['c1', 'c2'], shared: true };
  base.state.compactAssessment.concerns = [
    { id: 'c1', label: 'Ngứa da', region: 'skin', facts: {} },
    { id: 'c2', label: 'Đau nhức', region: 'limbs', facts: {} },
  ];
  base.state.compactAssessment.missing = [
    { concern_id: 'c1', field: 'character', status: 'missing' },
    { concern_id: 'c2', field: 'location', status: 'missing' },
  ];
  base.state.compactAssessment.missing_optional = [];
  callTextAi.mockRejectedValue(new Error('Synthetic provider unavailable'));
  const result = await resolveCompactQuestion(base, request);
  const question = base.compactAdaptive.compact.questions.at(-1);
  expect(result.questionSource).toBe('fallback');
  expect(question.targets).toEqual(['c1']);
  expect(question.answerDetailField).toBe('character');
  expect(result.question).toContain('Ngứa da');
  expect(result.question).not.toContain('Đau nhức');
});

test('owned warning/timeline/clinical statuses are preserved instead of randomized for variety', () => {
  for (const field of ['red_flags', 'timeline', 'clinical_context', 'clarify'])
    expect(buildAnswerContract(context({ field }))).toBeNull();
});
