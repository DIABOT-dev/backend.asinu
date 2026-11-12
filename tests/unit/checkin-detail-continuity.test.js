'use strict';

jest.mock('../../src/security/openbao-keyring.cjs', () => ({
  keyringEnabled: () => false,
  keyringReady: () => true,
}));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const {
  initialize,
  refreshCoverage,
  coverageGoal,
  noMoreDetailsLabel,
} = require('../../src/services/checkin/compact-coverage.service');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { validateQuestion } = require('../../src/services/checkin/compact-interview.service');
const { providerResponse } = require('../fixtures/compact-interview');

function scene() {
  const compact = {
    version: 2,
    layout: 'eight_groups',
    lang: 'vi',
    hasConditions: false,
    questions: [],
  };
  const ledger = initialize(compact);
  ledger.concerns = ['Sốt', 'Mệt mỏi', 'Đau nhức toàn thân', 'Vã mồ hôi'].map((label, i) => ({
    id: `c${i + 1}`,
    label,
    region: 'whole_body',
    evidence: { answerIndex: 0, quote: label },
    detailFields: ['character'],
    facts: {
      onset: { value: 'Từ 1 đến dưới 3 ngày', status: 'reported' },
      progression: { value: 'Vẫn như cũ', status: 'reported', code: 'same' },
    },
  }));
  ledger.nextConcernId = 5;
  ledger.global.symptoms = {
    value: 'Sốt, Mệt mỏi, Đau nhức toàn thân, Vã mồ hôi',
    status: 'reported',
  };
  ledger.global.impact = { value: 'Vẫn sinh hoạt bình thường', status: 'reported', code: 'normal' };
  const input = {
    lang: 'vi',
    bodyLocations: ['whole_body'],
    profile: { age: 35, gender: 'Nam' },
    previousAnswers: [],
  };
  const first = {
    step: 'compact_character',
    field: 'character',
    layout: 'eight_groups',
    targets: ['c1', 'c2', 'c3', 'c4'],
    question: 'Bạn thấy những khó chịu này cụ thể thế nào?',
    choices: [
      { id: 'fatigue', label: 'Mệt mỏi: Không muốn làm gì cả' },
      { id: 'aches', label: 'Đau nhức toàn thân: Đau âm ỉ' },
    ],
  };
  async function reply(question, answer) {
    compact.questions.push(question);
    input.previousAnswers.push({ step: question.step, question: question.question, answer });
    await refreshCoverage(compact, input);
  }
  const nextDetail = () => ({
    step: `compact_character_q${compact.questions.length + 1}`,
    field: 'character',
    layout: 'eight_groups',
    targets: coverageGoal(compact, [], input).targets,
    question: 'Về sốt và vã mồ hôi, ngoài những gì đã kể bạn còn mô tả thêm đặc điểm nào không?',
    choices: [],
  });
  return { compact, ledger, input, first, reply, nextDetail };
}

beforeEach(() => {
  callTextAi.mockReset();
  callTextAi.mockImplementation(async (params) => {
    if (params.system.startsWith('Review')) return { content: '{"valid":true,"errors":[]}' };
    if (params.system.startsWith('Extract')) {
      const c = JSON.parse(params.prompt).CONTEXT;
      return {
        content: JSON.stringify({
          new_concerns: [],
          facts: [],
          global_answer: { relevant: true, quote: c.answer },
        }),
      };
    }
    return providerResponse(params);
  });
});

test('the screenshot’s selected descriptions are recorded against their named symptoms without another extraction call', async () => {
  const s = scene();
  await s.reply(s.first, s.first.choices.map((c) => c.label).join(', '));
  expect(callTextAi).not.toHaveBeenCalled();
  expect(s.ledger.concerns[1].facts.character).toMatchObject({
    value: 'Không muốn làm gì cả',
    status: 'reported',
  });
  expect(s.ledger.concerns[2].facts.character).toMatchObject({
    value: 'Đau âm ỉ',
    status: 'reported',
  });
  expect(s.ledger.concerns[0].facts.character).toBeUndefined();
  expect(coverageGoal(s.compact, [], s.input)).toMatchObject({
    field: 'character',
    targets: ['c1', 'c4'],
  });
});

test('a single complaint reuses its reviewed selected description without another model extraction', async () => {
  const s = scene();
  const q = {
    ...s.first,
    targets: ['c4'],
    choices: [
      { id: 'soaked', label: 'Ướt đẫm áo' },
      { id: 'slight', label: 'Chỉ hơi ẩm da' },
    ],
  };
  await s.reply(q, 'Ướt đẫm áo');
  expect(s.ledger.concerns[3].facts.character).toMatchObject({
    value: 'Ướt đẫm áo',
    status: 'reported',
  });
  expect(callTextAi).not.toHaveBeenCalled();
});

test('the screenshot’s no-more-details reply is retained without asking fever and sweating descriptions a third time', async () => {
  const s = scene();
  await s.reply(s.first, s.first.choices.map((c) => c.label).join(', '));
  const answer =
    'Tôi chỉ thấy nó mệt và sốt loáng mồ hôi liên tục thôi chứ tôi thấy không có gì khác nữa';
  await s.reply(s.nextDetail(), answer);
  for (const i of [0, 3])
    expect(s.ledger.concerns[i].facts.character).toMatchObject({
      status: 'unknown',
      resolution: 'no_further_detail',
      evidence: { quote: answer },
    });
  expect(s.ledger.concerns[1].facts.character.value).toBe('Không muốn làm gì cả');
  expect(s.ledger.concerns[2].facts.character.value).toBe('Đau âm ỉ');
  expect(coverageGoal(s.compact, [], s.input).field).toBe('source');
});

test('a new complaint in the same reply is kept and still requires its safety and timeline questions', async () => {
  const s = scene();
  await s.reply(s.first, s.first.choices.map((c) => c.label).join(', '));
  const old = callTextAi.getMockImplementation();
  callTextAi.mockImplementation(async (params) => {
    if (!params.system.startsWith('Extract')) return old(params);
    const c = JSON.parse(params.prompt).CONTEXT;
    return {
      content: JSON.stringify({
        new_concerns: [
          {
            id: 'new_1',
            label: 'chóng mặt',
            quote: 'chóng mặt',
            answer_index: c.answer_index,
            region: null,
            detail_fields: ['character'],
          },
        ],
        facts: [],
        global_answer: { relevant: true, quote: c.answer },
      }),
    };
  });
  await s.reply(s.nextDetail(), 'Tôi còn chóng mặt, không có gì khác để mô tả thêm');
  const current = s.ledger.concerns.find((c) => c.label === 'chóng mặt');
  expect(current).toBeDefined();
  expect(current.facts.character).toBeUndefined();
  expect(
    coverageGoal(s.compact, [{ id: 'warning', label: 'New warning to check' }], s.input).field
  ).toBe('red_flags');
  expect(coverageGoal(s.compact, [], s.input)).toMatchObject({
    field: 'timeline',
    targets: [current.id],
  });
});

test('a relevant answer with no additional extractable description gets one clarification, then explicit uncertainty', async () => {
  const s = scene();
  const first = { ...s.first, choices: [], targets: ['c1'] };
  await s.reply(first, 'Tôi thấy người khó chịu lắm');
  expect(s.ledger.concerns[0].facts.character.status).toBe('unresolved');
  await s.reply(
    {
      ...first,
      step: 'compact_character_q2',
      question: 'Ngoài khó chịu, bạn thấy cụ thể thế nào?',
    },
    'Tôi chỉ cảm thấy khó chịu thôi'
  );
  expect(s.ledger.concerns[0].facts.character).toMatchObject({
    status: 'unknown',
    resolution: 'answered_without_further_detail',
  });
  expect(coverageGoal(s.compact, [], s.input).targets).not.toContain('c1');
});

test('partial new information does not waive another symptom’s still-missing description', async () => {
  const s = scene();
  await s.reply(s.first, s.first.choices.map((c) => c.label).join(', '));
  const old = callTextAi.getMockImplementation();
  callTextAi.mockImplementation(async (params) => {
    if (!params.system.startsWith('Extract')) return old(params);
    const c = JSON.parse(params.prompt).CONTEXT;
    return {
      content: JSON.stringify({
        new_concerns: [],
        facts: [
          {
            concern_id: 'c1',
            field: 'character',
            value: 'nóng ran',
            quote: 'nóng ran',
            answer_index: c.answer_index,
          },
        ],
        global_answer: { relevant: true, quote: c.answer },
      }),
    };
  });
  await s.reply(s.nextDetail(), 'Người tôi nóng ran');
  expect(s.ledger.concerns[0].facts.character.value).toBe('nóng ran');
  expect(s.ledger.concerns[3].facts.character.status).toBe('unresolved');
  expect(coverageGoal(s.compact, [], s.input)).toMatchObject({
    field: 'character',
    targets: ['c4'],
  });
});

test.each(['vi', 'en'])(
  'the explicit cannot-describe-more choice preserves uncertainty without another provider call (%s)',
  async (lang) => {
    const s = scene();
    s.compact.lang = lang;
    await s.reply(s.first, noMoreDetailsLabel(lang));
    expect(callTextAi).not.toHaveBeenCalled();
    expect(s.ledger.concerns.every((c) => c.facts.character.status === 'unknown')).toBe(true);
    expect(coverageGoal(s.compact, [], s.input).field).toBe('source');
  }
);

test('an extraction outage asks for retry of the saved answer instead of manufacturing another description question', async () => {
  const s = scene();
  callTextAi.mockRejectedValue(new Error('provider unavailable'));
  await expect(s.reply(s.first, 'Tôi thấy người nóng và hơi chóng mặt')).rejects.toMatchObject({
    code: 'CHECKIN_ANSWER_RETRY',
    statusCode: 503,
  });
  expect(s.ledger.processed).toHaveLength(0);
  expect(s.compact.questions).toHaveLength(1);
  expect(s.input.previousAnswers[0].answer).toBe('Tôi thấy người nóng và hơi chóng mặt');
});

test.each([false, true])(
  'a structured review preserves only the correct sweating description, even with inconsistent valid=%s',
  async (valid) => {
    const s = scene();
    await s.reply(s.first, s.first.choices.map((c) => c.label).join(', '));
    callTextAi.mockImplementation(async (params) => {
      if (params.system.startsWith('Extract')) {
        const c = JSON.parse(params.prompt).CONTEXT;
        return {
          content: JSON.stringify({
            new_concerns: [],
            facts: [
              {
                concern_id: 'c1',
                field: 'character',
                value: 'mồ hôi liên tục',
                quote: 'mồ hôi liên tục',
                answer_index: c.answer_index,
              },
              {
                concern_id: 'c4',
                field: 'character',
                value: 'mồ hôi liên tục',
                quote: 'mồ hôi liên tục',
                answer_index: c.answer_index,
              },
            ],
            global_answer: { relevant: true, quote: c.answer },
          }),
        };
      }
      return {
        content: JSON.stringify({
          valid,
          approved_fact_indices: [1],
          rejected_fact_indices: [0],
          new_concerns_valid: true,
          shared_facts_valid: true,
          requested_details_valid: true,
          global_answer_valid: true,
          errors: ['Fact 0 belongs to sweating, not fever'],
        }),
      };
    });
    await s.reply(s.nextDetail(), 'Tôi sốt và mồ hôi liên tục, không có gì khác nữa');
    expect(s.ledger.concerns[0].facts.character).toMatchObject({
      status: 'unknown',
      resolution: 'no_further_detail',
    });
    expect(s.ledger.concerns[3].facts.character).toMatchObject({
      status: 'reported',
      value: 'mồ hôi liên tục',
    });
    expect(coverageGoal(s.compact, [], s.input).field).toBe('source');
  }
);

test.each([
  { approved_fact_indices: [5], rejected_fact_indices: [0] },
  { approved_fact_indices: [0], rejected_fact_indices: [0] },
  { approved_fact_indices: [], rejected_fact_indices: [0], global_answer_valid: false },
])('an invalid or incomplete partial review never approves patient facts (%j)', async (indices) => {
  const s = scene();
  callTextAi.mockImplementation(async (params) => {
    if (params.system.startsWith('Extract')) {
      const c = JSON.parse(params.prompt).CONTEXT;
      return {
        content: JSON.stringify({
          new_concerns: [],
          facts: [
            {
              concern_id: 'c1',
              field: 'character',
              value: 'nóng ran',
              quote: 'nóng ran',
              answer_index: c.answer_index,
            },
          ],
          global_answer: { relevant: true, quote: c.answer },
        }),
      };
    }
    return { content: JSON.stringify({ valid: false, global_answer_valid: true, ...indices }) };
  });
  await expect(s.reply(s.first, 'Người tôi nóng ran')).rejects.toMatchObject({
    code: 'CHECKIN_ANSWER_RETRY',
  });
  expect(s.ledger.concerns[0].facts.character).toBeUndefined();
});

test('new eight-group symptom choices are generated from patient context without a fixed reference menu', async () => {
  const result = await getNextTriageQuestion({
    phase: 'initial',
    status: 'tired',
    assessmentVersion: 3,
    interviewLayout: 'eight_groups',
    lang: 'vi',
    profile: { age: 56, gender: 'Nữ' },
    bodyLocations: ['skin'],
    bodyLocationOther: 'Da chân phải',
    previousAnswers: [],
    adaptiveState: { version: 1, sources: [], questions: [] },
  });
  expect(result.step).toBe('compact_symptoms');
  const params = callTextAi.mock.calls
    .map(([p]) => p)
    .find((p) => p.system.startsWith('You generate ONE'));
  const context = JSON.parse(params.prompt).CONTEXT;
  expect(context).toMatchObject({
    symptom_choices_mode: 'patient_context',
    exact_location: 'Da chân phải',
  });
  expect(context.reference_symptoms).toBeUndefined();
  expect(params.system).toContain('There is no fixed symptom menu to copy');
  expect(params).toMatchObject({ provider: 'medgemma', strictProvider: true });
});

test('an identical generic question is rejected even when the next target set is different', () => {
  const question = 'Bạn có thể kể rõ hơn về cảm giác này không?';
  const context = {
    lang: 'vi',
    addressing: { honorific: 'bạn', selfRef: 'mình' },
    previous_questions: [question],
    required_options: [],
    allowRepeatedPrompt: true,
    bundled_details: true,
  };
  expect(
    validateQuestion(
      JSON.stringify({
        field: 'character',
        question,
        options: [
          { id: 'warm', label: 'Nóng ran' },
          { id: 'cold', label: 'Ớn lạnh' },
        ],
      }),
      'character',
      context
    )
  ).toBeNull();
});
