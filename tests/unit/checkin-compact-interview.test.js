'use strict';
jest.mock('../../src/security/openbao-keyring.cjs', () => ({ keyringEnabled: () => false, keyringReady: () => true }));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/core/checkin/triage-ai-layer', () => ({
  ...jest.requireActual('../../src/core/checkin/triage-ai-layer'),
  classifySymptomSeverity: jest.fn().mockResolvedValue({ severity: 'mild' }),
  generateConclusion: jest.fn().mockResolvedValue({ summary: 'Recorded', recommendation: 'Monitor' }),
}));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { generateConclusion, classifySymptomSeverity } = require('../../src/core/checkin/triage-ai-layer');
const { selectEmpathyResponse } = require('../../src/core/checkin/illusion-layer');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { getCompactNextStep, validateCompactAnswers, validateQuestion, CODES } = require('../../src/services/checkin/compact-interview.service');
const { buildConclusionFacts } = require('../../src/core/checkin/triage-conclusion');
const { buildNarrativePrompt } = require('../../src/core/checkin/triage-conclusion-prompt');
const { readAdaptiveState, protectAdaptiveState } = require('../../src/services/checkin/adaptive-question.service');
const { providerResponse } = require('../fixtures/compact-interview');
// Compatibility regressions for already-offered compact v1 phases. New
// coverage-based phases are exercised independently in the coverage suite.
const empty = () => ({ version: 1, sources: [], questions: [], compact: { version: 1, lang: 'vi', hasConditions: false, questions: [] } });
const input = (extra = {}) => ({ assessmentVersion: 3, adaptiveEnabled: true, phase: 'initial', status: 'tired', lang: 'vi', profile: { age: 56, gender: 'Nam' }, bodyLocations: ['limbs'], bodyLocationOther: 'Tay chân: Khớp gối phải', previousAnswers: [], ...extra,
  adaptiveState: extra.adaptiveState || { ...empty(), compact: { ...empty().compact, hasConditions: Boolean(extra.healthContext?.medical_conditions?.length) } } });
beforeEach(() => { jest.clearAllMocks(); callTextAi.mockImplementation(providerResponse); });
async function interview(overrides = {}, answerOverrides = {}) {
  let state = empty(); state.compact.hasConditions = Boolean(overrides.healthContext?.medical_conditions?.length);
  const answers = []; const seen = [];
  for (let count = 0; count < 12; count++) {
    const result = await getNextTriageQuestion(input({ ...overrides, adaptiveState: state, previousAnswers: answers }));
    state = result._adaptiveState || state;
    if (result.isDone) return { result, state, answers, seen };
    seen.push(result);
    const defaults = { compact_symptoms: 'Sưng khớp, Nó bị đau đớn khó đi lại', compact_red_flags: 'Không có', compact_impact: 'Vẫn sinh hoạt bình thường', compact_onset: 'Từ 3 đến dưới 7 ngày', compact_progression: 'Vẫn như cũ', compact_character: 'Trông nó sưng tấy lên bước đi khó khăn', compact_clinical_context: 'Đã dùng thuốc theo hướng dẫn, Hôm nay chưa đo chỉ số', compact_source: 'Ngã hoặc vận động mạnh', compact_associated: 'Không có' };
    answers.push({ step: result.step, question: result.question, answer: answerOverrides[result.step] || defaults[result.step] });
  }
  throw new Error('Interview repeated instead of concluding');
}
test('reported swollen-joint free description remains one 8-question interview, with no second region', async () => {
  const { result, answers, seen } = await interview();
  expect(result.isDone).toBe(true);
  expect(answers.map((a) => a.step)).toEqual(['compact_symptoms', 'compact_red_flags', 'compact_impact', 'compact_onset', 'compact_progression', 'compact_character', 'compact_source', 'compact_associated']);
  expect(seen.every((q) => q.questionGroup.kind === 'topic')).toBe(true);
  expect(seen.every((q) => q.questionProgress.total === 8)).toBe(true);
  expect(new Set(seen.map((q) => q.question)).size).toBe(8);
  expect(callTextAi).toHaveBeenCalledTimes(16);
  expect(callTextAi.mock.calls.every(([p]) => p.provider === 'medgemma' && p.strictProvider)).toBe(true);
});
test('multiple areas share the same coverage and source is mandatory before conclusion', async () => {
  const { answers, state } = await interview({ bodyLocations: ['head', 'limbs'] }, { compact_symptoms: 'Nhức đầu, Sưng khớp' });
  expect(answers).toHaveLength(8);
  expect(answers.filter((a) => a.step.endsWith('onset'))).toHaveLength(1);
  const source = state.compact.questions.find((q) => q.field === 'source');
  expect(source.choices.map((c) => c.id)).toEqual(CODES.source);
  expect(answers.findIndex((a) => a.step === 'compact_source')).toBeLessThan(answers.length - 1);
});
test('chronic conditions add one context question, and all answers reach the conclusion', async () => {
  const { answers, result } = await interview({ healthContext: { medical_conditions: ['Tiểu đường', 'Tăng huyết áp'] } });
  expect(answers).toHaveLength(9);
  expect(answers.some((a) => a.step === 'compact_clinical_context')).toBe(true);
  const [state, profile, lang, , context] = generateConclusion.mock.calls[0];
  const facts = buildConclusionFacts(state, profile, context, lang);
  expect(facts.phien_hoi_gon).toMatchObject({ complete: true, causeIsUnconfirmed: true });
  expect(facts.phien_hoi_gon.answers.find((a) => a.group === 'source').answer).toBe('Ngã hoặc vận động mạnh');
  expect(facts.trieu_chung.join(' ')).not.toContain('Ngã hoặc');
  expect(buildNarrativePrompt(facts, lang)).toContain('KHÔNG xác nhận nguyên nhân');
  expect(result.recordedSymptoms.join(' ')).toContain('Sưng khớp');
});
test('resume returns the persisted AI question, without regenerating or adding a question', async () => {
  const first = await getNextTriageQuestion(input());
  const state = readAdaptiveState(97, protectAdaptiveState(97, first._adaptiveState));
  const replay = await getNextTriageQuestion(input({ adaptiveState: state }));
  expect(replay).toEqual(first);
  expect(callTextAi).toHaveBeenCalledTimes(2);
});
test('unknown source is accepted once and is not turned into a confirmed cause', async () => {
  const { answers, state } = await interview({}, { compact_source: 'Không rõ' });
  expect(answers).toHaveLength(8);
  expect(state.compact.questions.filter((q) => q.field === 'source')).toHaveLength(1);
  expect(generateConclusion.mock.calls[0][0].causesFound).toEqual([]);
});
test('an explicit onset and course in the symptom text are not asked a second time', async () => {
  const { answers } = await interview({}, { compact_symptoms: 'Sưng khớp từ hôm qua, vẫn như cũ' });
  expect(answers.some((a) => ['compact_onset', 'compact_progression'].includes(a.step))).toBe(false);
  expect(answers).toHaveLength(6);
});
test.each([
  'Đầy hơi sau ăn khoảng 30 phút',
  'Đau từng cơn, mỗi cơn kéo dài 5 phút',
  'Đau đầu khoảng 10 phút mỗi lần',
  'Không nhớ bắt đầu khi nào, không phải từ hôm qua',
  'Itching in episodes lasting 5 minutes',
])('episode duration or a denied date does not answer onset: %s', async (symptoms) => {
  const { answers } = await interview({}, { compact_symptoms: symptoms });
  expect(answers.filter((a) => a.step === 'compact_onset')).toHaveLength(1);
});
test.each(['Đau đầu 3 ngày rồi', 'Ngứa bắt đầu từ hôm qua', 'A headache since yesterday'])('an explicit reported start still skips a repeated onset: %s', async (symptoms) => {
  const { answers } = await interview({}, { compact_symptoms: symptoms });
  expect(answers.some((a) => a.step === 'compact_onset')).toBe(false);
});
test.each(['compact_onset', 'compact_source', 'compact_associated'])('free typed/spoken answer to %s stays in its group', async (step) => {
  const custom = 'Điều tôi muốn kể thêm nằm ở đây, không có trong lựa chọn';
  const { answers } = await interview({}, { [step]: custom });
  expect(answers.filter((a) => a.step === step)).toHaveLength(1);
  expect(generateConclusion.mock.calls[0][0].compactAssessment.answers.find((a) => a.group === step.slice(8)).answer).toBe(custom);
});
test('an unavailable Dr7 offers a transparent free input, never another AI provider', async () => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const first = await getNextTriageQuestion(input());
  expect(first).toMatchObject({ step: 'compact_symptoms', _fallback: true, questionSource: 'fallback', allowFreeText: true });
  expect(first.options).toEqual(['Không rõ', 'Khác, nhập hoặc nói câu trả lời']);
  const replay = await getNextTriageQuestion(input({ adaptiveState: first._adaptiveState }));
  expect(replay.question).toBe(first.question);
  expect(callTextAi).toHaveBeenCalledTimes(1);
});
test('a semantically rejected AI question is regenerated, then replaced by free input if still rejected', async () => {
  callTextAi.mockImplementation((p) => p.system.startsWith('Review one') ? { content: '{"valid":false,"errors":["answers do not match question"]}' } : providerResponse(p));
  const result = await getNextTriageQuestion(input());
  expect(result.questionSource).toBe('fallback');
  expect(callTextAi).toHaveBeenCalledTimes(6);
});
test('forged question text, repeated steps and out-of-order answers are rejected', async () => {
  const first = await getNextTriageQuestion(input());
  const a = { step: first.step, question: first.question, answer: 'Sưng khớp' };
  expect(() => validateCompactAnswers(first._adaptiveState, [{ ...a, question: 'forged' }])).toThrow();
  expect(() => validateCompactAnswers(first._adaptiveState, [a, a])).toThrow();
  expect(() => validateCompactAnswers(first._adaptiveState, [{ ...a, step: 'compact_source' }])).toThrow();
});
test('a selected red flag ends the interview for safety, without waiting for source screening', async () => {
  const first = await getNextTriageQuestion(input());
  const answers = [{ step: first.step, question: first.question, answer: 'Sưng khớp' }];
  const red = await getNextTriageQuestion(input({ adaptiveState: first._adaptiveState, previousAnswers: answers }));
  answers.push({ step: red.step, question: red.question, answer: red.options[0] });
  const result = await getNextTriageQuestion(input({ adaptiveState: red._adaptiveState, previousAnswers: answers }));
  expect(result).toMatchObject({ isDone: true, needsDoctor: true });
  expect(['high', 'emergency']).toContain(result.severity);
  expect(callTextAi).toHaveBeenCalledTimes(4);
});
test('functional dependence cannot receive a low-risk result', async () => {
  const { result } = await interview({}, { compact_impact: 'Có việc cần người giúp' });
  expect(result).toMatchObject({ severity: 'high', needsDoctor: true });
});
test('different area timelines in free text remain verbatim in conclusion facts', async () => {
  const answer = 'Đau đầu từ sáng, gối sưng 4 ngày rồi';
  await interview({ bodyLocations: ['head', 'limbs'] }, { compact_onset: answer });
  const state = generateConclusion.mock.calls[0][0];
  expect(state.compactAssessment.answers.find((a) => a.group === 'onset').answer).toBe(answer);
});
test('changing the profile during a phase does not reorder the offered coverage plan', async () => {
  const first = await getNextTriageQuestion(input());
  const changed = getCompactNextStep(input({ healthContext: { medical_conditions: ['Tiểu đường'] }, adaptiveState: first._adaptiveState }));
  expect(changed.compactAdaptive.compact.plan).not.toContain('clinical_context');
});
test.each([
  { question: 'Bụng: bạn đau ở đâu?' },
  { question: 'Anh/chị bị bệnh gì?' },
  { options: [{ id: 'normal', label: 'Cháu vẫn sinh hoạt bình thường' }, { id: 'slowed', label: 'Làm chậm hơn' }, { id: 'unable', label: 'Cần giúp đỡ' }] },
  { options: [{ id: 'normal', label: 'Không có' }, { id: 'slowed', label: 'Chậm hơn' }, { id: 'unable', label: 'Cần giúp đỡ' }] },
  { options: [{ id: 'normal', label: 'Uống thuốc 500 mg' }, { id: 'slowed', label: 'Chậm hơn' }, { id: 'unable', label: 'Cần giúp đỡ' }] },
])('rejects an unsuitable AI question/answer instead of rendering it: %j', (change) => {
  const context = { addressing: { honorific: 'chú' }, previous_questions: [], required_options: [] };
  const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'impact' } }) }).content);
  expect(validateQuestion(JSON.stringify({ ...valid, ...change }), 'impact', context)).toBeNull();
});
test('AI cannot omit a source direction, regardless of review approval', () => {
  const context = { addressing: { honorific: 'chú' }, previous_questions: [], required_options: [] };
  const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'source' } }) }).content);
  valid.options.pop();
  expect(validateQuestion(JSON.stringify(valid), 'source', context)).toBeNull();
});
test('swelling-specific warnings include inability to bear weight and stay positive evidence', async () => {
  const first = await getNextTriageQuestion(input());
  const answers = [{ step: first.step, question: first.question, answer: 'Sưng khớp' }];
  const red = await getNextTriageQuestion(input({ adaptiveState: first._adaptiveState, previousAnswers: answers }));
  const warning = red.options.find((option) => option.includes('không thể tì chân'));
  expect(warning).toBeDefined();
  answers.push({ step: red.step, question: red.question, answer: warning });
  const result = await getNextTriageQuestion(input({ adaptiveState: red._adaptiveState, previousAnswers: answers }));
  expect(result).toMatchObject({ isDone: true, needsDoctor: true });
  expect(['high', 'emergency']).toContain(result.severity);
});
test.each([
  [{ age: 23, gender: 'Nam' }, 'bạn', 'mình'],
  [{ age: 35, gender: 'Nam' }, 'anh', 'mình'],
  [{ age: 35, gender: 'Nữ' }, 'chị', 'mình'],
  [{ age: 56, gender: 'Nam' }, 'chú', 'cháu'],
  [{ age: 56, gender: 'Nữ' }, 'cô', 'cháu'],
  [{ age: 65 }, 'bác', 'cháu'],
  [{ age: 78, gender: 'Nam' }, 'ông', 'cháu'],
  [{ age: 78, gender: 'Nữ' }, 'bà', 'cháu'],
  [{}, 'bạn', 'mình'],
])('question generation uses one consistent age/gender address for %j', async (profile, honorific, selfRef) => {
  const result = await getNextTriageQuestion(input({ profile: { ...profile, full_name: 'Người Thử' } }));
  const context = JSON.parse(callTextAi.mock.calls[0][0].prompt).CONTEXT;
  expect(context.addressing).toEqual({ honorific, selfRef });
  expect(result.question).toContain(honorific);
  expect(result.question).not.toContain('Người Thử');
  expect(result.options.every((label) => !/^(?:Cháu|Mình|Tôi|Chú|Bác)\s/u.test(label))).toBe(true);
});
test.each(['Anh đang khó chịu thế nào?', 'Bác thấy khó chịu như thế nào?', 'Chú cho cháu hỏi về sinh hoạt nhé?', 'Chú có thể cho cháu biết sinh hoạt thế nào không?'])(
  'rejects wrong addressing or bureaucratic filler: %s', (question) => {
    const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
    const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'impact' } }) }).content);
    expect(validateQuestion(JSON.stringify({ ...valid, question }), 'impact', context)).toBeNull();
  }
);
test('ordinary symptom coverage is reviewed semantically rather than inferred from a fixed option count', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'symptoms' } }) }).content);
  valid.options = valid.options.slice(0, 2);
  const { buildAnswerContract, questionReviewAccepted } = require('../../src/services/checkin/question-answer-contract.service');
  context.answer_contract = buildAnswerContract({ ...context, field: 'symptoms' });
  const question = validateQuestion(JSON.stringify(valid), 'symptoms', context);
  expect(question).not.toBeNull();
  const review = JSON.parse(providerResponse({ system: 'Review one health intake', prompt: JSON.stringify({ CONTEXT: context, QUESTION: question }) }).content);
  expect(questionReviewAccepted(question, review, context)).toBe(true);
  review.ordinary_answers_covered = false;
  expect(questionReviewAccepted(question, review, context)).toBe(false);
});
test('mental wellbeing is not phrased as an anatomical body region', () => {
  const context = { lang: 'vi', addressing: { honorific: 'ông', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'symptoms' } }) }).content);
  expect(validateQuestion(JSON.stringify({ ...valid, question: 'Ông ơi, ở tinh thần ông cảm thấy khó chịu như thế nào?' }), 'symptoms', context)).toBeNull();
});
test('actual Vietnamese open-option IDs do not discard a valid sleep question or its visible answers', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [] };
  const content = { field: 'symptoms', question: 'Dạo này giấc ngủ của chị có những biểu hiện nào vậy?', options: [
    { id: 'khó ngủ', label: 'Khó ngủ' },
    { id: 'mất ngủ', label: 'Mất ngủ' },
    { id: 'ngủ không sâu giấc', label: 'Ngủ không sâu giấc' },
    { id: 'thức dậy nhiều lần trong đêm', label: 'Thức dậy nhiều lần trong đêm' },
    { id: 'ngủ quá nhiều', label: 'Ngủ quá nhiều' },
    { id: 'mệt mỏi tinh thần', label: 'Mệt mỏi tinh thần dù đã ngủ' },
  ] };
  const result = validateQuestion(JSON.stringify(content), 'symptoms', context);
  expect(result.choices.map((c) => c.label)).toEqual(content.options.map((c) => c.label));
  expect(result.choices.map((c) => c.id)).toEqual(['choice_1','choice_2','choice_3','choice_4','choice_5','choice_6']);
  content.options[0].id = '<script>bad</script>';
  expect(validateQuestion(JSON.stringify(content), 'symptoms', context)).toBeNull();
});
test('owned clinical IDs are never translated or remapped like open-choice handles', () => {
  const required = { id: 'warning_6', label: 'mất ngủ kèm sụt cân nhanh' };
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [required] };
  expect(validateQuestion(JSON.stringify({ field: 'red_flags', question: 'Chị có mất ngủ kèm sụt cân nhanh không?', options: [{ ...required, id: 'cảnh báo' }] }), 'red_flags', context)).toBeNull();
  const impact = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'impact' } }) }).content);
  impact.options[0].id = 'bình thường';
  expect(validateQuestion(JSON.stringify(impact), 'impact', context)).toBeNull();
});
test('new free-form associated information is included in safety classification', async () => {
  await interview({}, { compact_associated: 'Cảm giác lạ ở tai phải khi nằm xuống' });
  expect(classifySymptomSeverity).toHaveBeenCalledWith(expect.stringContaining('Cảm giác lạ ở tai phải khi nằm xuống'), expect.any(Object));
});
test.each(['nặng hơn', 'rất đau', 'đỡ hơn', 'vẫn như cũ'])('empathy for an older person keeps cháu and avoids false reassurance: %s', (answer) => {
  const result = selectEmpathyResponse({ answer }, { age: 56, gender: 'Nam' });
  expect(result.text).not.toMatch(/\bmình\b|yên tâm rồi|theo sát|hơi lo/iu);
});
test('generic absence variants do not create duplicate None choices', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const valid = { field: 'associated', question: 'Ngoài những điều vừa kể, chú còn thấy thay đổi nào khác không?',
    options: [{ id: 'fever', label: 'Có sốt' }, { id: 'sleep', label: 'Khó ngủ' }, { id: 'none', label: 'Không có thay đổi nào khác' }] };
  expect(validateQuestion(JSON.stringify(valid), 'associated', context).choices.map((c) => c.label)).toEqual(['Có sốt', 'Khó ngủ']);
});

test.each(['bạn', 'chú', 'cô', 'bác', 'ông', 'bà'])(
  'a second warning batch explicitly continues the screening instead of repeating its heading: %s',
  (honorific) => {
    const question = `${honorific} có đang gặp phải tình trạng nào sau đây không?`;
    const required = [{ id: 'warning_6', label: 'khó thở kèm yếu cơ' }];
    const context = { lang: 'vi', addressing: { honorific, selfRef: honorific === 'bạn' ? 'mình' : 'cháu' }, previous_questions: [question], required_options: required, warning_batch: { index: 2, total: 2, clarification: false } };
    const result = validateQuestion(JSON.stringify({ field: 'red_flags', question, options: required }), 'red_flags', context);
    expect(result.question).toBe(`Còn những dấu hiệu dưới đây thì sao, ${honorific} có gặp không?`);
    expect(result.choices).toEqual(required);
    const third = validateQuestion(JSON.stringify({ field: 'red_flags', question, options: required }), 'red_flags', { ...context, warning_batch: { index: 3, total: 3, clarification: false }, previous_questions: [question, result.question] });
    expect(third.question).not.toBe(result.question);
  }
);

test('English warning continuation keeps the exact warning and does not relabel a clarification as different signs', () => {
  const question = 'Are any of these signs happening now?';
  const required = [{ id: 'warning_6', label: 'Breathing difficulty with muscle weakness' }];
  const context = { lang: 'en', addressing: { honorific: 'you', selfRef: 'I' }, previous_questions: [question], required_options: required, warning_batch: { index: 2, total: 2, clarification: false } };
  const result = validateQuestion(JSON.stringify({ field: 'red_flags', question, options: required }), 'red_flags', context);
  expect(result.question).toMatch(/other warning signs/);
  expect(result.choices).toEqual(required);
  expect(validateQuestion(JSON.stringify({ field: 'red_flags', question, options: required }), 'red_flags', { ...context, warning_batch: { ...context.warning_batch, clarification: true } })).toBeNull();
});
test('Dr7 capitalisation alone does not force a duplicate warning generation or fallback', () => {
  const required = { id: 'warning_6', label: 'mất ngủ kèm sụt cân nhanh' };
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [required] };
  const content = { field: 'red_flags', question: 'Chị có đang mất ngủ kèm sụt cân nhanh không?', options: [{ ...required, label: 'Mất ngủ kèm sụt cân nhanh' }] };
  expect(validateQuestion(JSON.stringify(content), 'red_flags', context).choices).toEqual([required]);
  content.options[0].label = 'Mất ngủ kèm sụt cân từ từ';
  expect(validateQuestion(JSON.stringify(content), 'red_flags', context)).toBeNull();
  content.options[0] = { id: 'warning_0', label: 'Mất ngủ kèm sụt cân nhanh' };
  expect(validateQuestion(JSON.stringify(content), 'red_flags', context)).toBeNull();
});
test('a detachable permission preface before an otherwise complete warning question does not force regeneration', () => {
  const required = { id: 'warning_6', label: 'mất ngủ kèm sụt cân nhanh' };
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [required] };
  const content = { field: 'red_flags', question: 'Chị cho mình hỏi, ngoài việc khó ngủ thì chị có đang gặp phải những dấu hiệu nào sau đây không?', options: [required] };
  const accepted = validateQuestion(JSON.stringify(content), 'red_flags', context);
  expect(accepted.question).toBe('Ngoài việc khó ngủ thì chị có đang gặp phải những dấu hiệu nào sau đây không?');
  expect(accepted.choices).toEqual([required]);
  content.question = 'Chị cho mình hỏi về mất ngủ';
  expect(validateQuestion(JSON.stringify(content), 'red_flags', context)).toBeNull();
});
test('a question about character cannot ambiguously ask how often symptoms appear', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const content = { field: 'character', question: 'Cơn đau xuất hiện như thế nào?', options: [{ id: 'aching', label: 'Âm ỉ' }, { id: 'sharp', label: 'Nhói' }] };
  expect(validateQuestion(JSON.stringify(content), 'character', context)).toBeNull();
});
test.each(['null', '[]', '"a question"', '{bad'])('invalid JSON shapes fail closed without crashing: %s', (value) => {
  expect(validateQuestion(value, 'symptoms', {})).toBeNull();
});
test('removes only a repeated salutation while retaining the actual AI question and choices', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: ['Chú ơi, chỗ nào đang khó chịu?'], required_options: [] };
  const valid = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'impact' } }) }).content);
  valid.question = 'Chú ơi, những khó chịu này ảnh hưởng đến sinh hoạt như thế nào?';
  const accepted = validateQuestion(JSON.stringify(valid), 'impact', context);
  expect(accepted.question).toBe('Những khó chịu này ảnh hưởng đến sinh hoạt như thế nào?');
  expect(accepted.choices).toEqual(valid.options);
});
test('a detachable permission preface does not discard a complete useful question and its AI answers', () => {
  const context = { lang: 'vi', addressing: { honorific: 'bác', selfRef: 'cháu' }, previous_questions: ['Đã kể triệu chứng?'], required_options: [] };
  const content = { field: 'character', question: 'Bác cho cháu hỏi, cảm giác chóng mặt của bác giống kiểu nào ạ?',
    options: [{ id: 'spinning', label: 'Cảm giác mọi vật xung quanh quay cuồng' }, { id: 'unsteady', label: 'Cảm giác mất thăng bằng' }, { id: 'another', label: 'Cảm giác khác' }] };
  const accepted = validateQuestion(JSON.stringify(content), 'character', context);
  expect(accepted.question).toBe('Cảm giác chóng mặt của bác giống kiểu nào ạ?');
  expect(accepted.choices.map((c) => c.id)).toEqual(['spinning', 'unsteady']);
});
test.each([
  ['progression', 'better', 'Nặng hơn'],
  ['progression', 'worse', 'Đỡ hơn'],
  ['progression', 'better', 'Chưa đỡ hơn'],
  ['impact', 'normal', 'Có việc không tự làm được, cần người giúp'],
  ['impact', 'unable', 'Vẫn sinh hoạt bình thường'],
  ['onset', 'under_day', 'Từ 7 ngày trở lên'],
  ['onset', 'under_three_days', 'Từ 3 đến dưới 7 ngày'],
])('rejects an answer label that contradicts its processing code: %s/%s', (field, id, label) => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const value = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field } }) }).content);
  const previous = value.options.find((option) => option.id === id).label;
  const duplicate = value.options.find((option) => option.id !== id && option.label === label);
  if (duplicate) duplicate.label = previous;
  value.options.find((option) => option.id === id).label = label;
  expect(validateQuestion(JSON.stringify(value), field, context)).toBeNull();
});
test.each([
  ['Dưới 24 giờ', 'Từ 24 giờ đến dưới 3 ngày', 'Từ 3 đến dưới 7 ngày', 'Từ 7 ngày trở lên'],
  ['Dưới 1 ngày', 'Từ 1 đến dưới 3 ngày', 'Từ 3 ngày đến dưới 1 tuần', 'Từ 1 tuần trở lên'],
  ['Trong vòng 24 giờ qua', 'Từ 1 đến dưới 3 ngày trước', 'Từ 3 đến dưới 7 ngày trước', 'Từ 7 ngày trước trở lên'],
  ['Under 24 hours', 'From 1 to under 3 days', 'From 3 to under 7 days', '7 days or more'],
].map((labels) => [labels]))('accepts equivalent, non-overlapping onset units: %j', (labels) => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const content = { field: 'onset', question: 'Những khó chịu này bắt đầu từ khi nào?', options: CODES.onset.map((id, i) => ({ id, label: labels[i] })) };
  expect(validateQuestion(JSON.stringify(content), 'onset', context)).not.toBeNull();
});
test.each(['bạn', 'chú', 'cô', 'bác', 'ông', 'bà'])('onset uses a complete subject with the correct address %s, not a pasted symptom list', (honorific) => {
  const context = { lang: 'vi', addressing: { honorific, selfRef: honorific === 'bạn' ? 'mình' : 'cháu' }, previous_questions: [], required_options: [],
    target_concerns: [{ id: 'c1', label: 'Tê bì' }, { id: 'c2', label: 'đau nhức và sưng tấy ở tay chân' }] };
  const value = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'onset' } }) }).content);
  value.question = 'Tê bì, đau nhức và sưng tấy ở tay chân bắt đầu khi nào vậy?';
  expect(validateQuestion(JSON.stringify(value), 'onset', context)).toBeNull();
  value.question = `Tình trạng tê bì, đau nhức và sưng tấy ở tay chân của ${honorific} bắt đầu từ khi nào vậy?`;
  const accepted = validateQuestion(JSON.stringify(value), 'onset', context);
  expect(accepted.question).toBe(value.question);
  expect(accepted.choices).toEqual(value.options);
});
test.each([
  ['no_medication', 'Không uống thuốc (không có đơn/tự dừng)'],
  ['no_medication', 'Hôm nay quên uống thuốc'],
  ['medication_as_planned', 'Đã uống thuốc nhưng sai giờ'],
  ['medication_issue', 'Không có thuốc được kê'],
  ['reading_available', 'Chưa đo huyết áp hôm nay'],
  ['not_measured', 'Đã đo huyết áp hôm nay'],
  ['reading_available', 'Đã đo huyết áp, cháu sẽ hỏi chỉ số sau'],
])('clinical-context answers cannot mix incompatible situations or invent a later question: %s/%s', (id, label) => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const value = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'clinical_context' } }) }).content);
  value.options.find((option) => option.id === id).label = label;
  expect(validateQuestion(JSON.stringify(value), 'clinical_context', context)).toBeNull();
});
test('a measurement answer retains its fact without a detachable promise of a nonexistent later question', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const value = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'clinical_context' } }) }).content);
  value.options.find((option) => option.id === 'reading_available').label = 'Đã đo huyết áp (cháu sẽ hỏi chỉ số cụ thể sau)';
  expect(validateQuestion(JSON.stringify(value), 'clinical_context', context).choices.find((option) => option.id === 'reading_available').label).toBe('Đã đo huyết áp');
});
test('a measured-status answer keeps the patient report without an assistant request inside its label', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [] };
  const value = JSON.parse(providerResponse({ system: 'fixture', prompt: JSON.stringify({ CONTEXT: { ...context, field: 'clinical_context' } }) }).content);
  value.options.find((option) => option.id === 'reading_available').label = 'Đã đo (cho cháu xin kết quả, đơn vị và thời gian đo)';
  expect(validateQuestion(JSON.stringify(value), 'clinical_context', context).choices.find((option) => option.id === 'reading_available').label).toBe('Đã đo');
});
test('a partial glucose number without a unit cannot lead to a follow-up that asks only for the clock time', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chú', selfRef: 'cháu' }, previous_questions: [], required_options: [], numericInput: true, missing_measurement_unit: true, measurement_types: ['duong_huyet'] };
  const content = { field: 'measurements', question: 'Cháu thấy chú đã đo đường huyết là 6.4 rồi, vậy chú cho cháu biết chú đo lúc mấy giờ nhé?', options: [] };
  expect(validateQuestion(JSON.stringify(content), 'measurements', context)).toBeNull();
  content.question = 'Con số đường huyết chú vừa ghi dùng đơn vị gì ạ?';
  expect(validateQuestion(JSON.stringify(content), 'measurements', context).question).toBe(content.question);
  expect(validateQuestion(JSON.stringify({ ...content, question: 'Chú đo lúc mấy giờ ạ?' }), 'measurements', { ...context, missing_measurement_unit: false })).not.toBeNull();
});
test('an actual Dr7 sleep-quality question cannot accept dizziness examples mixed into its answer choices', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [], target_concerns: [{ label: 'khó ngủ' }] };
  const sleepChoices = [
    { id: 'difficulty_falling_asleep', label: 'Trằn trọc mãi không ngủ được' },
    { id: 'waking_up_frequently', label: 'Hay bị tỉnh giấc giữa đêm' },
    { id: 'waking_up_early', label: 'Thức dậy quá sớm và không ngủ lại được' },
  ];
  const content = { field: 'character', question: 'Cảm giác khó ngủ này cụ thể là như thế nào ạ?', options: [
    { id: 'spinning_surroundings', label: 'Cảm giác mọi vật xung quanh quay cuồng' },
    { id: 'faint_lightheaded', label: 'Cảm giác choáng váng, muốn xỉu' },
    { id: 'off_balance', label: 'Cảm giác mất thăng bằng, loạng choạng' },
    ...sleepChoices,
  ] };
  expect(validateQuestion(JSON.stringify(content), 'character', context)).toBeNull();
  expect(validateQuestion(JSON.stringify({ ...content, options: sleepChoices }), 'character', context).choices).toEqual(sleepChoices);
});
test('a semantic None variant does not create a second absence option', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [] };
  const content = { field: 'associated', question: 'Ngoài những điều đã kể, chị có thay đổi gì khác không?',
    options: [{ id: 'eating', label: 'Ăn uống kém hơn' }, { id: 'urine', label: 'Đi tiểu khác thường' }, { id: 'nothing', label: 'Không có gì khác lạ' }] };
  expect(validateQuestion(JSON.stringify(content), 'associated', context).choices.map((c) => c.id)).toEqual(['eating', 'urine']);
});
test('AI escape-option IDs do not create duplicate app-owned answers even with an unfamiliar paraphrase', () => {
  const context = { lang: 'vi', addressing: { honorific: 'chị', selfRef: 'mình' }, previous_questions: [], required_options: [] };
  const content = { field: 'associated', question: 'Ngoài những điều đã kể, chị có thay đổi gì khác không?',
    options: [{ id: 'eating', label: 'Ăn uống kém hơn' }, { id: 'urine', label: 'Đi tiểu khác thường' }, { id: 'none', label: 'Không có gì khác thường' }] };
  expect(validateQuestion(JSON.stringify(content), 'associated', context).choices.map((c) => c.id)).toEqual(['eating', 'urine']);
});
test('a rejected character question gets field-specific feedback instead of repeating the same mistake', async () => {
  callTextAi.mockImplementation((params) => {
    if (params.system.startsWith('Review one')) return providerResponse(params);
    const context = JSON.parse(params.prompt).CONTEXT;
    if (context.field !== 'character') return providerResponse(params);
    if (!JSON.parse(params.prompt).CORRECTION) return { content: JSON.stringify({ field: 'character', question: 'Chóng mặt thường kéo dài bao lâu mỗi lần?',
      options: [{ id: 'seconds', label: 'Vài giây' }, { id: 'minutes', label: 'Vài phút' }] }) };
    return { content: JSON.stringify({ field: 'character', question: 'Cảm giác chóng mặt giống kiểu nào vậy chú?',
      options: [{ id: 'spinning', label: 'Thấy mọi thứ quay tròn' }, { id: 'unsteady', label: 'Chao đảo, mất thăng bằng' }, { id: 'lightheaded', label: 'Choáng, lâng lâng' }] }) };
  });
  const { seen } = await interview({}, { compact_symptoms: 'Chóng mặt khi đứng lên' });
  const character = seen.find((q) => q.step === 'compact_character');
  expect(character.questionSource).toBe('ai');
  expect(character.options).toContain('Chao đảo, mất thăng bằng');
  const request = callTextAi.mock.calls.map(([params]) => params).find((params) => params.system.startsWith('You generate ONE') && JSON.parse(params.prompt).CONTEXT.field === 'character' && JSON.parse(params.prompt).CORRECTION);
  expect(JSON.parse(request.prompt).CORRECTION).toMatch(/character|feels|duration/iu);
});
test.each([
  ['Tôi vẫn sinh hoạt bình thường', 'low'],
  ['Tôi làm chậm hơn nhưng vẫn tự làm được', 'medium'],
  ['Tôi không tự làm được', 'high'],
])('typed functional answers influence severity too: %s', async (answer, expected) => {
  const { result } = await interview({}, { compact_impact: answer });
  expect(result.severity).toBe(expected);
});
