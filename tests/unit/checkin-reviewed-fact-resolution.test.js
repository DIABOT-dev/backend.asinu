'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { initialize, refreshCoverage, coverageGoal, coverageFacts } = require('../../src/services/checkin/compact-coverage.service');

function scene() {
  const compact = { version: 2, layout: 'eight_groups', lang: 'vi', hasConditions: false, questions: [] };
  const ledger = initialize(compact);
  ledger.concerns.push({ id: 'c1', label: 'Ngứa da', region: 'skin', detailFields: [], facts: {
    progression: { value: 'Vẫn như cũ', status: 'reported', code: 'same' },
  } });
  ledger.global.symptoms = { value: 'Ngứa da', status: 'reported' };
  ledger.global.impact = { value: 'Vẫn sinh hoạt bình thường', status: 'reported', code: 'normal' };
  const input = { lang: 'vi', bodyLocations: ['skin'], previousAnswers: [], healthContext: {}, profile: {} };
  let extraction;
  callTextAi.mockImplementation(async params => params.system.startsWith('Review patient fact')
    ? { content: '{"valid":true,"errors":[]}' }
    : { content: JSON.stringify(extraction) });
  async function reply(question, answer, parsed) {
    compact.questions.push(question);
    input.previousAnswers.push({ step: question.step, question: question.question, answer });
    extraction = { new_concerns: [], facts: [], ...parsed };
    await refreshCoverage(compact, input);
  }
  return { compact, ledger, input, reply };
}
beforeEach(() => callTextAi.mockReset());

test('the actual Dr7 mixed uncertainty response preserves unknown onset and known course without asking onset again', async () => {
  const fixture = require('../fixtures/checkin-dr7-mixed-uncertainty.json');
  const s = scene();
  s.ledger.concerns[0].facts = {};
  callTextAi.mockImplementation(async params => ({ content: JSON.stringify(params.system.startsWith('Review patient fact')
    ? fixture.review : fixture.extraction) }));
  const question = { field: 'timeline', step: 'compact_timeline', layout: 'eight_groups', targets: ['c1'],
    timelineFields: ['onset', 'progression'], question: 'Ngứa bắt đầu khi nào và thay đổi thế nào?', choices: [] };
  await s.reply(question, fixture.answer, fixture.extraction);
  expect(s.ledger.concerns[0].facts.onset).toMatchObject({ value: 'Tôi không nhớ bắt đầu khi nào', status: 'unknown' });
  expect(s.ledger.concerns[0].facts.progression).toMatchObject({ code: 'same', status: 'reported' });
  expect(s.ledger.global.impact).toMatchObject({ code: 'normal', status: 'reported' });
  expect(coverageFacts(s.compact).missing).toContainEqual(expect.objectContaining({ concern_id: 'c1', field: 'onset', status: 'unknown' }));
  expect(coverageGoal(s.compact, [], s.input)?.field).toBe('source');
});

test.each([
  ['không nhớ', 'unknown'],
  ['Tôi không nhớ bắt đầu khi nào', 'unknown'],
  ['Cháu không biết thời điểm bắt đầu', 'unknown'],
  ['không nhớ chính xác bắt đầu từ lúc nào', 'unknown'],
  ["I don't remember when it started", 'unknown'],
  ['I do not know the onset time', 'unknown'],
  ['Tôi không nhớ chính xác nhưng ngứa từ tối qua', 'reported'],
  ["I don't remember exactly but it started yesterday", 'reported'],
])('an extracted onset report retains its actual knowledge state: %s', async (value, status) => {
  const s = scene();
  await s.reply({ field: 'associated', step: 'compact_associated', layout: 'eight_groups', targets: [], choices: [], question: 'Còn thay đổi nào khác?' }, `Về lúc bắt đầu thì ${value}`, {
    facts: [{ concern_id: 'c1', field: 'onset', value, quote: value, answer_index: 0 }], global_answer: { relevant: false },
  });
  expect(s.ledger.concerns[0].facts.onset).toMatchObject({ value, status });
});

test('an explicit unknown fact cannot carry an invented worsening code into the conclusion', async () => {
  const s = scene(), value = 'không rõ';
  s.ledger.concerns[0].facts = {};
  await s.reply({ field: 'associated', step: 'compact_associated', layout: 'eight_groups', targets: [], choices: [], question: 'Còn thay đổi nào khác?' }, `Diễn biến thì ${value}`, {
    facts: [{ concern_id: 'c1', field: 'progression', value, quote: value, code: 'worse', answer_index: 0 }], global_answer: { relevant: false },
  });
  expect(s.ledger.concerns[0].facts.progression).toMatchObject({ value, status: 'unknown' });
  expect(s.ledger.concerns[0].facts.progression.code).toBeUndefined();
});

test('repeated unrelated answers to one focused detail do not waive another detail that has not been asked', async () => {
  const s = scene();
  s.ledger.concerns[0].detailFields = ['character', 'location'];
  const question = { field: 'character', step: 'compact_character', layout: 'eight_groups', targets: ['c1'],
    question: 'Chỗ ngứa có cảm giác như thế nào?', answerFocus: 'sensation', answerDetailField: 'character', choices: [] };
  await s.reply(question, 'Tôi đang cầm điện thoại', { global_answer: { relevant: false } });
  expect(s.ledger.concerns[0].facts).not.toHaveProperty('location');
  await s.reply({ ...question, step: 'compact_character_q2' }, 'Tôi vừa mở ứng dụng', { global_answer: { relevant: false } });
  expect(s.ledger.concerns[0].facts.character.status).toBe('unknown');
  expect(s.ledger.concerns[0].facts).not.toHaveProperty('location');
});

test('a first unanswered location is not treated as its second clarification merely because sensation was already asked', async () => {
  const s = scene();
  s.ledger.concerns[0].detailFields = ['character', 'location'];
  await s.reply({ field: 'character', step: 'compact_character', layout: 'eight_groups', targets: ['c1'],
    question: 'Cảm giác ngứa thế nào?', answerDetailField: 'character', choices: [] }, 'Ngứa như kiến bò', {
    facts: [{ concern_id: 'c1', field: 'character', value: 'như kiến bò', quote: 'như kiến bò', answer_index: 0 }], global_answer: { relevant: true, quote: 'Ngứa như kiến bò' },
  });
  await s.reply({ field: 'character', step: 'compact_character_q2', layout: 'eight_groups', targets: ['c1'],
    question: 'Chỗ ngứa cụ thể ở đâu?', answerDetailField: 'location', choices: [] }, 'Tôi đang cầm điện thoại', { global_answer: { relevant: false } });
  expect(s.ledger.concerns[0].facts.location.status).toBe('unresolved');
  expect(s.ledger.concerns[0].facts.character).toMatchObject({ status: 'reported', value: 'như kiến bò' });
});

test('partial progress and repeated network submissions do not consume another complaint’s clarification attempts', async () => {
  const s = scene();
  s.ledger.concerns[0].detailFields = ['character'];
  s.ledger.concerns.push({ id: 'c2', label: 'Ngứa tay', region: 'skin', detailFields: ['character'], facts: {} });
  const question = { field: 'character', step: 'compact_character', layout: 'eight_groups', targets: ['c1', 'c2'],
    question: 'Các chỗ ngứa có cảm giác thế nào?', answerDetailField: 'character', choices: [] };
  await s.reply(question, 'Da chân ngứa như kiến bò', { facts: [
    { concern_id: 'c1', field: 'character', value: 'như kiến bò', quote: 'như kiến bò', answer_index: 0 },
  ], global_answer: { relevant: true, quote: 'Da chân ngứa như kiến bò' } });
  expect(s.ledger.concerns[1].facts.character.status).toBe('unresolved');
  await s.reply({ ...question, step: 'compact_character_q2', targets: ['c2'] }, 'Tôi đang cầm điện thoại', { global_answer: { relevant: false } });
  expect(s.ledger.concerns[1].facts.character.status).toBe('unresolved');
  await refreshCoverage(s.compact, s.input);
  expect(s.ledger.concerns[1].facts.character.status).toBe('unresolved');
  await s.reply({ ...question, step: 'compact_character_q3', targets: ['c2'] }, 'Tôi vừa mở ứng dụng', { global_answer: { relevant: false } });
  expect(s.ledger.concerns[1].facts.character.status).toBe('unknown');
  expect(s.ledger.concerns[0].facts.character).toMatchObject({ status: 'reported', value: 'như kiến bò' });
});

test.each([
  ['sensation', 'character'],
  ['measured_value', 'measurement'],
  [undefined, 'character'],
])('an unknown answer to a focused %s question does not mark an unasked location as unknown', async (focus, field) => {
  const s = scene();
  s.ledger.concerns[0].detailFields = [field, 'location'];
  const question = { field: 'character', step: 'compact_character', layout: 'eight_groups', targets: ['c1'],
    question: field === 'measurement' ? 'Máy hiện kết quả bao nhiêu vậy?' : 'Chỗ ngứa có cảm giác như thế nào?',
    ...(focus ? { answerContractVersion: 1, answerFocus: focus }
      : { origin: 'fallback', answerDetailField: field }), choices: [] };
  await s.reply(question, 'Không rõ', {});
  expect(s.ledger.concerns[0].facts[field]).toMatchObject({ status: 'unknown', value: 'Không rõ' });
  expect(s.ledger.concerns[0].facts).not.toHaveProperty('location');
});

test('identically named complaints in different regions keep their own timeline and location', async () => {
  const s = scene();
  s.ledger.concerns = [];
  s.input.bodyLocations = ['head', 'abdomen'];
  const answer = 'Tôi đau ở đầu từ hôm qua và đau ở bụng sáng nay';
  await s.reply({ field: 'symptoms', step: 'compact_symptoms', question: 'Bạn đang thấy khó chịu thế nào?',
    layout: 'eight_groups', targets: [], choices: [] }, answer, {
    new_concerns: [
      { id: 'new_1', label: 'đau', quote: 'đau ở đầu từ hôm qua', region: 'head', detail_fields: ['location'] },
      { id: 'new_2', label: 'đau', quote: 'đau ở bụng sáng nay', region: 'abdomen', detail_fields: ['location'] },
    ],
    facts: [
      { concern_id: 'new_1', field: 'onset', value: 'từ hôm qua', quote: 'đau ở đầu từ hôm qua' },
      { concern_id: 'new_1', field: 'location', value: 'ở đầu', quote: 'đau ở đầu từ hôm qua' },
      { concern_id: 'new_2', field: 'onset', value: 'sáng nay', quote: 'đau ở bụng sáng nay' },
      { concern_id: 'new_2', field: 'location', value: 'ở bụng', quote: 'đau ở bụng sáng nay' },
    ],
  });
  expect(s.ledger.concerns).toHaveLength(2);
  expect(s.ledger.concerns.find(c => c.region === 'head').facts).toMatchObject({ onset: { value: 'từ hôm qua' }, location: { value: 'ở đầu' } });
  expect(s.ledger.concerns.find(c => c.region === 'abdomen').facts).toMatchObject({ onset: { value: 'sáng nay' }, location: { value: 'ở bụng' } });
});

test('an offered complaint without a region is enriched by its unambiguous reviewed location', async () => {
  const s = scene();
  s.ledger.concerns = [];
  s.input.bodyLocations = ['skin'];
  await s.reply({ field: 'symptoms', step: 'compact_symptoms', question: 'Bạn thấy khó chịu như thế nào?',
    layout: 'eight_groups', targets: [], choices: [{ id: 'itch', label: 'Ngứa da' }] }, 'Ngứa da', {
    new_concerns: [{ id: 'new_1', label: 'Ngứa da', quote: 'Ngứa da', region: 'skin', detail_fields: ['location'] }],
  });
  expect(s.ledger.concerns).toHaveLength(1);
  expect(s.ledger.concerns[0]).toMatchObject({ label: 'Ngứa da', region: 'skin' });
});

test.each(['limbs', null])('distinct reviewed complaint IDs in the same broad region (%s) are not deduplicated by their name', async region => {
  const s = scene();
  s.ledger.concerns = [];
  s.input.bodyLocations = ['limbs'];
  await s.reply({ field: 'symptoms', step: 'compact_symptoms', question: 'Bạn thấy khó chịu như thế nào?',
    layout: 'eight_groups', targets: [], choices: [{ id: 'pain', label: 'đau', region }] }, 'đau, Tôi đau ở gối trái từ hôm qua, đau ở cổ chân phải sáng nay', {
    new_concerns: [
      { id: 'new_1', label: 'đau', quote: 'đau ở gối trái từ hôm qua', region, detail_fields: ['location'] },
      { id: 'new_2', label: 'đau', quote: 'đau ở cổ chân phải sáng nay', region, detail_fields: ['location'] },
    ],
    facts: [
      { concern_id: 'new_1', field: 'location', value: 'ở gối trái', quote: 'đau ở gối trái từ hôm qua' },
      { concern_id: 'new_2', field: 'location', value: 'ở cổ chân phải', quote: 'đau ở cổ chân phải sáng nay' },
    ],
  });
  expect(s.ledger.concerns).toHaveLength(2);
  expect(s.ledger.concerns.map(c => c.facts.location.value)).toEqual(['ở gối trái', 'ở cổ chân phải']);
});

test.each([
  ['onset', 'Từ hôm qua', undefined],
  ['progression', 'Vẫn như cũ', 'same'],
])('a reviewed repeated %s answer resolves its earlier unread fact and advances the interview', async (field, value, code) => {
  const s = scene();
  s.ledger.concerns[0].facts = field === 'onset'
    ? { progression: { value: 'Vẫn như cũ', status: 'reported', code: 'same' } }
    : { onset: { value: 'Từ hôm qua', status: 'reported' } };
  const question = { field: 'timeline', step: 'compact_timeline', question: 'Tình trạng này bắt đầu từ khi nào, và thay đổi ra sao?',
    layout: 'eight_groups', targets: ['c1'], timelineFields: [field], choices: [] };
  await s.reply(question, value, { global_answer: { relevant: false } });
  expect(s.ledger.concerns[0].facts[field].status).toBe('unresolved');
  await s.reply({ ...question, step: 'compact_timeline_q2', question: 'Mình xác nhận lại phần thời gian này nhé?' }, value, {
    facts: [{ concern_id: 'c1', field, value, quote: value, answer_index: 1, ...(code ? { code } : {}) }],
  });
  expect(s.ledger.concerns[0].facts[field]).toMatchObject({ value, status: 'reported', evidence: { answerIndex: 1, quote: value } });
  expect(coverageGoal(s.compact, [], s.input)?.field).toBe('source');
});

test('an early reviewed source event resolves the identical earlier unread report even when supplied in another answer', async () => {
  const s = scene(), value = 'Tôi đã ở ngoài nắng trước khi ngứa';
  s.ledger.global.source = { value, status: 'unresolved', evidence: { answerIndex: 0, quote: value } };
  const question = { field: 'associated', step: 'compact_associated', question: 'Ngoài ngứa, bạn còn thấy thay đổi gì không?',
    layout: 'eight_groups', targets: [], choices: [] };
  await s.reply(question, value, { shared_facts: [{ field: 'source', code: 'environment', value, quote: value, answer_index: 0 }], global_answer: { relevant: false } });
  expect(s.ledger.global.source).toMatchObject({ status: 'reported', code: 'environment', value });
});

test('repeated natural symptom updates retain a flat history instead of resending exponentially nested copies', async () => {
  const s = scene();
  for (let index = 0; index < 12; index++) {
    const value = `Ngứa râm ran ở cẳng chân, mô tả lần ${index + 1}`;
    await s.reply({ field: 'associated', step: `compact_associated_q${index + 1}`, question: 'Bạn còn thay đổi gì khác không?',
      layout: 'eight_groups', targets: [], choices: [] }, value, {
      facts: [{ concern_id: 'c1', field: 'character', value, quote: value, answer_index: index }],
      global_answer: { relevant: false },
    });
  }
  const current = s.ledger.concerns[0].facts.character;
  expect(JSON.stringify(current).length).toBeLessThan(6000);
  expect(current.history).toHaveLength(11);
  expect(current.history.every(item => !Object.hasOwn(item, 'history'))).toBe(true);
  expect(current.history.map(item => item.value)).toEqual(Array.from({ length: 11 }, (_, i) => `Ngứa râm ran ở cẳng chân, mô tả lần ${i + 1}`));
});

test('a genuine change in reported course still requires clarification instead of being overwritten', async () => {
  const s = scene(), value = 'Ngày càng nặng hơn';
  await s.reply({ field: 'associated', step: 'compact_associated', question: 'Bạn còn thấy thay đổi gì khác?', layout: 'eight_groups', targets: [], choices: [] }, value, {
    facts: [{ concern_id: 'c1', field: 'progression', code: 'worse', value, quote: value, answer_index: 0 }],
    global_answer: { relevant: false },
  });
  expect(s.ledger.concerns[0].facts.progression).toMatchObject({ status: 'conflicting', code: 'same', alternatives: [{ code: 'worse' }] });
  expect(coverageGoal(s.compact, [], s.input)).toMatchObject({ field: 'clarify', conflict: { concernId: 'c1', field: 'progression' } });
});

test('a new clear report replaces an earlier unresolved conflict without treating uncertainty as a confirmed old answer', async () => {
  const s = scene(), value = 'Ngày càng nặng hơn';
  s.ledger.concerns[0].facts.progression = { value: 'Vẫn như cũ', code: 'same', status: 'unknown', clarified: true };
  await s.reply({ field: 'associated', step: 'compact_associated', layout: 'eight_groups', targets: [], choices: [], question: 'Còn điều gì khác?' }, value, {
    facts: [{ concern_id: 'c1', field: 'progression', value, code: 'worse', quote: value, answer_index: 0 }], global_answer: { relevant: false },
  });
  expect(s.ledger.concerns[0].facts.progression).toMatchObject({ status: 'reported', code: 'worse', value });
  expect(s.ledger.concerns[0].facts.progression.clarified).not.toBe(true);
});

test('a new genuine contradiction cannot inherit an old clarification flag and silently bypass the clarification question', async () => {
  const s = scene(), value = 'Ngày càng nặng hơn';
  s.ledger.concerns[0].facts.progression.clarified = true;
  await s.reply({ field: 'associated', step: 'compact_associated', layout: 'eight_groups', targets: [], choices: [], question: 'Còn điều gì khác?' }, value, {
    facts: [{ concern_id: 'c1', field: 'progression', value, code: 'worse', quote: value, answer_index: 0 }], global_answer: { relevant: false },
  });
  expect(coverageGoal(s.compact, [], s.input)).toMatchObject({ field: 'clarify', conflict: { concernId: 'c1', field: 'progression' } });
});

test('resuming legacy nested history preserves each historical report once when a new detail arrives', async () => {
  const s = scene();
  const old = value => ({ value, status: 'reported', evidence: { answerIndex: 0, quote: value } });
  const first = old('Ngứa nhẹ'), second = { ...old('Ngứa râm ran'), history: [first] };
  s.ledger.concerns[0].facts.character = JSON.parse(JSON.stringify({ ...old('Ngứa châm chích'), history: [first, second] }));
  const value = 'Ngứa như kiến bò';
  await s.reply({ field: 'associated', step: 'compact_associated', question: 'Bạn còn thay đổi gì khác?', layout: 'eight_groups', targets: [], choices: [] }, value, {
    facts: [{ concern_id: 'c1', field: 'character', value, quote: value, answer_index: 0 }], global_answer: { relevant: false },
  });
  const history = s.ledger.concerns[0].facts.character.history;
  expect(history.map(item => item.value)).toEqual(['Ngứa nhẹ', 'Ngứa râm ran', 'Ngứa châm chích']);
  expect(history.every(item => !Object.hasOwn(item, 'history'))).toBe(true);
});

test('an existing nested session is repaired before sending another context, even without a new fact update', () => {
  const s = scene();
  const first = { value: 'Ngứa nhẹ', status: 'reported' }, second = { value: 'Ngứa râm ran', status: 'reported', history: [first] };
  s.ledger.concerns[0].facts.character = JSON.parse(JSON.stringify({ value: 'Ngứa châm chích', status: 'reported', history: [first, second] }));
  initialize(s.compact);
  expect(s.ledger.concerns[0].facts.character.history).toEqual([
    first, { value: 'Ngứa râm ran', status: 'reported' },
  ]);
  expect(s.ledger.concerns[0].facts.character.value).toBe('Ngứa châm chích');
});
