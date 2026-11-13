'use strict';
jest.mock('../../src/security/openbao-keyring.cjs', () => ({
  keyringEnabled: () => false,
  keyringReady: () => true,
}));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/core/checkin/triage-ai-layer', () => ({
  ...jest.requireActual('../../src/core/checkin/triage-ai-layer'),
  classifySymptomSeverity: jest.fn().mockResolvedValue({ severity: 'mild' }),
  generateConclusion: jest
    .fn()
    .mockResolvedValue({ summary: 'Recorded', recommendation: 'Monitor' }),
}));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { generateConclusion } = require('../../src/core/checkin/triage-ai-layer');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const {
  getCompactNextStep,
  isCompactStep,
  validateCompactAnswers,
} = require('../../src/services/checkin/compact-interview.service');
const { validateExtraction } = require('../../src/services/checkin/compact-coverage.service');
const {
  readAdaptiveState,
  protectAdaptiveState,
} = require('../../src/services/checkin/adaptive-question.service');
const { providerResponse, options } = require('../fixtures/compact-interview');

let extract;
function mockProvider(params) {
  const context = JSON.parse(params.prompt).CONTEXT;
  if (params.system.startsWith('Review one')) return require('../fixtures/compact-interview').approvedQuestionReview(params);
  if (params.system.startsWith('Review patient fact'))
    return { content: '{"valid":true,"errors":[]}' };
  if (params.system.startsWith('Extract explicitly'))
    return { content: JSON.stringify(extract(context)) };
  const field = context.field;
  const scope = context.target_concerns?.map((c) => c.label).join(' và ');
  let value;
  if (['measurement', 'measurements'].includes(field))
    value = {
      field,
      question: 'Kết quả đo hôm nay là bao nhiêu, đơn vị gì và đo lúc nào?',
      options: [],
    };
  else if (field === 'character')
    value = {
      field,
      question: `Cảm giác ${scope || 'khó chịu'} giống kiểu nào vậy?`,
      options: [
        { id: 'aching', label: 'Âm ỉ' },
        { id: 'sharp', label: 'Nhói' },
      ],
    };
  else value = JSON.parse(providerResponse(params).content);
  if (field === 'clinical_context' && context.required_option_ids?.length === 2)
    value.question = 'Hôm nay chú đã đo chỉ số nào chưa ạ?';
  if (scope && ['onset', 'progression'].includes(field))
    value.question =
      field === 'onset'
        ? `${scope.length > 100 ? 'Những khó chịu này' : `Tình trạng ${scope}`} của ${context.addressing.honorific} bắt đầu từ khi nào vậy?`
        : `Từ lúc mới bị đến giờ, ${scope} đỡ hơn, vẫn vậy hay nặng hơn?`;
  if (context.clarification)
    value.question = `Để hiểu rõ hơn, ${value.question.charAt(0).toLocaleLowerCase() + value.question.slice(1)}`;
  if (context.required_option_ids)
    value.options = value.options.filter((c) => context.required_option_ids.includes(c.id));
  if (context.allow_different && !value.options.some((c) => c.id === 'different'))
    value.options.push({
      id: 'different',
      label:
        field === 'onset'
          ? 'Mỗi triệu chứng bắt đầu một lúc khác nhau'
          : 'Mỗi triệu chứng thay đổi khác nhau',
    });
  return { content: JSON.stringify(value) };
}

const payload = (new_concerns = [], facts = [], extra = {}) => ({ new_concerns, facts, ...extra });
const report = 'Đau đầu từ sáng nay, sưng gối phải 4 ngày rồi';
const twoConcerns = (context, timed = false) => {
  const names = ['Đau đầu', 'sưng gối phải'];
  return payload(
    names.map((label, i) => ({
      id: `new_${i + 1}`,
      label,
      quote: label,
      answer_index: context.answer_index,
      region: i ? 'limbs' : 'head',
      detail_fields: ['character'],
    })),
    timed
      ? names.map((label, i) => ({
          concern_id: `new_${i + 1}`,
          field: 'onset',
          value: i ? '4 ngày rồi' : 'từ sáng nay',
          quote: i ? 'sưng gối phải 4 ngày rồi' : 'Đau đầu từ sáng nay',
          answer_index: context.answer_index,
        }))
      : []
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  extract = (c) =>
    c.field === 'symptoms'
      ? twoConcerns(c)
      : payload([], [], { global_answer: { relevant: true, quote: c.answer } });
  callTextAi.mockImplementation(mockProvider);
});

function conversation(overrides = {}) {
  let adaptiveState = { version: 1, sources: [], questions: [] },
    next;
  const previousAnswers = [],
    seen = [];
  const input = {
    assessmentVersion: 3,
    adaptiveEnabled: true,
    phase: 'initial',
    status: 'tired',
    lang: 'vi',
    profile: { age: 56, gender: 'Nam' },
    healthContext: {},
    bodyLocations: ['head', 'limbs'],
    bodyLocationOther: 'Đầu: hai bên thái dương; Tay chân: gối phải',
    ...overrides,
  };
  const advance = async (answer) => {
    if (answer !== undefined)
      previousAnswers.push({ step: next.step, question: next.question, answer });
    next = await getNextTriageQuestion({ ...input, adaptiveState, previousAnswers });
    adaptiveState = next._adaptiveState || adaptiveState;
    if (!next.isDone) seen.push(next);
    return next;
  };
  const choice = (id) =>
    adaptiveState.compact.questions
      .find((q) => q.step === next.step)
      .choices.find((c) => c.id === id)?.label;
  const complete = async (choose = () => undefined) => {
    if (!next) await advance();
    for (let i = 0; i < 100 && !next.isDone; i++) {
      const q = adaptiveState.compact.questions.find((item) => item.step === next.step);
      const code = {
        impact: 'normal',
        onset: 'under_three_days',
        progression: 'same',
        character: 'aching',
      }[q.field];
      const custom = choose(q, next);
      const answer =
        custom ??
        (q.field === 'symptoms'
          ? 'Đau đầu, sưng gối phải'
          : choice(code) ||
            (['red_flags', 'source', 'associated'].includes(q.field)
              ? 'Không có'
              : q.field === 'clinical_context'
                ? [choice('medication_as_planned'), choice('not_measured')]
                    .filter(Boolean)
                    .join(', ')
                : 'Không rõ'));
      await advance(answer);
    }
    expect(next.isDone).toBe(true);
    return next;
  };
  return {
    advance,
    complete,
    choice,
    input,
    seen,
    previousAnswers,
    get state() {
      return adaptiveState;
    },
    get next() {
      return next;
    },
  };
}

test('up-front distinct onsets are retained per complaint and never re-asked', async () => {
  extract = (c) => (c.field === 'symptoms' ? twoConcerns(c, true) : payload([], []));
  const c = conversation();
  await c.advance();
  await c.advance(report);
  await c.complete();
  expect(c.state.compact.version).toBe(2);
  expect(c.state.compact.questions.some((q) => q.field === 'onset')).toBe(false);
  expect(c.state.compact.coverage.concerns.map((item) => item.facts.onset.value)).toEqual([
    'từ sáng nay',
    '4 ngày rồi',
  ]);
  const state = generateConclusion.mock.calls.at(-1)[0];
  expect(state.compactAssessment.concerns).toHaveLength(2);
  expect(state.onset).toBeNull();
});

test('Different splits only the missing timeline/course, without restarting eight groups per symptom', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  await c.complete((q) =>
    q.allowDifferent ? q.choices.find((item) => item.id === 'different').label : undefined
  );
  const qs = c.state.compact.questions;
  expect(qs.filter((q) => q.field === 'onset').map((q) => q.targets)).toEqual([
    ['c1', 'c2'],
    ['c1'],
    ['c2'],
  ]);
  expect(qs.filter((q) => q.field === 'progression').map((q) => q.targets)).toEqual([
    ['c1', 'c2'],
    ['c1'],
    ['c2'],
  ]);
  for (const field of ['impact', 'clinical_context', 'source', 'associated'])
    expect(qs.filter((q) => q.field === field)).toHaveLength(1);
  expect(new Set(qs.map((q) => q.step)).size).toBe(qs.length);
  expect(qs.every((q) => isCompactStep(q.step))).toBe(true);
});

test('a common offered answer covers exactly its listed complaints', async () => {
  const c = conversation();
  await c.complete();
  const qs = c.state.compact.questions;
  expect(qs.filter((q) => q.field === 'onset')).toHaveLength(1);
  expect(
    c.state.compact.coverage.concerns.every(
      (item) => item.facts.onset.value === c.state.compact.coverage.concerns[0].facts.onset.value
    )
  ).toBe(true);
});

test('Unknown is recorded once for the asked targets, retained as missing information, not normality', async () => {
  const c = conversation();
  const result = await c.complete((q) => (q.field === 'onset' ? 'Không rõ' : undefined));
  expect(c.state.compact.questions.filter((q) => q.field === 'onset')).toHaveLength(1);
  expect(
    c.state.compact.coverage.concerns.every((item) => item.facts.onset.status === 'unknown')
  ).toBe(true);
  expect(result.assessmentIncomplete).toBe(true);
});

test('a late additional complaint gets only its missing fields and newly applicable warning signs', async () => {
  let added = false;
  const c = conversation();
  await c.complete((q) => {
    if (q.field === 'associated' && !added) {
      added = true;
      return q.choices[0].label;
    }
    return undefined;
  });
  const qs = c.state.compact.questions;
  expect(c.state.compact.coverage.concerns).toHaveLength(3);
  expect(qs.filter((q) => q.field === 'onset' && q.targets.includes('c1'))).toHaveLength(1);
  expect(qs.filter((q) => q.field === 'onset' && q.targets.includes('c3'))).toHaveLength(1);
  expect(qs.filter((q) => q.field === 'associated')).toHaveLength(1);
  const labels = qs.filter((q) => q.field === 'red_flags').flatMap((q) => q.warningKeys);
  expect(new Set(labels).size).toBe(labels.length);
});

test('all owned multi-complaint warnings are screened in bounded batches instead of truncating at six', async () => {
  const c = conversation();
  await c.complete();
  const state = generateConclusion.mock.calls.at(-1)[0];
  const expected = state.mappings.flatMap((mapping) => mapping.redFlags || []);
  const offered = c.state.compact.questions
    .filter((q) => q.field === 'red_flags')
    .flatMap((q) => q.choices.map((item) => item.label));
  expect(offered).toEqual(expect.arrayContaining(expected));
  expect(
    c.state.compact.questions
      .filter((q) => q.field === 'red_flags')
      .every((q) => q.choices.length <= 6)
  ).toBe(true);
  expect(new Set(offered).size).toBe(offered.length);
  const questions = c.state.compact.questions.filter((q) => q.field === 'red_flags');
  expect(new Set(questions.map((q) => q.question)).size).toBe(questions.length);
  expect(questions[1].question).toMatch(/Còn|thêm|tiếp theo/);
});

test('offline warning batches also use distinct continuation headings and retain every warning', async () => {
  callTextAi.mockImplementation((params) => {
    if (
      params.system.startsWith('You generate ONE') &&
      JSON.parse(params.prompt).CONTEXT.field === 'red_flags'
    )
      throw new Error('synthetic offline');
    return mockProvider(params);
  });
  const c = conversation();
  await c.complete();
  const warnings = c.state.compact.questions.filter((q) => q.field === 'red_flags');
  expect(warnings.length).toBeGreaterThan(1);
  expect(warnings.every((q) => q.origin === 'fallback')).toBe(true);
  expect(new Set(warnings.map((q) => q.question)).size).toBe(warnings.length);
  expect(warnings.flatMap((q) => q.choices.map((o) => o.label))).toEqual(
    expect.arrayContaining(
      generateConclusion.mock.calls.at(-1)[0].mappings.flatMap((m) => m.redFlags || [])
    )
  );
});

test('a recorded clarification goal keeps the original warning batch number', async () => {
  const c = conversation();
  await c.complete();
  // Isolate presentation of a stored unresolved batch from triage risk logic.
  c.state.compact.coverage.warningAnswers[0].status = 'unresolved';
  const warnings = c.state.compact.questions.filter((q) => q.field === 'red_flags');
  const view = getCompactNextStep({
    ...c.input,
    adaptiveState: c.state,
    previousAnswers: c.previousAnswers,
  });
  expect(view.coverageGoal.warningKeys).toEqual(warnings[0].warningKeys);
  expect(view.warningBatch).toMatchObject({ index: 1, clarification: true });
  expect(view.questionGroup.label).toMatch(/Phần 1\//);
});

test('an already offered duplicate heading remains the canonical wire question when resuming an old phase', async () => {
  const c = conversation();
  await c.advance();
  await c.advance('Đau đầu, sưng gối phải');
  const first = c.next;
  await c.advance('Không có');
  const second = c.state.compact.questions.find((q) => q.step === c.next.step);
  expect(second.field).toBe('red_flags');
  second.question = first.question;
  const calls = callTextAi.mock.calls.length;
  const resumed = await getNextTriageQuestion({
    ...c.input,
    previousAnswers: c.previousAnswers,
    adaptiveState: c.state,
  });
  expect(resumed.question).toBe(first.question);
  expect(callTextAi).toHaveBeenCalledTimes(calls);
  expect(() =>
    validateCompactAnswers(resumed._adaptiveState, [
      ...c.previousAnswers,
      { step: resumed.step, question: resumed.question, answer: 'Không có' },
    ])
  ).not.toThrow();
});

test('a selected warning ends immediately without waiting for remaining batches or source questions', async () => {
  const c = conversation();
  await c.advance();
  await c.advance('Đau đầu, sưng gối phải');
  expect(c.next.step).toBe('compact_red_flags');
  const result = await c.advance(c.state.compact.questions.at(-1).choices[0].label);
  expect(result.isDone).toBe(true);
  expect(result.needsDoctor).toBe(true);
  expect(c.state.compact.questions.some((q) => q.field === 'source')).toBe(false);
});

test('resume reuses encrypted facts, targets, options and the offered question without another extraction or generation', async () => {
  const c = conversation();
  await c.advance();
  await c.advance('Đau đầu, sưng gối phải');
  const calls = callTextAi.mock.calls.length;
  const saved = readAdaptiveState(97, protectAdaptiveState(97, c.state));
  const replay = await getNextTriageQuestion({
    ...c.input,
    previousAnswers: c.previousAnswers,
    adaptiveState: saved,
  });
  expect(replay).toEqual(c.next);
  expect(callTextAi).toHaveBeenCalledTimes(calls);
  expect(() =>
    validateCompactAnswers(saved, [{ ...c.previousAnswers[0], question: 'forged' }])
  ).toThrow();
});

test('one worsening complaint is not diluted by another improving complaint', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  const result = await c.complete((q) =>
    q.field === 'progression'
      ? q.allowDifferent
        ? c.choice('different')
        : c.choice(q.targets[0] === 'c1' ? 'better' : 'worse')
      : undefined
  );
  expect(result.severity).toBe('high');
  expect(generateConclusion.mock.calls.at(-1)[0].progression).toBe('worse');
});

test('medication and measurements reported early are reused instead of asking the same information again', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? {
          ...twoConcerns(ctx),
          shared_facts: [
            {
              field: 'medication_today',
              code: 'medication_as_planned',
              value: 'Đã uống thuốc theo hướng dẫn',
              quote: 'Đã uống thuốc theo hướng dẫn',
              answer_index: 0,
            },
            {
              field: 'measurements_today',
              code: 'not_measured',
              value: 'chưa đo chỉ số hôm nay',
              quote: 'chưa đo chỉ số hôm nay',
              answer_index: 0,
            },
          ],
        }
      : payload([], []);
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  await c.complete((q) =>
    q.field === 'symptoms'
      ? 'Đau đầu, sưng gối phải. Đã uống thuốc theo hướng dẫn, chưa đo chỉ số hôm nay'
      : undefined
  );
  expect(c.state.compact.questions.some((q) => q.field === 'clinical_context')).toBe(false);
});

test('partial medication-context answers ask only the unprovided measurement part next', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  let first = true;
  await c.complete((q) => {
    if (q.field === 'clinical_context' && first) {
      first = false;
      return c.choice('medication_as_planned');
    }
    return undefined;
  });
  const qs = c.state.compact.questions.filter((q) => q.field === 'clinical_context');
  expect(qs).toHaveLength(2);
  expect(qs[1].clinicalParts).toEqual(['measurements_today']);
  expect(qs[1].choices.map((item) => item.id)).toEqual(['reading_available', 'not_measured']);
});

test('measurement values use input without fabricated numeric choices; Unknown does not repeat the question', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  await c.complete((q) =>
    q.field === 'clinical_context'
      ? [c.choice('medication_as_planned'), c.choice('reading_available')]
          .filter(Boolean)
          .join(', ')
      : undefined
  );
  const measurements = c.state.compact.questions.filter((q) => q.field === 'measurements');
  expect(measurements).toHaveLength(1);
  expect(measurements[0].choices).toEqual([]);
});

test.each([
  ['Tăng huyết áp', 'huyết áp', 'đường huyết', false],
  ['Tiểu đường', 'đường huyết', 'huyết áp', true],
])(
  'a failed AI question still offers matching measured/not-measured answers for %s',
  async (condition, label, unrelated, reject) => {
    callTextAi.mockImplementation((params) => {
      const context = JSON.parse(params.prompt).CONTEXT;
      if (
        params.system.startsWith('You generate') &&
        context.field === 'clinical_context' &&
        context.required_option_ids?.length === 2
      ) {
        if (reject)
          return {
            content: '{"field":"clinical_context","question":"Chú đã đo chưa?","options":[]}',
          };
        throw new Error('offline');
      }
      return mockProvider(params);
    });
    const c = conversation({ healthContext: { medical_conditions: [condition] } });
    let first = true,
      fallback,
      pending;
    await c.complete((q, result) => {
      if (q.field !== 'clinical_context') return undefined;
      if (first) {
        first = false;
        return c.choice('medication_as_planned');
      }
      fallback = result;
      pending = {
        ...c.input,
        adaptiveState: structuredClone(c.state),
        previousAnswers: structuredClone(c.previousAnswers),
      };
      return c.choice('not_measured');
    });
    expect(fallback.questionSource).toBe('fallback');
    expect(fallback.question).toContain(label);
    expect(fallback.question).not.toContain(unrelated);
    expect(fallback.options).toEqual([
      `Hôm nay đã đo ${label}`,
      `Hôm nay chưa đo ${label}`,
      'Không rõ',
      'Khác, nhập hoặc nói câu trả lời',
    ]);
    const question = c.state.compact.questions.find(
      (q) => q.field === 'clinical_context' && q.origin === 'fallback'
    );
    expect(question.choices.map((c) => c.id)).toEqual(['reading_available', 'not_measured']);
    pending.adaptiveState.compact.questions.at(-1).choices = [];
    const calls = callTextAi.mock.calls.length;
    const reopened = await getNextTriageQuestion(pending);
    expect(reopened.question).toBe(fallback.question);
    expect(reopened.step).toBe(fallback.step);
    expect(reopened.options).toEqual(fallback.options);
    expect(callTextAi).toHaveBeenCalledTimes(calls);
  }
);

test('existing recent readings are used without re-entering the same value', async () => {
  const c = conversation({
    healthContext: {
      medical_conditions: ['Tiểu đường'],
      recentGlucose: [{ value: 6.2, unit: 'mmol/L', occurred_at: new Date().toISOString() }],
    },
  });
  await c.complete((q) =>
    q.field === 'clinical_context'
      ? [c.choice('medication_as_planned'), c.choice('reading_available')]
          .filter(Boolean)
          .join(', ')
      : undefined
  );
  expect(c.state.compact.questions.some((q) => q.field === 'measurements')).toBe(false);
});

test.each([
  {
    new_concerns: [
      { id: 'new_1', label: 'Đau đầu', quote: 'invented', answer_index: 0, detail_fields: [] },
    ],
    facts: [],
  },
  {
    new_concerns: [],
    facts: [
      {
        concern_id: 'c1',
        field: 'onset',
        value: '4 ngày',
        quote: 'không tồn tại',
        answer_index: 0,
      },
    ],
  },
  { new_concerns: [], facts: [null] },
])('unanchored or malformed extracted facts are never trusted: %j', (value) => {
  const context = {
    concerns: [{ id: 'c1', label: 'Đau đầu' }],
    answer_index: 0,
    answer: 'Đau đầu từ sáng',
    exact_location: '',
    locations: ['head'],
  };
  expect(validateExtraction(JSON.stringify(value), context)).toBeNull();
});
test('a paraphrased value is replaced with the actual patient quote without dropping the other anchored facts', () => {
  const context = {
    concerns: [{ id: 'c1', label: 'Sưng gối' }],
    answer_index: 0,
    answer: 'Sưng gối được 4 ngày',
    exact_location: '',
    locations: ['limbs'],
  };
  const value = payload(
    [],
    [
      {
        concern_id: 'c1',
        field: 'onset',
        value: '4 ngày trước',
        quote: 'được 4 ngày',
        answer_index: 0,
      },
    ]
  );
  expect(validateExtraction(JSON.stringify(value), context).facts[0].value).toBe('được 4 ngày');
});

test.each([true, false])(
  'nested Dr7 shared facts use the same evidence validation (grounded: %s)',
  (grounded) => {
    const answer = 'Đau đầu. Tôi vẫn sinh hoạt bình thường';
    const content = {
      new_concerns: [],
      facts: [],
      global_answer: {
        relevant: true,
        quote: answer,
        shared_facts: [
          {
            field: 'impact',
            code: 'normal',
            value: 'vẫn sinh hoạt bình thường',
            quote: grounded ? 'vẫn sinh hoạt bình thường' : 'Tôi không nói điều này',
            answer_index: 0,
          },
        ],
      },
    };
    const result = validateExtraction(JSON.stringify(content), {
      concerns: [],
      answer_index: 0,
      answer,
      locations: ['head'],
      exact_location: '',
    });
    if (grounded) expect(result.shared_facts[0].code).toBe('normal');
    else expect(result).toBeNull();
  }
);

test('the real Dr7 nested-impact schema never causes an already-answered activity question to be asked again', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? {
          ...twoConcerns(ctx),
          global_answer: {
            relevant: true,
            quote: 'Tôi vẫn sinh hoạt bình thường',
            shared_facts: [
              {
                field: 'impact',
                code: 'normal',
                value: 'vẫn sinh hoạt bình thường',
                quote: 'vẫn sinh hoạt bình thường',
                answer_index: 0,
              },
            ],
          },
        }
      : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'symptoms' ? 'Đau đầu, sưng gối phải. Tôi vẫn sinh hoạt bình thường' : undefined
  );
  expect(c.state.compact.questions.some((q) => q.field === 'impact')).toBe(false);
  expect(c.state.compact.coverage.global.impact.status).toBe('reported');
});

test('a global source answer may omit empty arrays, but poor sleep cannot become impaired functioning', () => {
  const answer = 'Hai đêm vừa rồi ngủ ít vì làm việc muộn';
  const context = {
    field: 'source',
    answer_index: 7,
    answer,
    concerns: [],
    locations: [],
    exact_location: '',
  };
  const value = { global_answer: { relevant: true, quote: answer } };
  expect(validateExtraction(JSON.stringify(value), context)).toMatchObject({
    new_concerns: [],
    facts: [],
  });
  value.shared_facts = [
    { field: 'impact', code: 'slowed', value: 'ngủ ít', quote: 'ngủ ít', answer_index: 7 },
  ];
  expect(validateExtraction(JSON.stringify(value), context)).toBeNull();
});

test('the server binds a current exact quote to the current answer instead of trusting a model-supplied history index', () => {
  const answer = 'Đau đầu từ hôm qua. Tôi vẫn sinh hoạt bình thường';
  const input = {
    new_concerns: [
      {
        id: 'new_1',
        label: 'Đau đầu',
        quote: 'Đau đầu',
        answer_index: 0,
        region: 'head',
        detail_fields: [],
      },
    ],
    facts: [
      {
        concern_id: 'new_1',
        field: 'onset',
        value: 'từ hôm qua',
        quote: 'từ hôm qua',
        answer_index: 0,
      },
    ],
    shared_facts: [
      {
        field: 'impact',
        code: 'normal',
        value: 'vẫn sinh hoạt bình thường',
        quote: 'vẫn sinh hoạt bình thường',
        answer_index: 0,
      },
    ],
  };
  const result = validateExtraction(JSON.stringify(input), {
    field: 'symptoms',
    answer_index: 7,
    answer,
    concerns: [],
    locations: ['head'],
    exact_location: '',
  });
  expect(result.new_concerns[0].answer_index).toBe(7);
  expect(result.facts[0].answer_index).toBe(7);
  expect(result.shared_facts[0].answer_index).toBe(7);
  input.facts[0].quote = 'Thông tin không xuất hiện trong câu trả lời';
  expect(
    validateExtraction(JSON.stringify(input), {
      field: 'symptoms',
      answer_index: 7,
      answer,
      concerns: [],
      locations: ['head'],
      exact_location: '',
    })
  ).toBeNull();
});

test.each([
  [['skin'], 'hai cẳng chân', 'skin'],
  [['skin', 'limbs'], 'Da', 'skin'],
  [['skin', 'limbs'], 'hai cẳng chân', null],
  [['skin'], 'vùng ngực', null],
])(
  'a Dr7 anatomical region is normalised only when the supplied UI context is unambiguous: %j / %s',
  (locations, region, expected) => {
    const answer = 'Hai cẳng chân ngứa râm ran';
    const input = payload([
      {
        id: 'new_1',
        label: 'ngứa râm ran',
        quote: 'ngứa râm ran',
        answer_index: 0,
        region,
        detail_fields: [],
      },
    ]);
    const result = validateExtraction(JSON.stringify(input), {
      field: 'symptoms',
      answer_index: 0,
      answer,
      concerns: [],
      locations,
      exact_location: 'Da: hai cẳng chân; Tay chân: hai cẳng chân',
    });
    if (expected) expect(result.new_concerns[0].region).toBe(expected);
    else expect(result).toBeNull();
  }
);

test('the actual Dr7 abdomen schema preserves two symptoms and their early timeline without rejecting an explicit daily-function report', () => {
  const answer =
    'Tôi đầy hơi và khó tiêu quanh rốn từ sau bữa tối hôm qua, không nặng lên. Tôi vẫn làm được các việc thường ngày. Tối qua có ăn món lạ.';
  const input = {
    new_concerns: ['đầy hơi', 'khó tiêu'].map((label, i) => ({
      id: `new_${i + 1}`,
      label,
      quote: label,
      answer_index: 0,
      region: 'Bụng: vùng quanh rốn',
      detail_fields: [],
    })),
    facts: ['new_1', 'new_2'].flatMap((concern_id) => [
      {
        concern_id,
        field: 'onset',
        value: 'sau bữa tối hôm qua',
        quote: 'sau bữa tối hôm qua',
        answer_index: 0,
      },
      {
        concern_id,
        field: 'progression',
        code: 'same',
        value: 'không nặng lên',
        quote: 'không nặng lên',
        answer_index: 0,
      },
    ]),
    shared_facts: [
      {
        field: 'impact',
        code: 'normal',
        value: 'Tôi vẫn làm được các việc thường ngày',
        quote: 'Tôi vẫn làm được các việc thường ngày',
        answer_index: 0,
      },
      {
        field: 'source',
        code: 'nutrition',
        value: 'Tối qua có ăn món lạ',
        quote: 'Tối qua có ăn món lạ',
        answer_index: 0,
      },
    ],
  };
  const result = validateExtraction(JSON.stringify(input), {
    field: 'symptoms',
    answer_index: 0,
    answer,
    concerns: [],
    locations: ['abdomen'],
    exact_location: 'Bụng: vùng quanh rốn',
  });
  expect(result.new_concerns.map((c) => c.region)).toEqual(['abdomen', 'abdomen']);
  expect(result.facts).toHaveLength(4);
  expect(result.shared_facts.map((f) => f.field)).toEqual(['impact', 'source']);
});

test.each([
  ['Tôi vẫn làm được các việc thường ngày', 'normal', true],
  ['Tôi vẫn tự làm được mọi việc hằng ngày', 'normal', true],
  ['Tôi làm việc chậm hơn nhưng vẫn tự làm được mọi việc hằng ngày', 'normal', false],
  ['Tôi vẫn làm được một số việc thường ngày', 'normal', false],
  ['Tôi không làm được các việc thường ngày', 'normal', false],
])(
  'functioning evidence remains distinct from partial ability or impairment: %s',
  (answer, code, valid) => {
    const result = validateExtraction(
      JSON.stringify({
        new_concerns: [],
        facts: [],
        shared_facts: [{ field: 'impact', code, value: answer, quote: answer, answer_index: 0 }],
      }),
      {
        field: 'symptoms',
        answer_index: 0,
        answer,
        concerns: [],
        locations: [],
        exact_location: '',
      }
    );
    expect(result !== null).toBe(valid);
  }
);

test('an explicit pre-onset event already reported in the first answer covers source without a second questionnaire', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? {
          ...twoConcerns(ctx),
          shared_facts: [
            {
              field: 'source',
              code: 'environment',
              value: 'Trước đó tôi ngủ ít vì làm việc muộn',
              quote: 'Trước đó tôi ngủ ít vì làm việc muộn',
              answer_index: 0,
            },
          ],
        }
      : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'symptoms'
      ? 'Đau đầu, sưng gối phải. Trước đó tôi ngủ ít vì làm việc muộn'
      : undefined
  );
  expect(c.state.compact.questions.some((q) => q.field === 'source')).toBe(false);
  expect(c.state.compact.coverage.global.source.value).toBe('Trước đó tôi ngủ ít vì làm việc muộn');
});

test('a quality explicitly present in the reported symptom is reused without asking for it again', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? payload([
          {
            id: 'new_1',
            label: 'bàn chân phải tê như kim châm',
            quote: 'bàn chân phải tê như kim châm',
            answer_index: 0,
            region: 'limbs',
            detail_fields: ['character'],
          },
        ])
      : payload([], []);
  const c = conversation({
    bodyLocations: ['limbs'],
    bodyLocationOther: 'Tay chân: bàn chân phải',
  });
  await c.complete((q) => (q.field === 'symptoms' ? 'bàn chân phải tê như kim châm' : undefined));
  expect(c.state.compact.questions.some((q) => q.field === 'character')).toBe(false);
  expect(c.state.compact.coverage.concerns[0].facts.character.evidence.quote).toBe('như kim châm');
  expect(
    c.state.compact.questions
      .find((q) => q.field === 'red_flags')
      .choices.some((c) => c.label.includes('tê hoặc yếu đột ngột một bên'))
  ).toBe(true);
});

test('an explicitly reported sleep-onset difficulty is not asked again as an unspecified sleep quality', async () => {
  const label = 'khó ngủ đầu giấc';
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? payload([
          {
            id: 'new_1',
            label,
            quote: label,
            answer_index: 0,
            region: 'mental',
            detail_fields: ['character'],
          },
        ])
      : payload([], []);
  const c = conversation({
    bodyLocations: ['mental'],
    bodyLocationOther: 'Tinh thần: khó ngủ đầu giấc',
  });
  await c.complete((q) => (q.field === 'symptoms' ? label : undefined));
  expect(c.state.compact.questions.some((q) => q.field === 'character')).toBe(false);
  expect(c.state.compact.coverage.concerns[0].facts.character.evidence.quote).toBe(label);
});

test('an aggravating activity alone cannot be promoted into an earlier causal event', () => {
  const answer = 'Đau tăng lên khi đi lại';
  const result = validateExtraction(
    JSON.stringify({
      new_concerns: [],
      facts: [],
      shared_facts: [
        {
          field: 'source',
          code: 'activity',
          value: 'khi đi lại đau hơn',
          quote: answer,
          answer_index: 0,
        },
      ],
    }),
    {
      field: 'symptoms',
      answer_index: 0,
      answer,
      concerns: [],
      locations: ['limbs'],
      exact_location: '',
    }
  );
  expect(result).toBeNull();
});

test.each([
  ['đau âm ỉ hai bên trán', true],
  ['ngứa da trán', false],
])('anatomical wording keeps the appropriate existing warning set: %s', async (label, headache) => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? payload([
          {
            id: 'new_1',
            label,
            quote: label,
            answer_index: ctx.answer_index,
            region: 'head',
            detail_fields: [],
          },
        ])
      : payload([], []);
  const c = conversation({ bodyLocations: ['head'], bodyLocationOther: 'Đầu: hai bên trán' });
  await c.advance();
  await c.advance(label);
  const warnings = c.next.options.join(' ');
  if (headache) expect(warnings).toContain('đau đầu dữ dội đột ngột');
  else expect(warnings).not.toContain('đau đầu dữ dội đột ngột');
  expect(c.state.compact.coverage.concerns[0].label).toBe(label);
});
test('common detail questions are shared, and continuous symptoms never get an episode-duration question', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? {
          ...twoConcerns(ctx),
          new_concerns: twoConcerns(ctx).new_concerns.map((c) => ({
            ...c,
            detail_fields: ['pattern', 'episode_duration', 'actions'],
          })),
        }
      : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'pattern'
      ? c.choice('continuous')
      : q.field === 'actions'
        ? c.choice('nothing')
        : undefined
  );
  expect(c.state.compact.questions.filter((q) => q.field === 'pattern')).toHaveLength(1);
  expect(c.state.compact.questions.filter((q) => q.field === 'actions')).toHaveLength(1);
  expect(c.state.compact.questions.some((q) => q.field === 'episode_duration')).toBe(false);
  expect(
    c.state.compact.coverage.concerns.every(
      (item) => item.facts.episode_duration.status === 'not_applicable'
    )
  ).toBe(true);
});

test('a claimed coverage snapshot cannot be replayed over changed answers', async () => {
  const c = conversation();
  await c.advance();
  await c.advance('Đau đầu, sưng gối phải');
  await expect(
    getNextTriageQuestion({
      ...c.input,
      previousAnswers: [{ ...c.previousAnswers[0], answer: 'Đau đầu khác' }],
      adaptiveState: c.state,
    })
  ).rejects.toMatchObject({ code: 'TRIAGE_CHANGED' });
});

test('an off-topic onset answer is clarified before concluding, without repeating the clear groups', async () => {
  const c = conversation();
  let first = true;
  await c.complete((q) =>
    q.field === 'onset' && first ? ((first = false), 'Vừa đi chợ về') : undefined
  );
  const questions = c.state.compact.questions.filter((q) => q.field === 'onset');
  expect(questions).toHaveLength(2);
  expect(questions[1].clarificationIndex).toBeDefined();
  expect(questions[1].question).not.toBe(questions[0].question);
  expect(c.state.compact.coverage.concerns.every((c) => c.facts.onset.status === 'reported')).toBe(
    true
  );
  for (const field of ['impact', 'source', 'associated'])
    expect(c.state.compact.questions.filter((q) => q.field === field)).toHaveLength(1);
});

test('an unclear measurement status is clarified without asking medication-taking again', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  let count = 0;
  await c.complete((q) => {
    if (q.field !== 'clinical_context') return undefined;
    count++;
    return count === 1
      ? c.choice('medication_as_planned')
      : count === 2
        ? 'Vừa đi chợ về'
        : c.choice('not_measured');
  });
  const questions = c.state.compact.questions.filter((q) => q.field === 'clinical_context');
  expect(questions).toHaveLength(3);
  expect(questions[2].clinicalParts).toEqual(['measurements_today']);
  expect(questions[2].choices.map((c) => c.id)).toEqual(['reading_available', 'not_measured']);
  expect(c.state.compact.coverage.measurementReports.duong_huyet.status).toBe('reported');
});

test('a numeric reading missing its unit asks for clarification and combines only the two actual answer parts', async () => {
  const c = conversation({ healthContext: { medical_conditions: ['Tiểu đường'] } });
  let count = 0;
  await c.complete((q) =>
    q.field === 'clinical_context'
      ? [c.choice('medication_as_planned'), c.choice('reading_available')]
          .filter(Boolean)
          .join(', ')
      : q.field === 'measurements'
        ? ++count === 1
          ? '6.5'
          : 'mmol/L'
        : undefined
  );
  const questions = c.state.compact.questions.filter((q) => q.field === 'measurements');
  expect(questions).toHaveLength(2);
  expect(questions[1].question).not.toBe(questions[0].question);
  expect(questions.every((q) => q.choices.length === 0)).toBe(true);
  const reply = c.state.compact.coverage.measurementReplies.duong_huyet;
  expect(reply.value).toBe('6.5 mmol/L');
  expect(reply.parts.map((p) => p.evidence.quote)).toEqual(['6.5', 'mmol/L']);
  expect(reply.incompleteValue).toBe(false);
});

test('an unread free report is clarified into a recognised symptom before completing', async () => {
  callTextAi.mockImplementation((params) => {
    if (params.system.startsWith('Extract explicitly')) throw new Error('offline');
    return mockProvider(params);
  });
  const c = conversation();
  await c.complete((q) =>
    q.field === 'symptoms'
      ? q.reportClarification === undefined
        ? 'Một cảm giác lạ chưa biết diễn tả'
        : 'Đau nhức'
      : undefined
  );
  expect(c.state.compact.coverage.unresolvedReports).toEqual([]);
  expect(c.state.compact.coverage.concerns.map((c) => c.label)).toEqual(['Đau nhức']);
  expect(c.state.compact.questions.filter((q) => q.field === 'symptoms')).toHaveLength(2);
  expect(c.state.compact.questions.filter((q) => q.field === 'impact')).toHaveLength(1);
});
test('many chosen complaints can exceed nine questions while shared groups remain single and every individual onset is collected', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `Khó chịu ${i + 1}`);
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? payload(
          names.map((label, i) => ({
            id: `new_${i + 1}`,
            label,
            quote: label,
            answer_index: 0,
            region: null,
            detail_fields: [],
          }))
        )
      : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'symptoms'
      ? names.join(', ')
      : q.field === 'onset' && q.allowDifferent
        ? c.choice('different')
        : undefined
  );
  expect(c.previousAnswers.length).toBeGreaterThan(9);
  expect(c.state.compact.coverage.concerns).toHaveLength(10);
  expect(
    c.state.compact.coverage.concerns.every((item) => item.facts.onset.status === 'reported')
  ).toBe(true);
  for (const field of ['impact', 'source', 'associated'])
    expect(c.state.compact.questions.filter((q) => q.field === field)).toHaveLength(1);
});
test('Unknown in an earlier warning batch remains incomplete after later batches confirm None', async () => {
  let first = true;
  const c = conversation();
  const result = await c.complete((q) =>
    q.field === 'red_flags' && first ? ((first = false), 'Không rõ') : undefined
  );
  expect(result.assessmentIncomplete).toBe(true);
  expect(c.state.compact.coverage.warningAnswers[0].status).toBe('unknown');
});
test('an unavailable extractor preserves the report as unresolved instead of turning medication statements into extra symptoms', async () => {
  callTextAi.mockImplementation((params) => {
    if (params.system.startsWith('Extract explicitly')) throw new Error('offline');
    return mockProvider(params);
  });
  const c = conversation();
  const text = 'Đau đầu và sưng gối. Hôm nay đã uống thuốc theo hướng dẫn';
  const result = await c.complete((q) =>
    q.reportClarification !== undefined ? 'Không rõ' : q.field === 'symptoms' ? text : undefined
  );
  expect(result.assessmentIncomplete).toBe(true);
  expect(c.state.compact.coverage.concerns.some((item) => /uống thuốc/u.test(item.label))).toBe(
    false
  );
  expect(generateConclusion.mock.calls.at(-1)[0].compactAssessment.answers[0].answer).toBe(text);
});

test('an extraction outage does not mark exact selected symptoms as unread after their facts have been collected', async () => {
  callTextAi.mockImplementation((params) => {
    if (params.system.startsWith('Extract explicitly')) throw new Error('offline');
    return mockProvider(params);
  });
  const c = conversation();
  const result = await c.complete((q) =>
    q.field === 'symptoms' ? 'Sưng khớp, Tê tay chân' : undefined
  );
  expect(c.state.compact.coverage.concerns.map((c) => c.label)).toEqual([
    'Sưng khớp',
    'Tê tay chân',
  ]);
  expect(c.state.compact.coverage.unresolvedReports).toEqual([]);
  expect(result.assessmentIncomplete).toBe(false);
});
test('a contradictory new onset gets one clarification with the original reports instead of restarting onset questions', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? twoConcerns(ctx)
      : ctx.field === 'associated'
        ? payload(
            [],
            [
              {
                concern_id: 'c1',
                field: 'onset',
                value: 'từ sáng nay',
                quote: 'từ sáng nay',
                answer_index: ctx.answer_index,
                conflicts_with_previous: true,
              },
            ],
            { global_answer: { relevant: true, quote: ctx.answer } }
          )
        : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'associated'
      ? 'Tôi nói nhầm, đầu chỉ đau từ sáng nay'
      : q.field === 'clarify'
        ? c.choice('latest')
        : undefined
  );
  expect(c.state.compact.questions.filter((q) => q.field === 'onset')).toHaveLength(1);
  expect(c.state.compact.questions.filter((q) => q.field === 'clarify')).toHaveLength(1);
  expect(c.state.compact.coverage.concerns[0].facts.onset.value).toBe('từ sáng nay');
  expect(c.state.compact.coverage.concerns[0].facts.onset.status).toBe('reported');
});
test('a more precise compatible timeline does not manufacture a conflict question', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? twoConcerns(ctx)
      : ctx.field === 'associated'
        ? payload(
            [],
            [
              {
                concern_id: 'c1',
                field: 'onset',
                value: '2 ngày rồi',
                quote: '2 ngày rồi',
                answer_index: ctx.answer_index,
              },
            ],
            { global_answer: { relevant: true, quote: ctx.answer } }
          )
        : payload([], []);
  const c = conversation();
  await c.complete((q) =>
    q.field === 'associated' ? 'Đầu đau được 2 ngày rồi, ngoài ra không có gì khác' : undefined
  );
  expect(c.state.compact.questions.some((q) => q.field === 'clarify')).toBe(false);
  expect(c.state.compact.coverage.concerns[0].facts.onset.value).toBe('2 ngày rồi');
});
test('an explicitly missed medicine cannot be recorded as adherence by extraction code', () => {
  const context = {
    concerns: [],
    answer_index: 0,
    answer: 'Hôm nay tôi quên uống thuốc',
    exact_location: '',
    locations: [],
  };
  expect(
    validateExtraction(
      JSON.stringify(
        payload([], [], {
          shared_facts: [
            {
              field: 'medication_today',
              code: 'medication_as_planned',
              value: 'quên uống thuốc',
              quote: 'quên uống thuốc',
              answer_index: 0,
            },
          ],
        })
      ),
      context
    )
  ).toBeNull();
});
test('not measuring blood pressure does not imply glucose was not measured; only the missing type is asked', async () => {
  extract = (ctx) =>
    ctx.field === 'symptoms'
      ? {
          ...twoConcerns(ctx),
          shared_facts: [
            {
              field: 'medication_today',
              code: 'medication_as_planned',
              value: 'Đã uống thuốc theo hướng dẫn',
              quote: 'Đã uống thuốc theo hướng dẫn',
              answer_index: 0,
            },
            {
              field: 'measurements_today',
              code: 'not_measured',
              value: 'chưa đo huyết áp',
              quote: 'chưa đo huyết áp',
              answer_index: 0,
            },
          ],
        }
      : payload([], []);
  const c = conversation({
    healthContext: { medical_conditions: ['Tiểu đường', 'Tăng huyết áp'] },
  });
  await c.complete((q) =>
    q.field === 'symptoms'
      ? 'Đau đầu, sưng gối phải. Đã uống thuốc theo hướng dẫn, chưa đo huyết áp'
      : undefined
  );
  const questions = c.state.compact.questions.filter((q) => q.field === 'clinical_context');
  expect(questions).toHaveLength(1);
  expect(questions[0].measurementTypes).toEqual(['duong_huyet']);
  expect(questions[0].clinicalParts).toEqual(['measurements_today']);
  expect(c.state.compact.coverage.measurementReports.huyet_ap.code).toBe('not_measured');
});
test('a saved blood-pressure value cannot satisfy the missing glucose context', async () => {
  const c = conversation({
    healthContext: {
      medical_conditions: ['Tiểu đường', 'Tăng huyết áp'],
      recentBP: [{ systolic: 120, diastolic: 80, occurred_at: new Date().toISOString() }],
    },
  });
  await c.complete();
  expect(
    c.state.compact.questions.find((q) => q.field === 'clinical_context').measurementTypes
  ).toEqual(['duong_huyet']);
});
test('structured symptom memory does not treat medication or timing clauses as extra symptoms', () => {
  const { extractSymptoms } = require('../../src/services/checkin/symptom-tracker.service');
  expect(
    extractSymptoms(
      [
        {
          step: 'compact_symptoms',
          answer: 'Đau đầu từ sáng, gối sưng 4 ngày. Hôm nay đã dùng thuốc theo chỉ định',
        },
      ],
      ['Đau đầu', 'Sưng gối']
    )
  ).toEqual(['đau đầu', 'sưng gối']);
});
test('an explicit region location keeps its true source even if the model initially uses the answer index', () => {
  const context = {
    concerns: [{ id: 'c1', label: 'Đau đầu' }],
    answer_index: 0,
    answer: 'Đau đầu',
    exact_location: 'Đầu: hai bên thái dương',
    locations: ['head'],
  };
  const result = validateExtraction(
    JSON.stringify(
      payload(
        [],
        [
          {
            concern_id: 'c1',
            field: 'location',
            value: 'hai bên thái dương',
            quote: 'hai bên thái dương',
            answer_index: 0,
          },
        ],
        { global_answer: { relevant: false } }
      )
    ),
    context
  );
  expect(result.facts[0].answer_index).toBe(-1);
});
test('a later follow-up retains symptoms from the new compact-step history', async () => {
  const baseline = [
    { step: 'compact_symptoms', question: 'Khó chịu thế nào?', answer: 'Đau đầu, sưng gối phải' },
  ];
  const input = {
    assessmentVersion: 3,
    phase: 'followup',
    status: 'tired',
    lang: 'vi',
    profile: { age: 56, gender: 'Nam' },
    previousTriageMessages: baseline,
  };
  const first = await getNextTriageQuestion({ ...input, previousAnswers: [] });
  const answers = [{ step: first.step, question: first.question, answer: 'Vẫn như cũ' }];
  const second = await getNextTriageQuestion({ ...input, previousAnswers: answers });
  answers.push({ step: second.step, question: second.question, answer: 'Không có' });
  const result = await getNextTriageQuestion({ ...input, previousAnswers: answers });
  expect(result.isDone).toBe(true);
  expect(generateConclusion.mock.calls.at(-1)[0].baselineSymptoms.join(' ')).toMatch(/Đau đầu/iu);
  expect(generateConclusion.mock.calls.at(-1)[0].baselineSymptoms.join(' ')).toMatch(/sưng gối/iu);
});
