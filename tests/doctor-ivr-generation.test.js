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
jest.mock('../src/services/ai/providers/openai', () => ({ getWhisperTranscription: jest.fn() }));
jest.mock('../src/services/checkin-call/audio.service', () => ({ synthesizeText: jest.fn() }));

const {
  loadDoctorClinicalContext,
} = require('../src/services/integrations/doctor-context.service');
const { callTextAi } = require('../src/services/ai/ai.service');
const { getWhisperTranscription } = require('../src/services/ai/providers/openai');
const { hasAiConsent } = require('../src/services/ai/ai-consent.service');
const { synthesizeText } = require('../src/services/checkin-call/audio.service');
const { doctorOperation, seal } = require('../src/services/doctor-ivr/ivr.service');
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

test('read-aloud previews use the app TTS and do not save or deliver a question set', async () => {
  const pool = poolFixture();
  const audio = { audio_data: Buffer.from('fixture'), mime_type: 'audio/wav' };
  synthesizeText.mockResolvedValueOnce(audio);
  const preview = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'generation-test',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'preview',
    data: {
      greeting: 'Chào anh/chị.',
      text: 'Anh/chị có khó ngủ không?',
      options: [
        { key: 1, label: 'Có' },
        { key: 2, label: 'Không' },
      ],
    },
  });
  expect(preview).toBe(audio);
  expect(synthesizeText).toHaveBeenCalledWith(
    'Chào anh/chị. Anh/chị có khó ngủ không? Một: Có. Hai: Không.',
    'vi',
    { timeoutMs: 25000 }
  );
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});

test('does not synthesize interview audio when the patient has not consented', async () => {
  hasAiConsent.mockResolvedValueOnce(false);
  await expect(
    doctorOperation(poolFixture(), {
      tenant_id: 'clinic-demo',
      task_id: 'generation-test',
      app_user_id: '1',
      doctor_id: 'doctor-test',
      operation: 'preview',
    })
  ).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(synthesizeText).not.toHaveBeenCalled();
});

test('does not load the consultation profile for question generation without AI consent', async () => {
  hasAiConsent.mockResolvedValueOnce(false);
  await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(loadDoctorClinicalContext).not.toHaveBeenCalled();
  expect(callTextAi).not.toHaveBeenCalled();
});

test('question generation receives authorized intake, profile, dated health records and earlier answered questions', async () => {
  process.env.DOCTOR_IVR_ENABLED = 'true';
  process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
  const year = new Date().getUTCFullYear();
  const clinicalIntake = { symptom_onset: 'today', progression: 'stable', severity: 'moderate' };
  const screening = { screened_at: '2026-10-20T09:00:00Z', screening_version: 'consultation-v2' };
  const bloodPressure = {
    systolic: 120,
    diastolic: 79,
    unit: 'mmHg',
    occurred_at: '2026-10-15T07:00:00Z',
  };
  const glucose = {
    value: 120,
    unit: 'mg/dL',
    context: 'before_meal',
    occurred_at: '2026-10-16T05:00:00Z',
  };
  const checkin = { session_date: '2026-10-19', triage_summary: 'Người bệnh báo khó ngủ' };
  const medicine = {
    med_name: 'Thuốc đã khai báo',
    dose_text: '1 viên',
    occurred_at: '2026-10-17T12:00:00Z',
    source: 'reminder',
  };
  const symptom = { symptom_name: 'Khó ngủ', occurred_date: '2026-10-19' };
  const medicalRecord = {
    record_type: 'consultation_summary',
    summary: 'Lần khám đã ghi nhận tăng huyết áp',
    recorded_at: '2026-10-13T08:00:00Z',
  };
  const initialStatement = {
    message: 'Tôi khó ngủ gần đây.\n\nVấn đề này bắt đầu từ khi nào?: Hôm nay',
  };
  const previousQuestion = 'Bác đo huyết áp được bao nhiêu?';
  const previousAnswer = '128/80 mmHg';
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: initialStatement,
    clinical_intake: clinicalIntake,
    legal_screening: screening,
    conversation: [
      { ...initialStatement, role: 'patient', source: 'intake' },
      { role: 'doctor', message: previousQuestion },
      { role: 'patient', message: previousAnswer },
      ...Array.from({ length: 12 }, () => ({ role: 'patient', message: 'Tình trạng vẫn vậy.' })),
    ],
    profile: {
      birth_year: year - 68,
      gender: 'female',
      conditions: ['Tăng huyết áp'],
      chronic_symptoms: ['Khó ngủ'],
      daily_medication: true,
      allergies: ['Dị ứng đã khai báo'],
    },
    blood_pressure: [bloodPressure],
    glucose: [glucose],
    checkins: [{ ...checkin, id: 'fixture-checkin' }],
    symptoms: [symptom],
    medications: [medicine],
    medical_records: [medicalRecord],
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
  expect(prompt).toMatchObject({
    task: initialStatement,
    consultation_intake: { answers: clinicalIntake, screening },
    observations: { blood_pressure: [bloodPressure], glucose: [glucose], symptoms: [symptom] },
    medications: [medicine],
    medical_records: [medicalRecord],
  });
  expect(prompt.observations.checkins).toEqual([checkin]);
  expect(prompt.conversation).toHaveLength(12);
  expect(prompt.answered_questions).toContainEqual({
    question: previousQuestion,
    patient_answer: previousAnswer,
    topics: ['blood_pressure'],
  });
});

test.each([
  [{ age: 22, gender: 'Nam' }, 'anh'],
  [{ age: 32, gender: 'nữ' }, 'chị'],
  [{ age: 67, gender: 'male' }, 'bác'],
  [{ age: 14, gender: 'female' }, 'em'],
  [{ age: 32 }, 'bạn'],
])('uses the IVR patient profile address consistently for %j', async (profile, expected) => {
  const fixture = poolFixture();
  const query = fixture.query.getMockImplementation();
  fixture.query.mockImplementation(async (sql) =>
    sql.includes('SELECT birth_year, age, gender') ? { rows: [profile] } : query(sql)
  );
  const input = {
    tenant_id: 'clinic-demo',
    task_id: 'address-test',
    app_user_id: '1',
    doctor_id: 'doctor-test',
  };
  const capitalized = expected[0].toLocaleUpperCase('vi') + expected.slice(1);
  const draft = failedDraft();
  draft.questions[0].text = 'Anh/chị có khó ngủ suốt đêm không?';
  draft.questions[2].text = 'Anh/chị có uống trà trước giờ ngủ không?';
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(draft) });
  const listed = await doctorOperation(fixture, { ...input, operation: 'list' });
  const generated = await doctorOperation(fixture, { ...input, operation: 'generate' });
  expect(listed.patient_address).toBe(expected);
  expect(JSON.parse(callTextAi.mock.calls[0][0].prompt).address).toBe(capitalized);
  expect(generated.content.questions[0].text).toBe(capitalized + ' có khó ngủ suốt đêm không?');
  expect(generated.content.greeting).toContain('Chào ' + expected + '.');
  expect(generated.content.questions.at(-1).text).toBe(
    capitalized + ' có muốn hỏi bác sĩ điều gì không?'
  );
});

test('accepts seven distinct unanswered topics plus the fixed final question', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: { message: 'Tôi bị khó ngủ.' },
    conversation: [],
    profile: { age: 68 },
    medications: [],
  });
  const questions = [
    ['symptom', 'Bác có thức giấc giữa đêm không?'],
    ['onset', 'Bác bắt đầu khó ngủ từ tuần này phải không?'],
    ['course', 'Gần đây bác có khó ngủ hơn không?'],
    ['impact', 'Tình trạng này ảnh hưởng sinh hoạt của bác thế nào?'],
    ['context', 'Bác có uống trà trước giờ ngủ không?'],
    ['safety', 'Bác có bị khó thở lúc nằm không?'],
    ['medication', 'Bác có mới đổi thuốc gần đây không?'],
  ].map(([focus, text]) => ({
    focus,
    text,
    answer_kind: focus === 'impact' ? 'impact' : 'yes_no',
  }));
  callTextAi.mockResolvedValueOnce({
    content: JSON.stringify({ title: 'Hỏi thêm về giấc ngủ', questions }),
  });
  const result = await generate(poolFixture());
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(callTextAi.mock.calls[0][0].system).toContain('Tạo từ 3 đến 7 câu nội dung');
  expect(result.content.questions).toHaveLength(8);
  expect(result.content.questions.at(-1)).toMatchObject({ id: 'q_final', fixed: true });
});

test('can ask about how pain began, measurements and separate medication details in one first session', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    initial_patient_statement: { message: 'Tôi đau đầu từ sáng nay, đã dùng thuốc giảm đau.' },
    profile: { age: 31, gender: 'male', conditions: ['Tăng huyết áp', 'Tiểu đường'] },
    clinical_intake: { symptom_onset: 'today', progression: 'stable', severity: 'moderate' },
    conversation: [],
  });
  const question = (focus, text, options) => ({
    focus,
    text,
    answer_kind: options ? 'single_choice' : 'yes_no',
    ...(options ? { options: options.map((label) => ({ label })) } : {}),
  });
  const numeric = (focus, text, unit, thresholds) => ({
    focus,
    text,
    unit,
    thresholds,
    answer_kind: 'numeric',
  });
  const questions = [
    question('onset_pattern', 'Cơn đau có dữ dội ngay khi bắt đầu không?'),
    question('safety', 'Lúc đau đầu, anh có thấy khó nói không?'),
    question('symptom', 'Cơn đau tập trung chủ yếu ở đâu?', ['Một bên đầu', 'Cả đầu']),
    numeric(
      'blood_pressure_systolic',
      'Số trên của huyết áp lúc đau đầu nằm trong khoảng nào?',
      'mmHg',
      [120, 140]
    ),
    numeric('glucose', 'Đường huyết lúc đau đầu nằm trong khoảng nào?', 'mg/dL', [100, 150]),
    numeric('medication_time', 'Anh uống thuốc giảm đau cách đây bao lâu?', 'giờ', [1, 3]),
    question('medication_dose', 'Anh đã uống bao nhiêu viên thuốc giảm đau?', [
      'Một viên',
      'Hai viên',
    ]),
  ];
  const title = 'Hỏi thêm về đau đầu';
  callTextAi
    .mockResolvedValueOnce({
      content: JSON.stringify({
        title,
        questions: [
          questions[0],
          questions[1],
          question('blood_pressure_systolic', 'Anh đã đo huyết áp chưa?'),
        ],
      }),
    })
    .mockResolvedValueOnce({ content: JSON.stringify({ title, questions }) });
  const result = await generate(poolFixture());
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(JSON.parse(callTextAi.mock.calls[1][0].prompt).previous_error).toContain(
    'Hỏi trị số hoặc lượng thuốc'
  );
  expect(result.content.questions.map((q) => q.text).slice(0, -1)).toEqual(
    questions.map((q) => q.text)
  );
  expect(result.content.questions[3].options.at(-1)).toMatchObject({ type: 'voice' });
  expect(result.content.questions.at(-1)).toMatchObject({ id: 'q_final', fixed: true });
});

test('repairs AI questions that ask patients to score pain on a numerical scale', async () => {
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà trước giờ ngủ không?';
  const painScore = {
    focus: 'symptom',
    text: 'Mức đau đầu hiện tại của bác là bao nhiêu điểm trên thang 0 đến 10?',
    answer_kind: 'numeric',
    unit: 'điểm',
    thresholds: [3, 6],
  };
  const simplerPainQuestion = {
    focus: 'symptom',
    text: 'Bây giờ cơn đau đầu thế nào?',
    answer_kind: 'single_choice',
    options: [{ label: 'Đau nhẹ' }, { label: 'Đau vừa' }, { label: 'Đau nhiều' }],
  };
  callTextAi
    .mockResolvedValueOnce({
      content: JSON.stringify({ ...draft, questions: [painScore, ...draft.questions.slice(1)] }),
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({
        ...draft,
        questions: [simplerPainQuestion, ...draft.questions.slice(1)],
      }),
    });
  const result = await generate(poolFixture());
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(JSON.parse(callTextAi.mock.calls[1][0].prompt).previous_error).toContain(
    'Không hỏi tự chấm điểm'
  );
  expect(result.content.questions[0].text).toBe(simplerPainQuestion.text);
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
  const firstSession = supplement && {
    id: 'first-session',
    user_id: 1,
    status: 'reported',
    is_supplement: false,
    content_enc: seal(1, 'question-set', { questions: [] }),
  };
  const query = jest.fn(async (sql) => ({
    rows: sql.includes('FROM users WHERE id=$1 AND deleted_at IS NULL')
      ? [{ id: 1, language_preference: 'vi' }]
      : sql.includes('MAX(version)')
        ? [{ n: 1 }]
        : firstSession &&
            (sql.includes('SELECT id, is_supplement, status') ||
              sql.includes('SELECT s.*,q.content_enc'))
          ? [firstSession]
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
    await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'IVR_GENERATION_TIMEOUT' });
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
    await expect(generate(poolFixture())).rejects.toMatchObject({ code: 'IVR_GENERATION_TIMEOUT' });
    expect(callTextAi).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test('accepts a valid draft that arrives within a configured longer deadline', async () => {
  const previousTimeout = process.env.DOCTOR_IVR_QUESTION_TIMEOUT_MS;
  process.env.DOCTOR_IVR_QUESTION_TIMEOUT_MS = '25000';
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const draft = failedDraft();
    draft.questions[2].text = 'Bác có uống trà trước giờ ngủ không?';
    callTextAi.mockImplementationOnce(async () => {
      now += 12000;
      return { content: JSON.stringify(draft) };
    });
    const { content } = await generate(poolFixture());
    expect(content.questions).toHaveLength(4);
    expect(callTextAi).toHaveBeenCalledTimes(1);
    expect(callTextAi.mock.calls[0][0]).toMatchObject({ timeoutMs: 25000 });
  } finally {
    clock.mockRestore();
    if (previousTimeout === undefined) delete process.env.DOCTOR_IVR_QUESTION_TIMEOUT_MS;
    else process.env.DOCTOR_IVR_QUESTION_TIMEOUT_MS = previousTimeout;
  }
});

test('reports provider timeouts distinctly and does not repeat the request', async () => {
  callTextAi.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'AbortError' }));
  await expect(generate(poolFixture())).rejects.toMatchObject({
    code: 'IVR_GENERATION_TIMEOUT',
    statusCode: 504,
  });
  expect(callTextAi).toHaveBeenCalledTimes(1);
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

test('a supplement covers more than seven distinct topics requested by the specialist', async () => {
  const symptoms = ['buồn nôn', 'chóng mặt', 'mất ngủ', 'mệt', 'đau họng', 'sốt'];
  const note = `Hỏi lượng thuốc giảm đau và thuốc ho đã uống. Hỏi riêng về ${symptoms.join(', ')}.`;
  const draft = {
    title: 'Lượng thuốc đã dùng',
    questions: [
      {
        text: 'Bác đã uống bao nhiêu viên thuốc giảm đau?',
        focus: 'medication_dose',
        answer_kind: 'single_choice',
        options: [{ label: 'Một viên' }, { label: 'Hai viên' }],
      },
      {
        text: 'Bác đã uống bao nhiêu viên thuốc ho?',
        focus: 'medication_dose',
        answer_kind: 'single_choice',
        options: [{ label: 'Một viên' }, { label: 'Hai viên' }],
      },
      ...symptoms.map((symptom) => ({
        text: `Bác có bị ${symptom} không?`,
        focus: 'associated_symptom',
        answer_kind: 'yes_no',
      })),
    ],
  };
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify(draft) });
  const { content } = await generate(poolFixture({ supplement: true }), {
    supplement: true,
    supplement_request: `  ${note}  `,
  });
  const providerRequest = callTextAi.mock.calls[0][0];
  expect(JSON.parse(providerRequest.prompt)).toMatchObject({
    supplement_request: note,
    required_content_questions: 'Theo các ý cần hỏi, ít nhất 1',
    max_duration_seconds: 300,
  });
  expect(providerRequest.system).toContain('Không thêm chủ đề khác cho đủ số');
  expect(content.questions).toHaveLength(9);
  expect(content.questions.at(-2).text).toBe('Bác có bị sốt không?');
  expect(content.questions.at(-1).id).toBe('q_final');
  expect(content.questions[0].options.map((item) => item.label)).toEqual([
    'Một viên',
    'Hai viên',
    'Khác, nói câu trả lời',
  ]);
});

test('a supplementary plan that exceeds five minutes asks the specialist to shorten the notes', async () => {
  callTextAi.mockResolvedValueOnce({ content: '{"follow_up_duration_exceeded":true}' });
  await expect(
    generate(poolFixture({ supplement: true }), {
      supplement: true,
      supplement_request: 'Hỏi kỹ các mục trong ghi chú bệnh nhân.',
    })
  ).rejects.toMatchObject({
    code: 'IVR_SUPPLEMENT_DURATION_LIMIT',
    statusCode: 422,
    message: expect.stringContaining('5 phút'),
  });
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test.each(['Chỉnh cách hỏi để người bệnh dễ chọn thời điểm.', ''])(
  'regenerates an unsent supplement with feedback %j and leaves approval to the specialist',
  async (feedback) => {
    const pool = poolFixture({ supplement: true });
    const note = 'Hỏi thời điểm uống thuốc giảm đau.';
    const revision = {
      title: 'Thuốc đã dùng',
      questions: [{ text: 'Bác uống thuốc giảm đau lúc nào?', options: ['Sáng', 'Chiều'] }],
      feedback,
    };
    callTextAi.mockResolvedValueOnce({ content: JSON.stringify({
      title: 'Giờ dùng thuốc',
      questions: [{
        text: 'Bác uống thuốc giảm đau vào buổi nào?',
        focus: 'medication_time',
        answer_kind: 'single_choice',
        options: [{ label: 'Buổi sáng' }, { label: 'Buổi chiều' }, { label: 'Buổi tối' }],
      }],
    }) });
    const { content } = await generate(pool, {
      supplement: true,
      ...(feedback ? { supplement_request: note } : {}),
      supplement_revision: revision,
    });
    const request = callTextAi.mock.calls[0][0];
    expect(JSON.parse(request.prompt)).toMatchObject({
      ...(feedback ? { supplement_request: note } : {}),
      supplement_revision: revision,
      previous_intake: expect.any(Array),
    });
    expect(request.system).toContain('Khi góp ý trống, giữ phạm vi câu hỏi');
    expect(content.questions[0].options.map((option) => option.label)).toEqual([
      'Buổi sáng', 'Buổi chiều', 'Buổi tối', 'Khác, nói câu trả lời',
    ]);
    expect(content.questions.at(-1).fixed).toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_sessions'))).toBe(false);
  }
);

test('requires a supplement and either draft content or revision feedback', async () => {
  const revision = { title: 'Hỏi thêm', questions: [], feedback: '' };
  const pool = poolFixture({ supplement: true });
  await expect(generate(pool, { supplement: true, supplement_revision: revision }))
    .rejects.toMatchObject({ code: 'IVR_INVALID_SUPPLEMENT_REVISION' });
  await expect(generate(pool, {
    supplement: false, supplement_revision: { ...revision, feedback: 'Hỏi ngắn hơn.' },
  })).rejects.toMatchObject({ code: 'IVR_INVALID_SUPPLEMENT_REVISION' });
  expect(callTextAi).not.toHaveBeenCalled();
});

test.each([
  { supplement: true, supplement_request: '  ' },
  { supplement: true, supplement_request: 'a'.repeat(1201) },
  { supplement: false, supplement_request: 'Hỏi thêm vị trí đau.' },
])('rejects invalid specialist notes before generation', async (data) => {
  await expect(generate(poolFixture({ supplement: true }), data)).rejects.toMatchObject({
    code: 'IVR_INVALID_SUPPLEMENT_REQUEST',
  });
  expect(callTextAi).not.toHaveBeenCalled();
});

test('dictation turns clinician audio into editable text without saving or sending a question set', async () => {
  const pool = poolFixture({ supplement: true });
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const input = {
    tenant_id: 'clinic-demo',
    task_id: 'dictation-task',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'dictate',
    data: { mime_type: 'audio/webm', audio_base64: bytes.toString('base64') },
  };
  getWhisperTranscription.mockResolvedValueOnce('  Hỏi vị trí đau. ');
  await expect(doctorOperation(pool, input)).resolves.toEqual({ text: 'Hỏi vị trí đau.' });
  expect(getWhisperTranscription).toHaveBeenCalledWith(bytes, 'dictation.webm', 'vi');
  expect(pool.query.mock.calls.some(([sql]) => /^INSERT/iu.test(sql))).toBe(false);
  expect(callTextAi).not.toHaveBeenCalled();

  await expect(
    doctorOperation(pool, { ...input, data: { ...input.data, audio_base64: 'YQ==' } })
  ).rejects.toMatchObject({ code: 'IVR_INVALID_DICTATION' });
  hasAiConsent.mockResolvedValueOnce(false);
  await expect(doctorOperation(pool, input)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(getWhisperTranscription).toHaveBeenCalledTimes(1);
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

test('creates an editable AI draft and persists it only on explicit save', async () => {
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà buổi chiều không?';
  callTextAi.mockResolvedValue({ content: JSON.stringify(draft) });
  const pool = poolFixture();
  const generated = await generate(pool);
  expect(generated.question_set_id).toBeUndefined();
  expect(
    pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO doctor_ivr_question_sets('))
  ).toBe(false);
  const saved = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'compound-generation',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'save',
    data: { content: generated.content, source: 'ai' },
  });
  expect(saved.question_set_id).toEqual(expect.any(String));
  expect(saved.version).toBe(1);
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
    if (sql.includes('FROM doctor_ivr_question_sets q'))
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
    id: saved.question_set_id,
    source: 'ai',
    status: 'draft',
    content: generated.content,
  });
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('reports explicit save failures without calling the generator again', async () => {
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
  const generated = await generate(pool);
  await expect(
    doctorOperation(pool, {
      tenant_id: 'clinic-demo',
      task_id: 'compound-generation',
      app_user_id: '1',
      doctor_id: 'doctor-test',
      operation: 'save',
      data: { content: generated.content, source: 'ai' },
    })
  ).rejects.toThrow('draft storage unavailable');
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
});

test('lists deliberate saves and hides only legacy generated autosaves', async () => {
  const { seal } = require('../src/services/doctor-ivr/ivr.service');
  const draft = failedDraft();
  draft.questions[2].text = 'Bác có uống trà buổi chiều không?';
  callTextAi.mockResolvedValue({ content: JSON.stringify(draft) });
  const pool = poolFixture();
  const { content } = await generate(pool);
  const fallback = pool.query.getMockImplementation();
  const row = (version, priorType, explicit) => ({
    id: 'draft-' + version,
    version,
    status: 'draft',
    source: 'ai',
    content_enc: seal(1, 'question-set', content),
    saved_event: seal(1, 'event', { version, explicit, content }),
    prior_type: priorType,
    prior_event: seal(1, 'event', { content }),
  });
  pool.query.mockImplementation(async (sql, args) =>
    sql.includes('FROM doctor_ivr_question_sets q')
      ? {
          rows: [
            row(3, 'question_set.generated', undefined),
            row(2, 'question_set.generated', true),
            row(1, 'question_set.saved', undefined),
          ],
        }
      : fallback(sql, args)
  );
  const result = await doctorOperation(pool, {
    tenant_id: 'clinic-demo',
    task_id: 'compound-generation',
    app_user_id: '1',
    doctor_id: 'doctor-test',
    operation: 'list',
  });
  expect(result.question_sets.map((value) => value.id)).toEqual(['draft-2', 'draft-1']);
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
