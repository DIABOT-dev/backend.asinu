jest.mock('../src/services/integrations/doctor-task.service', () => ({
  assertTenantAllowed: jest.fn(),
}));
jest.mock('../src/services/integrations/doctor-messaging.service', () => ({
  loadOwnedTask: jest.fn().mockResolvedValue({ lifecycle_status: 'in_progress' }),
}));
jest.mock('../src/services/integrations/doctor-context.service', () => ({
  loadDoctorClinicalContext: jest.fn(),
}));
jest.mock('../src/services/ai/ai-consent.service', () => ({
  hasAiConsent: jest.fn().mockResolvedValue(true),
  withAiUser: jest.fn((_pool, _user, work) => work()),
}));
jest.mock('../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));

const {
  loadDoctorClinicalContext,
} = require('../src/services/integrations/doctor-context.service');
const { callTextAi } = require('../src/services/ai/ai.service');
const { doctorOperation } = require('../src/services/doctor-ivr/ivr.service');
const { fixedFinal } = require('../src/services/doctor-ivr/question-set.schema');
const { applyQuestionTextRepairs } = require('../src/services/doctor-ivr/question-generation');

beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockReset();
  process.env.DOCTOR_IVR_ENABLED = 'true';
  process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: { message: 'Tôi khó ngủ hai tuần nay.' },
    conversation: [],
    profile: { birth_year: new Date().getUTCFullYear() - 68, daily_medication: 'yes' },
    medications: [],
  });
});

test('question generation retains the age, conditions and medication supplied by the existing clinical context', async () => {
  process.env.DOCTOR_IVR_ENABLED = 'true';
  process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
  const year = new Date().getUTCFullYear();
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: { message: 'Tôi khó ngủ gần đây.' },
    conversation: [],
    profile: {
      birth_year: year - 68,
      gender: 'female',
      conditions: ['Tăng huyết áp'],
      chronic_symptoms: ['Khó ngủ'],
      daily_medication: true,
      allergies: ['Dị ứng đã khai báo'],
    },
    medications: [{ med_name: 'Thuốc đã khai báo' }],
  });
  const content = {
    title: 'Hỏi thêm tình trạng',
    est_duration_s: 100,
    greeting: 'Chào bác.',
    closing: 'Cảm ơn bác.',
    questions: [1, 2, 3]
      .map((n) => ({
        id: `q${n}`,
        text: [
          'Bác khó ngủ vào lúc nào?',
          'Giấc ngủ ảnh hưởng sinh hoạt ra sao?',
          'Bác dùng điện thoại trước khi ngủ không?',
        ][n - 1],
        options: [
          { id: `q${n}_a`, key: 1, label: 'Có', type: 'option' },
          { id: `q${n}_b`, key: 2, label: 'Không', type: 'option' },
          {
            id: `q${n}_x`,
            key: 3,
            label: 'Khác, nói câu trả lời',
            type: 'voice',
            max_record_s: 30,
          },
        ],
      }))
      .concat(fixedFinal('Bác')),
  };
  callTextAi.mockResolvedValue({ content: JSON.stringify(content) });
  const pool = poolFixture();
  await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'generation-test',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'generate',
  });
  const prompt = JSON.parse(callTextAi.mock.calls[0][0].prompt);
  expect(callTextAi.mock.calls[0][0]).toMatchObject({
    provider: 'openai',
    jsonMode: true,
    strictProvider: true,
  });
  expect(prompt.profile).toMatchObject({
    age: 68,
    medical_conditions: ['Tăng huyết áp'],
    chronic_symptoms: ['Khó ngủ'],
    daily_medication: true,
    allergies: ['Dị ứng đã khai báo'],
  });
  expect(prompt.medications).toEqual([{ med_name: 'Thuốc đã khai báo' }]);
});

test('repairs a schema-valid but ambiguous single-choice question before returning an AI draft', async () => {
  callTextAi.mockClear();
  const valid = {
    title: 'Hỏi thêm về giấc ngủ',
    questions: [
      {
        text: 'Bác có trằn trọc lúc mới lên giường không?',
        options: [{ label: 'Có' }, { label: 'Không' }],
      },
      {
        text: 'Buổi sáng bác có làm việc thường ngày được không?',
        options: [{ label: 'Vẫn làm như thường' }, { label: 'Cần nghỉ mới làm tiếp' }],
      },
      {
        text: 'Bác có uống trà trước giờ ngủ không?',
        options: [{ label: 'Có' }, { label: 'Không' }],
      },
    ],
  };
  const invalid = JSON.parse(JSON.stringify(valid));
  invalid.questions[0] = {
    text: 'Bác có gặp các triệu chứng sau không?',
    options: [{ label: 'Đau đầu' }, { label: 'Chóng mặt' }],
  };
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify(invalid) })
    .mockResolvedValueOnce({ content: JSON.stringify(valid) });
  const pool = poolFixture();
  const result = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'quality-generation',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'generate',
  });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(JSON.parse(callTextAi.mock.calls[1][0].prompt).previous_error).toContain(
    'các biểu hiện có thể cùng xảy ra'
  );
  expect(result.content.questions[0].text).toBe(valid.questions[0].text);
});

test('does not ask onset again when the patient already gave a concrete duration', async () => {
  callTextAi.mockClear();
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: { message: 'Tôi khó ngủ hai tuần nay.' },
    conversation: [],
    profile: { birth_year: new Date().getUTCFullYear() - 68, daily_medication: 'yes' },
    medications: [],
  });
  const valid = {
    title: 'Hỏi thêm về giấc ngủ',
    questions: [
      {
        focus: 'symptom',
        text: 'Bác có thường trằn trọc khi mới lên giường không?',
        answer_kind: 'frequency',
      },
      {
        focus: 'impact',
        text: 'Tình trạng này ảnh hưởng sinh hoạt của bác thế nào?',
        answer_kind: 'impact',
      },
      { focus: 'context', text: 'Bác có uống trà trước giờ ngủ không?', answer_kind: 'yes_no' },
    ],
  };
  const invalid = JSON.parse(JSON.stringify(valid));
  invalid.questions[0] = {
    focus: 'onset',
    text: 'Bác khó ngủ bao lâu rồi?',
    answer_kind: 'numeric',
    unit: 'ngày',
    thresholds: [7, 14],
  };
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify(invalid) })
    .mockResolvedValueOnce({ content: JSON.stringify(valid) });
  const pool = poolFixture();
  const result = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'known-onset',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'generate',
  });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(JSON.parse(callTextAi.mock.calls[1][0].prompt)).toMatchObject({
    known_facts: { onset_known: true, daily_medication_known: true },
    previous_draft: invalid,
  });
  expect(result.content.questions[0].text).toBe(valid.questions[0].text);
});

const failedDraft = () => ({
  title: 'Khó ngủ',
  questions: [
    {
      focus: 'symptom',
      text: 'Bác có cảm thấy khó ngủ suốt đêm không?',
      answer_kind: 'yes_no',
    },
    {
      focus: 'impact',
      text: 'Tình trạng này ảnh hưởng đến sinh hoạt của bác thế nào?',
      answer_kind: 'impact',
    },
    {
      focus: 'context',
      text: 'Bác có uống cà phê hoặc trà vào buổi chiều không?',
      answer_kind: 'yes_no',
      suggested_red_flag_keys: [1],
    },
  ],
});
const poolFixture = ({ supplement = false } = {}) => {
  const query = jest.fn(async (sql) => ({
    rows: sql.includes('SELECT id FROM users')
      ? [{ id: 1 }]
      : sql.includes('MAX(version)')
        ? [{ n: 1 }]
        : supplement && sql.includes('SELECT is_supplement,status')
          ? [{ is_supplement: false, status: 'reported' }]
          : [],
  }));
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
};
const generate = (pool, data = {}) =>
  doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'compound-generation',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'generate',
    data,
  });

test('repairs only the coffee/tea question after a 7589ms first response, within the original budget', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const draft = failedDraft();
    const replacement = 'Bác có uống trà vào buổi chiều không?';
    callTextAi
      .mockImplementationOnce(async () => {
        now += 7589;
        return { content: JSON.stringify(draft), provider: 'openai', model: 'test' };
      })
      .mockImplementationOnce(async () => {
        now += 1000;
        return {
          content: JSON.stringify({ replacements: [{ index: 2, text: replacement }] }),
          provider: 'openai',
          model: 'test',
        };
      });
    const pool = poolFixture();
    const { content } = await generate(pool);
    expect(callTextAi).toHaveBeenCalledTimes(2);
    const request = callTextAi.mock.calls[1][0];
    expect(request).toMatchObject({ timeoutMs: 2411, maxTokens: 200, maxRetries: 0 });
    expect(JSON.parse(request.prompt)).toMatchObject({
      repair_targets: [{ index: 2, text: draft.questions[2].text }],
      kept_questions: draft.questions.slice(0, 2),
      known_facts: { onset_known: true, daily_medication_known: true },
    });
    expect(JSON.parse(request.prompt).previous_draft).toBeUndefined();
    expect(content.questions.map((q) => q.text)).toEqual([
      draft.questions[0].text,
      draft.questions[1].text,
      replacement,
      'Bác có muốn hỏi bác sĩ điều gì không?',
    ]);
    expect(content.questions[2].options[0]).toMatchObject({ suggested_red_flag: true });
    expect(content.questions[2].options.some((option) => option.red_flag)).toBe(false);
    const audit = pool.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO doctor_ivr_events')
    );
    const { reveal } = require('../src/services/doctor-ivr/ivr.service');
    expect(reveal(1, 'event', audit[1][7])).toMatchObject({
      attempt: 2,
      repairs: [{ index: 2, before: draft.questions[2].text, after: replacement }],
    });
    expect(
      pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_sessions'))
    ).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

test.each([
  { replacements: [] },
  { replacements: [{ index: 0, text: 'Bác có uống trà không?' }] },
  {
    replacements: [
      { index: 2, text: 'Bác có uống trà không?' },
      { index: 2, text: 'Bác có uống cà phê không?' },
    ],
  },
  { replacements: [{ index: 2, text: 'Bác có uống trà không?', answer_kind: 'frequency' }] },
])('rejects malformed text repairs without changing the original draft: %j', (response) => {
  const draft = failedDraft(),
    before = JSON.stringify(draft);
  expect(() => applyQuestionTextRepairs(draft, [{ index: 2 }], response)).toThrow();
  expect(JSON.stringify(draft)).toBe(before);
});

test.each([
  'Bác có uống cà phê hoặc trà trước giờ ngủ không?',
  'Bác khó ngủ bao lâu rồi?',
  'Bác có dùng thuốc hằng ngày không?',
  'Bác có cảm thấy khó ngủ suốt đêm không?',
])('revalidates repaired wording and never returns an invalid draft: %s', async (text) => {
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify(failedDraft()) })
    .mockResolvedValue({ content: JSON.stringify({ replacements: [{ index: 2, text }] }) });
  const pool = poolFixture();
  await expect(generate(pool)).rejects.toMatchObject({ code: 'IVR_GENERATION_FAILED' });
  expect(callTextAi.mock.calls.length).toBeLessThanOrEqual(3);
  expect(
    pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_events'))
  ).toBe(false);
});

test('does not start another provider call when less than 500ms remains', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    callTextAi.mockImplementationOnce(async () => {
      now += 9750;
      return { content: JSON.stringify(failedDraft()) };
    });
    await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'IVR_GENERATION_FAILED' });
    expect(callTextAi).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test('does not return provider output that arrives after the original deadline', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const draft = failedDraft();
    draft.questions[2].text = 'Bác có uống trà trước giờ ngủ không?';
    callTextAi.mockImplementationOnce(async () => {
      now += 10001;
      return { content: JSON.stringify(draft) };
    });
    await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'IVR_GENERATION_FAILED' });
    expect(callTextAi).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test('does not retry a consent rejection during repair', async () => {
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify(failedDraft()) })
    .mockRejectedValueOnce(
      Object.assign(new Error('consent withdrawn'), { code: 'AI_CONSENT_REQUIRED' })
    );
  await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(callTextAi).toHaveBeenCalledTimes(2);
});

test('repairs a one-question supplement without adding unrelated questions', async () => {
  const draft = failedDraft();
  draft.questions = [draft.questions[2]];
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(draft) }).mockResolvedValueOnce({
    content: JSON.stringify({
      replacements: [{ index: 0, text: 'Bác có uống trà buổi chiều không?' }],
    }),
  });
  const { content } = await generate(poolFixture({ supplement: true }), { supplement: true });
  expect(content.questions).toHaveLength(2);
  expect(content.questions.at(-1).id).toBe('q_final');
});

test('repairs multiple compound questions by index while preserving the order, choices and final question', async () => {
  const draft = failedDraft();
  draft.questions[0].text = 'Bác có lo âu hoặc căng thẳng trước giờ ngủ không?';
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(draft) }).mockResolvedValueOnce({
    content: JSON.stringify({
      replacements: [
        { index: 2, text: 'Bác có uống trà buổi chiều không?' },
        { index: 0, text: 'Bác có lo âu trước giờ ngủ không?' },
      ],
    }),
  });
  const { content } = await generate(poolFixture());
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(content.questions.map((question) => question.id)).toEqual(['q1', 'q2', 'q3', 'q_final']);
  expect(content.questions[0].text).toBe('Bác có lo âu trước giờ ngủ không?');
  expect(content.questions[1].text).toBe(draft.questions[1].text);
  expect(content.questions[2].text).toBe('Bác có uống trà buổi chiều không?');
  expect(content.questions[2].options[0]).toMatchObject({ label: 'Có', suggested_red_flag: true });
});

test('automatically persists an encrypted AI draft and restores it without another provider call', async () => {
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà buổi chiều không?';
  callTextAi.mockResolvedValue({ content: JSON.stringify(draft) });
  const pool = poolFixture();
  const generated = await generate(pool);
  expect(generated.question_set_id).toEqual(expect.any(String));
  expect(generated.version).toBe(1);
  const inserts = pool.query.mock.calls.filter(([sql]) =>
    sql.startsWith('INSERT INTO doctor_ivr_question_sets(')
  );
  expect(inserts).toHaveLength(1);
  const values = inserts[0][1];
  expect(values.slice(1, 7)).toEqual(['clinic-demo', 'compound-generation', 1, 1, 'draft', 'ai']);
  expect(values[7]).not.toContain(generated.content.title);
  expect(
    pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_sessions('))
  ).toBe(false);
  const fallback = pool.query.getMockImplementation();
  pool.query.mockImplementation(async (sql, args) => {
    if (sql.startsWith('SELECT * FROM doctor_ivr_question_sets'))
      return {
        rows: [
          {
            id: values[0],
            version: values[4],
            status: values[5],
            source: values[6],
            content_enc: values[7],
          },
        ],
      };
    return fallback(sql, args);
  });
  const restored = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'compound-generation',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'list',
  });
  expect(restored.question_sets[0]).toMatchObject({
    id: generated.question_set_id,
    source: 'ai',
    status: 'draft',
    content: generated.content,
  });
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('draft persistence failures do not spend more AI calls or report a successful generation', async () => {
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà buổi chiều không?';
  callTextAi.mockResolvedValue({ content: JSON.stringify(draft) });
  const pool = poolFixture();
  const fallback = pool.query.getMockImplementation();
  pool.query.mockImplementation(async (sql, args) => {
    if (sql.startsWith('INSERT INTO doctor_ivr_question_sets('))
      throw new Error('draft storage unavailable');
    return fallback(sql, args);
  });
  await expect(generate(pool)).rejects.toThrow('draft storage unavailable');
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
});

test('a task closed during generation cannot save a draft or trigger another provider call', async () => {
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà buổi chiều không?';
  callTextAi.mockResolvedValue({ content: JSON.stringify(draft) });
  const ownedTask = require('../src/services/integrations/doctor-messaging.service').loadOwnedTask;
  ownedTask
    .mockResolvedValueOnce({ lifecycle_status: 'in_progress' })
    .mockResolvedValueOnce({ lifecycle_status: 'completed' });
  const pool = poolFixture();
  await expect(generate(pool)).rejects.toMatchObject({ code: 'IVR_TASK_CLOSED' });
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(
    pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_question_sets('))
  ).toBe(false);
});
