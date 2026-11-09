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
const { buildConclusionFacts } = require('../../src/core/checkin/triage-conclusion');
const { validateBlock } = require('../../src/core/checkin/triage-conclusion');
const { getDetailedNextStep } = require('../../src/core/checkin/triage-detail-questions');
const { t } = require('../../src/i18n');
const {
  validatePlan,
  isOfferedAnswer,
  resolveAdaptiveQuestion,
  adaptiveFacts,
  readAdaptiveState,
  protectAdaptiveState,
  validateAdaptiveAnswers,
} = require('../../src/services/checkin/adaptive-question.service');

const text = 'Tôi nghe tiếng ù trong tai trái';
const item = () => ({
  question: 'Âm thanh đang nghe giống loại nào?',
  grounding_quote: 'tiếng ù',
  multi_select: false,
  options: ['Tiếng ve', 'Tiếng rít'],
});
const initial = () => ({
  version: 1,
  sources: [],
  questions: [],
  lastQuestion: { step: 'symptoms', question: 'Biểu hiện?', options: ['Mệt mỏi', 'Đau đầu'] },
});
const answers = () => [{ step: 'symptoms', question: 'Biểu hiện?', answer: text }];
const base = { step: 'detail_history', state: { detailedAssessmentVersion: 2 } };
const resolve = (state = initial(), list = answers(), override = {}) =>
  resolveAdaptiveQuestion({
    state,
    answers: list,
    base,
    lang: 'vi',
    profile: { age: 35, medical_conditions: [] },
    ...override,
  });
const accept = (plan) => (options) =>
  Promise.resolve({
    content: JSON.stringify(
      options.system?.startsWith('You review') ? { valid: true } : { questions: plan }
    ),
  });
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockImplementation(accept([item()]));
});

test('known choices, combined labels and labels containing commas do not invoke generation', async () => {
  expect(isOfferedAnswer('First, second, Third', ['First, second', 'Third'])).toBe(true);
  expect(isOfferedAnswer('First, unusual', ['First', 'Second'])).toBe(false);
  expect(isOfferedAnswer(['First', 'Second'], ['First', 'Second'])).toBe(true);
  expect((await resolve(initial(), [{ ...answers()[0], answer: 'Mệt mỏi' }])).question).toBeNull();
  expect(callTextAi).not.toHaveBeenCalled();
});
test.each(['Không rõ', 'Không có', 'Không chắc chắn', 'Uncertain'])(
  'uncertainty or none is not an invitation to an AI loop (%s)',
  async (value) => {
    expect((await resolve(initial(), [{ ...answers()[0], answer: value }])).question).toBeNull();
    expect(callTextAi).not.toHaveBeenCalled();
  }
);
test('a new answer produces a question with real choices, uncertainty and a free-text escape', async () => {
  const result = await resolve();
  expect(result.question).toMatchObject({
    question: item().question,
    multiSelect: false,
    allowFreeText: true,
  });
  expect(result.question.step).toMatch(/^adaptive_[a-f0-9]{32}$/);
  expect(result.question.options).toEqual([
    'Tiếng ve',
    'Tiếng rít',
    'Không rõ',
    'Khác, nhập hoặc nói câu trả lời',
  ]);
  expect(callTextAi).toHaveBeenCalledWith(
    expect.objectContaining({ strictProvider: true, maxRetries: 0, timeoutMs: 4000 })
  );
});
test('danger screening precedes generation and the queued source is retained', async () => {
  const first = await resolve(initial(), answers(), { base: { step: 'red_flags' } });
  expect(first.question).toBeNull();
  expect(callTextAi).not.toHaveBeenCalled();
  const second = await resolve(first.state, [
    ...answers(),
    { step: 'red_flags', answer: 'Không có', question: 'Nguy hiểm?' },
  ]);
  expect(second.question.question).toBe(item().question);
  expect(callTextAi).toHaveBeenCalledTimes(2);
});
test('reopening a pending generated question returns the identical question without another provider call', async () => {
  const first = await resolve();
  const replay = await resolve(first.state);
  expect(replay.question).toEqual(first.question);
  expect(callTextAi).toHaveBeenCalledTimes(2);
});
test('two generated questions are consumed in order, then the template interview continues', async () => {
  callTextAi.mockImplementation(
    accept([
      item(),
      {
        ...item(),
        question: 'Âm thanh có theo nhịp tim của bạn không?',
        options: ['Theo nhịp tim', 'Không theo nhịp tim'],
      },
    ])
  );
  const first = await resolve();
  const list = [
    ...answers(),
    { step: first.question.step, question: first.question.question, answer: 'Tiếng ve' },
  ];
  const second = await resolve(first.state, list);
  expect(second.question.step).not.toBe(first.question.step);
  const complete = [
    ...list,
    { step: second.question.step, question: second.question.question, answer: 'Theo nhịp tim' },
  ];
  expect((await resolve(second.state, complete)).question).toBeNull();
  expect(adaptiveFacts(second.state, complete)).toHaveLength(2);
  expect(callTextAi).toHaveBeenCalledTimes(2);
});
test.each([
  'bad JSON',
  JSON.stringify({ questions: [{ ...item(), options: ['Có', 'Không'] }] }),
  JSON.stringify({ questions: [{ ...item(), options: ['Tiếng ve', 'Tiếng ve'] }] }),
  JSON.stringify({ questions: [{ ...item(), grounding_quote: 'unsupported complaint' }] }),
  JSON.stringify({ questions: [{ ...item(), question: 'Bạn bị ung thư phải không?' }] }),
  JSON.stringify({ questions: [{ ...item(), options: ['Dùng thuốc 500 mg', 'Tăng liều thuốc'] }] }),
  JSON.stringify({ questions: [{ ...item(), question: 'dài '.repeat(30) }] }),
])('invalid, unsupported or unsafe output is rejected: %s', (content) => {
  expect(validatePlan(content, text)).toBeNull();
});
test('repeating a previously asked question is omitted', () => {
  expect(
    validatePlan(JSON.stringify({ questions: [item()] }), text, [{ question: item().question }])
  ).toEqual([]);
});
test('numeric choices require continuous, ordered ranges with matching units', () => {
  const numeric = {
    ...item(),
    options: ['Dưới 5 phút', 'Trên 10 phút'],
    ranges: [
      { min: null, max: 5, unit: 'phút' },
      { min: 10, max: null, unit: 'phút' },
    ],
  };
  expect(validatePlan(JSON.stringify({ questions: [numeric] }), text)).toBeNull();
  numeric.ranges[1].min = 5;
  const accepted = validatePlan(JSON.stringify({ questions: [numeric] }), text);
  expect(accepted[0].options).toEqual(['Dưới 5 phút', 'Từ 5 phút trở lên']);
});
test('invalid schema is retried once; repeated invalid output falls back to an open answer', async () => {
  callTextAi.mockResolvedValue({ content: 'invalid' });
  const result = await resolve();
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(result.question).toMatchObject({
    options: [],
    allowFreeText: true,
    skipAnswerLabel: 'Không có gì thêm',
  });
  expect(result.state.sources[0].status).toBe('fallback');
});
test.each(['timeout', 'insufficient_credits', 'AI_CONSENT_REQUIRED'])(
  'provider failure %s preserves the flow and does not retry the provider',
  async (code) => {
    callTextAi.mockRejectedValue(Object.assign(new Error('Unavailable'), { code }));
    const result = await resolve();
    expect(callTextAi).toHaveBeenCalledTimes(1);
    expect(result.question.options).toEqual([]);
    result.state.lastQuestion = { ...result.question, origin: 'open' };
    const finished = await resolve(result.state, [
      ...answers(),
      {
        step: result.question.step,
        question: result.question.question,
        answer: result.question.skipAnswerLabel,
      },
    ]);
    expect(finished.question).toBeNull();
    expect(callTextAi).toHaveBeenCalledTimes(1);
  }
);
test('forged or rewritten adaptive question IDs cannot enter another interview', async () => {
  const result = await resolve();
  expect(() =>
    validateAdaptiveAnswers(result.state, [
      { step: 'adaptive_' + 'a'.repeat(32), question: 'Forged', answer: 'Example' },
    ])
  ).toThrow();
  expect(() =>
    validateAdaptiveAnswers(result.state, [
      { step: result.question.step, question: 'Changed question', answer: 'Example' },
    ])
  ).toThrow();
});
test('adaptive state can be stored and replayed without leaking it through the question result', async () => {
  const result = await resolve();
  expect(readAdaptiveState(7, protectAdaptiveState(7, result.state))).toEqual(result.state);
  expect(result.question).not.toHaveProperty('sources');
});
test('recorded adaptive answers are passed verbatim to conclusion facts', () => {
  const facts = buildConclusionFacts(
    {
      allSymptoms: ['ù tai'],
      currentSymptoms: ['ù tai'],
      adaptiveAnswers: [{ question: item().question, answer: 'Tiếng ve', origin: 'ai' }],
    },
    { age: 35 },
    {},
    'vi'
  );
  expect(facts.khai_bao_bo_sung).toEqual([
    { question: item().question, answer: 'Tiếng ve', origin: 'ai' },
  ]);
});
test('emergency words in an additional answer bypass new generation immediately', async () => {
  const result = await resolve();
  const before = callTextAi.mock.calls.length;
  const response = await getNextTriageQuestion({
    status: 'tired',
    phase: 'initial',
    assessmentVersion: 2,
    adaptiveEnabled: true,
    adaptiveState: result.state,
    profile: { age: 35 },
    previousAnswers: [
      ...answers(),
      {
        step: result.question.step,
        question: result.question.question,
        answer: 'Đau ngực dữ dội, khó thở',
      },
    ],
  });
  expect(response).toMatchObject({ isDone: true, severity: 'emergency' });
  expect(callTextAi).toHaveBeenCalledTimes(before);
});
test('additional facts remain available when the template interview concludes', async () => {
  const first = await resolve();
  await getNextTriageQuestion({
    status: 'tired',
    phase: 'initial',
    forceConclusion: true,
    adaptiveEnabled: true,
    adaptiveState: first.state,
    profile: { age: 35 },
    previousAnswers: [
      ...answers(),
      { step: first.question.step, question: first.question.question, answer: 'Tiếng ve' },
    ],
  });
  expect(generateConclusion).toHaveBeenCalledWith(
    expect.objectContaining({ adaptiveAnswers: [expect.objectContaining({ answer: 'Tiếng ve' })] }),
    expect.anything(),
    expect.anything(),
    null,
    expect.anything(),
    expect.anything()
  );
});

test('a semantic review rejects choices that do not answer the question', async () => {
  callTextAi.mockImplementation((options) =>
    Promise.resolve({
      content: JSON.stringify(
        options.system?.startsWith('You review') ? { valid: false } : { questions: [item()] }
      ),
    })
  );
  const result = await resolve();
  expect(callTextAi).toHaveBeenCalledTimes(4);
  expect(result.question.options).toEqual([]);
  expect(result.state.sources[0].status).toBe('fallback');
});
test('MedGemma generation uses the larger reviewer on the same clinical provider', async () => {
  callTextAi.mockImplementation(async (options) => ({
    provider: 'medgemma',
    content: JSON.stringify(
      options.system.startsWith('You review')
        ? { valid: true, errors: [] }
        : { questions: [item()] }
    ),
  }));
  await resolve();
  expect(callTextAi.mock.calls[0][0]).toMatchObject({ provider: 'medgemma', strictProvider: true });
  expect(callTextAi.mock.calls[1][0]).toMatchObject({
    provider: 'medgemma',
    model: 'medgemma-27b-it',
    strictProvider: true,
  });
});

test.each([
  [56, 'Nam', 'chú', 'Chú'],
  [56, 'Nữ', 'cô', 'Cô'],
  [65, 'Nữ', 'bác', 'Bác'],
])(
  'the generation and reviewer share age/gender addressing (%s, %s)',
  async (age, gender, honorific, title) => {
    callTextAi.mockImplementation(
      accept([{ ...item(), question: `${title} thấy âm thanh giống loại nào?` }])
    );
    const result = await resolve(initial(), answers(), {
      profile: { age, gender, full_name: 'Tên thử nghiệm' },
    });
    expect(result.question.question.startsWith(title)).toBe(true);
    for (const [request] of callTextAi.mock.calls) {
      expect(JSON.parse(request.prompt).CONTEXT.addressing).toEqual({ honorific, selfRef: 'cháu' });
      expect(request.strictProvider).toBe(true);
    }
  }
);

test('inappropriate Bạn or slash addressing is rejected and the open fallback keeps the right honorific', async () => {
  callTextAi.mockImplementation(
    accept([{ ...item(), question: 'Bạn thấy âm thanh giống loại nào?' }])
  );
  const result = await resolve(initial(), answers(), { profile: { age: 56, gender: 'Nam' } });
  expect(result.question.question).toMatch(/^Chú /u);
  expect(result.question.options).toEqual([]);
  expect(result.state.sources[0].status).toBe('fallback');
  expect(
    validatePlan(
      JSON.stringify({
        questions: [{ ...item(), question: 'Anh/chị thấy âm thanh giống loại nào?' }],
      }),
      text,
      [],
      'vi',
      [],
      { honorific: 'chú' }
    )
  ).toBeNull();
});
test('legacy mapping and the check-in safety classifier are also locked to Dr7/MedGemma', async () => {
  const layer = jest.requireActual('../../src/core/checkin/triage-ai-layer');
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ associatedSymptoms: [], redFlags: [], causes: [], severity: 'mild' }),
  });
  await layer.generateMappingForSymptom('Synthetic provider routing audit');
  await layer.classifySymptomSeverity('Synthetic classifier routing audit', { age: 35 });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  for (const [options] of callTextAi.mock.calls)
    expect(options).toMatchObject({ provider: 'medgemma', strictProvider: true });
});
test('a positive verdict with listed errors is rejected rather than shown to the patient', async () => {
  callTextAi.mockImplementation(async (options) => ({
    content: JSON.stringify(
      options.system.startsWith('You review')
        ? { valid: true, errors: ['Overlapping choices'] }
        : { questions: [item()] }
    ),
  }));
  const result = await resolve();
  expect(result.question.options).toEqual([]);
  expect(result.question.question).toContain(text);
});
test('already answered or pending template topics cannot be repeated in an AI question', () => {
  const plan = JSON.stringify({
    questions: [{ ...item(), question: 'Anh/chị bắt đầu thấy khó chịu từ khi nào?' }],
  });
  expect(validatePlan(plan, text, [], 'vi', ['onset'])).toEqual([]);
});
test('template repetitions are omitted while a useful source-specific question remains', () => {
  const plan = {
    questions: [
      {
        ...item(),
        question: 'Tiếng ù kéo dài bao lâu rồi?',
        options: ['Vài giờ', 'Vài ngày', 'Vài tuần'],
      },
      item(),
    ],
  };
  expect(validatePlan(JSON.stringify(plan), text, [], 'vi', ['onset'])).toEqual([
    expect.objectContaining({ question: item().question }),
  ]);
});
test('ambiguous word-only time ranges are rejected too', () => {
  const plan = { questions: [{ ...item(), options: ['Vài phút', 'Vài giờ', 'Vài ngày'] }] };
  expect(validatePlan(JSON.stringify(plan), text)).toBeNull();
});
test('provider escape choices are normalized without inventing substantive options', () => {
  const plan = {
    questions: [{ ...item(), options: [...item().options, 'Không rõ', 'Không có gì thêm'] }],
  };
  expect(validatePlan(JSON.stringify(plan), text)[0].options).toEqual(item().options);
});
test('single-choice options cannot mix frequency and pulse rhythm', () => {
  const plan = {
    questions: [
      {
        ...item(),
        question: 'Tiếng ù tai như thế nào?',
        options: ['Liên tục', 'Ngắt quãng', 'Theo nhịp tim'],
      },
    ],
  };
  expect(validatePlan(JSON.stringify(plan), text)).toBeNull();
});
test('wording changes do not hide a template frequency question', () => {
  const plan = {
    questions: [
      { ...item(), question: 'Tiếng ù tai như thế nào?', options: ['Liên tục', 'Thỉnh thoảng'] },
      item(),
    ],
  };
  expect(validatePlan(JSON.stringify(plan), text, [], 'vi', ['pattern'])).toHaveLength(1);
});
test('payload capacity reserves the remaining clinical questions without calling the provider', async () => {
  const list = [
    ...Array.from({ length: 112 }, (_, index) => ({
      step: `existing_${index}`,
      question: 'Existing',
      answer: 'Selected',
    })),
    ...answers(),
  ];
  const result = await resolve(initial(), list, {
    base: { ...base, pendingTemplateFields: ['onset'] },
  });
  expect(result.question).toBeNull();
  expect(result.state.sources[0].status).toBe('capacity');
  expect(callTextAi).not.toHaveBeenCalled();
});
test('schema repair receives the rejected plan and a specific correction instruction', async () => {
  callTextAi.mockResolvedValue({ content: 'invalid' });
  await resolve();
  expect(JSON.parse(callTextAi.mock.calls[1][0].prompt)).toMatchObject({
    REJECTED_PLAN: 'invalid',
    REPAIR: expect.any(String),
  });
});
test("question generation receives this patient's exact positions, separate area answers and recent readings", async () => {
  await resolve(initial(), answers(), {
    profile: {
      age: 70,
      gender: 'Nữ',
      medical_conditions: ['Tiểu đường'],
      full_name: 'Do not send a name',
    },
    base: {
      ...base,
      state: {
        bodyLocations: ['head'],
        bodyLocationOther: 'Đầu: Tai trái',
        regionDetails: [{ region: 'head', answers: { onset: 'Từ hôm qua' } }],
      },
    },
    healthContext: {
      recentBP: [{ systolic: 130, diastolic: 80, occurred_at: '2026-11-09T01:00:00Z' }],
      tookMedicationToday: true,
    },
  });
  const prompt = JSON.parse(callTextAi.mock.calls[0][0].prompt);
  expect(prompt.CONTEXT).toMatchObject({
    age: 70,
    gender: 'Nữ',
    conditions: ['Tiểu đường'],
    exact_positions: 'Đầu: Tai trái',
    took_medication_today: true,
  });
  expect(prompt.CONTEXT.recent_readings.blood_pressure[0].systolic).toBe(130);
  expect(JSON.stringify(prompt)).not.toContain('Do not send a name');
});
test('enabling the new flow while resuming an old unknown complaint preserves the concern', async () => {
  const result = await resolve({ version: 1, questions: [], sources: [] }, [
    ...answers(),
    { step: 'red_flags', question: 'Nguy hiểm?', answer: 'Không có' },
  ]);
  expect(result.question.question).toBe(item().question);
});

test.each([null, 3, {}, ['nested']])(
  'non-string choices are rejected without coercion (%j)',
  (value) => {
    expect(
      validatePlan(JSON.stringify({ questions: [{ ...item(), options: ['Normal', value] }] }), text)
    ).toBeNull();
  }
);
test.each([
  [null, null],
  [
    { min: null, max: null, unit: 'phút' },
    { min: null, max: null, unit: 'phút' },
  ],
  [
    { min: null, max: 5, unit: 'phút' },
    { min: null, max: null, unit: 'phút' },
  ],
  [
    { min: null, max: 5, unit: 'phút' },
    { min: 5, max: null, unit: 'giờ' },
  ],
])('malformed intervals never throw or produce null-valued labels (%j)', (...ranges) => {
  const plan = JSON.stringify({
    questions: [{ ...item(), options: ['Dưới 5 phút', 'Từ 5 phút'], ranges }],
  });
  expect(validatePlan(plan, text)).toBeNull();
});
test('glucose units mg/dL are valid measurements, while drug doses remain forbidden', () => {
  const plan = JSON.stringify({
    questions: [
      {
        ...item(),
        question: 'Chỉ số đường huyết bạn đo là bao nhiêu?',
        grounding_quote: 'đường huyết',
        options: ['Dưới 70 mg/dL', 'Từ 70 mg/dL'],
        ranges: [
          { min: null, max: 70, unit: 'mg/dL' },
          { min: 70, max: null, unit: 'mg/dL' },
        ],
      },
    ],
  });
  expect(validatePlan(plan, 'Tôi đã đo đường huyết')[0].options).toEqual([
    'Dưới 70 mg/dL',
    'Từ 70 mg/dL trở lên',
  ]);
});
test('uncertainty synonyms collapse to a single UI choice', async () => {
  callTextAi.mockImplementation(
    accept([{ ...item(), options: [...item().options, 'Không chắc chắn'] }])
  );
  const result = await resolve();
  expect(result.question.options).toEqual([
    ...item().options,
    'Không rõ',
    'Khác, nhập hoặc nói câu trả lời',
  ]);
});
test('multiple custom answers are collected together without assigning an ambiguous region', async () => {
  const queued = await resolve(initial(), answers(), { base: { step: 'red_flags' } });
  queued.state.lastQuestion = { step: 'detail_head_character', options: ['Đau nhói', 'Đau âm ỉ'] };
  const list = [
    ...answers(),
    { step: 'red_flags', question: 'Safety?', answer: 'Không có' },
    { step: 'detail_head_character', question: 'Kiểu khó chịu?', answer: 'Râm ran ở vùng trán' },
  ];
  const result = await resolve(queued.state, list, {
    base: { action: 'conclude', state: { bodyLocations: ['head', 'limbs'] } },
  });
  const prompt = JSON.parse(callTextAi.mock.calls[0][0].prompt);
  expect(prompt.SOURCE).toContain(text);
  expect(prompt.SOURCE).toContain('Râm ran ở vùng trán');
  expect(result.state.questions[0].source).toHaveLength(2);
  expect(result.state.questions[0].region).toBeUndefined();
});
test.each([
  [['head'], 'head'],
  [['head', 'limbs'], undefined],
])('new questions only inherit an unambiguous server region (%j)', async (regions, expected) => {
  const result = await resolve(initial(), answers(), {
    base: { ...base, state: { bodyLocations: regions } },
  });
  expect(result.state.questions[0].region).toBe(expected);
});
test.each([
  ['head', 'Có kèm đau tai', 'detail_head_character'],
  ['head', 'Không kèm đau tai', 'detail_head_pattern'],
  [undefined, 'Có kèm đau tai', 'detail_head_pattern'],
  ['limbs', 'Có kèm đau tay', 'detail_head_pattern'],
])(
  'newly confirmed pain opens detail fields only for its actual region (%s/%s)',
  (region, answer, next) => {
    const previousAnswers = [
      ['symptoms', 'Ù tai'],
      ['red_flags', 'Không có'],
      ['detail_history', 'Không có bệnh nền đã được xác nhận'],
      ['detail_head_onset', 'Từ hôm qua'],
      ['detail_head_progression', 'Vẫn như cũ'],
      ['detail_head_severity', 'Nhẹ'],
      ['detail_head_impact', 'Vẫn sinh hoạt bình thường'],
    ].map(([step, answer]) => ({ step, answer }));
    const result = getDetailedNextStep({
      status: 'tired',
      phase: 'initial',
      lang: 'vi',
      profile: { age: 35 },
      bodyLocations: ['head'],
      previousAnswers,
      supplementalAnswers: [{ region, answer }],
    });
    expect(result.step).toBe(next);
  }
);
test('template questions do not embed a first-person patient sentence as a symptom noun', () => {
  const { formatQuestion } = jest.requireActual('../../src/core/checkin/triage-ai-layer');
  const state = { allSymptoms: [text], onset: null };
  const result = formatQuestion(
    { step: 'red_flags', state, options: ['Không có'] },
    { age: 35, gender: 'Nữ' }
  );
  expect(result.question).not.toContain('tôi nghe');
  expect(state.allSymptoms).toEqual([text]);
});
test('an adaptive question retains its source region while the template is moving to the next region', async () => {
  const previousAnswers = [
    ['symptoms', 'Đau đầu, Đau khớp'],
    ['red_flags', 'Không có'],
    ['detail_history', 'Không có bệnh nền đã được xác nhận'],
    ['detail_head_onset', 'Từ hôm qua'],
    ['detail_head_progression', 'Vẫn như cũ'],
    ['detail_head_severity', 'Nhẹ'],
    ['detail_head_impact', 'Vẫn sinh hoạt bình thường'],
    ['detail_head_character', 'Đau âm ỉ'],
    ['detail_head_pattern', 'Liên tục'],
    ['detail_head_radiation', 'Chỉ ở chỗ đã chọn'],
    ['detail_head_aggravating', 'Chưa thấy yếu tố làm tăng'],
    ['detail_head_relieving', 'Chưa thử cách nào'],
    ['detail_head_associated', 'Không có'],
    ['detail_head_actions', 'Chưa làm gì'],
  ].map(([step, answer]) => ({ step, answer, question: step }));
  const result = await getNextTriageQuestion({
    status: 'tired',
    phase: 'initial',
    assessmentVersion: 2,
    adaptiveEnabled: true,
    bodyLocations: ['head', 'limbs'],
    profile: { age: 35 },
    previousAnswers,
    adaptiveState: {
      version: 1,
      sources: [{ status: 'generated' }],
      questions: [
        {
          step: 'adaptive_' + 'a'.repeat(32),
          region: 'head',
          lang: 'vi',
          question: item().question,
          options: item().options,
          origin: 'ai',
          multiSelect: false,
        },
      ],
    },
  });
  expect(result.questionGroup).toMatchObject({ key: 'head', index: 1, total: 2 });
});
test.each([
  ['Có thêm đau tai', 'detail_head_character'],
  ['Không kèm đau tai', 'detail_head_pattern'],
])(
  'new pain from a template associated answer also opens its detail fields (%s)',
  (answer, next) => {
    const previousAnswers = [
      ['symptoms', 'Ù tai'],
      ['red_flags', 'Không có'],
      ['detail_history', 'Không có bệnh nền đã được xác nhận'],
      ['detail_head_onset', 'Từ hôm qua'],
      ['detail_head_progression', 'Vẫn như cũ'],
      ['detail_head_severity', 'Nhẹ'],
      ['detail_head_impact', 'Vẫn sinh hoạt bình thường'],
      ['detail_head_associated', answer],
    ].map(([step, answer]) => ({ step, answer }));
    expect(
      getDetailedNextStep({
        status: 'tired',
        phase: 'initial',
        lang: 'vi',
        profile: { age: 35 },
        bodyLocations: ['head'],
        previousAnswers,
      }).step
    ).toBe(next);
  }
);
test('a recorded negative medical history cannot be described as never supplied', () => {
  const facts = buildConclusionFacts(
    {
      allSymptoms: ['Ù tai'],
      historyAssessment: 'none_reported',
      regionDetails: [{ region: 'head', answers: {} }],
    },
    { age: 35 },
    {},
    'vi'
  );
  expect(
    validateBlock('narrative', 'Chúng ta chưa có thông tin về các bệnh nền khác của chị.', facts, {
      skipCareLevel: true,
    })
  ).toBe('recorded_history_claimed_missing');
  expect(
    validateBlock('narrative', 'Chị đã khai chưa có bệnh nền được xác nhận.', facts, {
      skipCareLevel: true,
    })
  ).toBeNull();
});

test('adaptive metadata is encrypted with the patient key and cannot be read as another patient', async () => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-adaptive-encryption-'));
  fs.chmodSync(directory, 0o700);
  const oldEnabled = process.env.HEALTH_FIELD_ENCRYPTION_ENABLED,
    oldDirectory = process.env.HEALTH_FIELD_KEY_DIRECTORY;
  try {
    process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.HEALTH_FIELD_KEY_DIRECTORY = directory;
    const result = await resolve();
    const protectedValue = protectAdaptiveState(7, result.state);
    expect(protectedValue).toMatch(/^asinu:enc:v1:/);
    expect(protectedValue).not.toContain('Âm thanh');
    expect(readAdaptiveState(7, protectedValue)).toEqual(result.state);
    expect(() => readAdaptiveState(8, protectedValue)).toThrow();
  } finally {
    if (oldEnabled === undefined) delete process.env.HEALTH_FIELD_ENCRYPTION_ENABLED;
    else process.env.HEALTH_FIELD_ENCRYPTION_ENABLED = oldEnabled;
    if (oldDirectory === undefined) delete process.env.HEALTH_FIELD_KEY_DIRECTORY;
    else process.env.HEALTH_FIELD_KEY_DIRECTORY = oldDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
