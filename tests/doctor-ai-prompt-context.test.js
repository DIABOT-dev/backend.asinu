jest.mock('../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../src/services/ai/ai-logger.service', () => ({ logAiInteraction: jest.fn() }));
jest.mock('../src/services/integrations/doctor-context.service', () => ({
  loadDoctorClinicalContext: jest.fn(),
}));

const { callTextAi } = require('../src/services/ai/ai.service');
const {
  loadDoctorClinicalContext,
} = require('../src/services/integrations/doctor-context.service');
const { createDoctorAiAssist } = require('../src/services/integrations/doctor-ai.service');

const input = {
  app_user_id: '42',
  task_summary: 'Tôi đau bụng từ sáng nay.',
  touchpoint: 'suggested_questions',
  locale: 'vi',
  clinical_support: { rules: [], knowledge_chunks: [], policy_version: 'a'.repeat(64) },
};
const context = () => ({
  profile: {},
  blood_pressure: [],
  glucose: [],
  medications: [],
  symptoms: [],
  checkins: [],
  medical_records: [],
  missing_data: [],
  conflicts: [],
  health_timeline_markdown: '',
  context_version: '3',
  context_hash: 'b'.repeat(64),
  conversation: [
    { id: '1', role: 'patient', message: 'Tôi đau bụng từ sáng nay.' },
    { id: '2', role: 'doctor', message: 'Bạn đau ở vùng nào của bụng?' },
    { id: '3', role: 'patient', message: 'Quanh rốn ạ.' },
  ],
  latest_patient_message: { id: '3', role: 'patient', message: 'Quanh rốn ạ.' },
});

beforeEach(() => {
  jest.resetAllMocks();
  loadDoctorClinicalContext.mockResolvedValue(context());
  callTextAi.mockResolvedValue({
    provider: 'medgemma',
    model: 'synthetic',
    content: JSON.stringify({
      clarifying_questions: ['Cơn đau liên tục hay từng cơn?', 'Bạn có buồn nôn không?'],
    }),
  });
});

test('the generated questions retain the real question/answer pair and current concern through the whole pipeline', async () => {
  const result = await createDoctorAiAssist({}, input);
  const request = callTextAi.mock.calls[0][0];
  const payload = JSON.parse(request.prompt);
  expect(payload.question_to_answer_now.message).toBe('Quanh rốn ạ.');
  expect(payload.latest_specialist_message.message).toBe('Bạn đau ở vùng nào của bụng?');
  expect(payload.paired_answers).toContainEqual({
    question: 'Bạn đau ở vùng nào của bụng?',
    answer: 'Quanh rốn ạ.',
    topics: ['location'],
  });
  expect(payload.recent_conversation.map((turn) => turn.role)).toEqual([
    'patient',
    'doctor',
    'patient',
  ]);
  expect(request.system).toContain('not a fixed questionnaire');
  expect(payload.deterministic_tools.next_question_plan).toEqual([]);
  expect(payload.answered_questions_do_not_repeat).toEqual([
    {
      question: 'When did the current symptom start or how long has it been present?',
      patient_answer: 'Tôi đau bụng từ sáng nay.',
      topics: ['duration'],
    },
    {
      question: 'Bạn đau ở vùng nào của bụng?',
      patient_answer: 'Quanh rốn ạ.',
      topics: ['location'],
    },
  ]);
  expect(
    payload.deterministic_tools.additional_unanswered_topics.every((item) => !item.question)
  ).toBe(true);
  expect(result.clarifying_questions).toEqual([
    'Cơn đau liên tục hay từng cơn?',
    'Bạn có buồn nôn không?',
  ]);
  expect(result.patient_reply).toBe('');
});

test('a scheduling message cannot make the pipeline discard a valid pending patient reply', async () => {
  const current = context();
  current.conversation.push({
    role: 'doctor',
    sender_ref: 'doctor-sla-worker',
    message: 'Ca tư vấn đang được ưu tiên xử lý.',
  });
  loadDoctorClinicalContext.mockResolvedValue(current);
  const output = await createDoctorAiAssist({}, input);
  expect(output.clarifying_questions).toHaveLength(2);
  const payload = JSON.parse(callTextAi.mock.calls[0][0].prompt);
  expect(payload.recent_conversation).toHaveLength(3);
});

test('the provider receives a consistent specialist voice and patient address, including fallback safety questions', async () => {
  const current = context();
  current.conversation[1].message = 'Em hỏi thêm. Bác đau ở vùng nào của bụng ạ?';
  loadDoctorClinicalContext.mockResolvedValue(current);
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ clarifying_questions: ['Bác có buồn nôn không ạ?'] }),
  });
  const output = await createDoctorAiAssist({}, input);
  const request = callTextAi.mock.calls[0][0];
  expect(JSON.parse(request.prompt).communication_style).toMatchObject({
    patient_address: 'bác',
    clinician_self: 'em',
    source: 'conversation',
  });
  expect(request.system).toContain('gọi người đang nhắn là "bác"');
  expect(request.system).toContain('chuyên gia xưng "em"');
  expect(output.clarifying_questions).toEqual(['Bác có buồn nôn không ạ?']);
});

test('a wrong-address model response is regenerated rather than silently rewritten', async () => {
  const current = context();
  current.conversation[1].message = 'Em hỏi thêm. Bác đau ở vùng nào của bụng ạ?';
  loadDoctorClinicalContext.mockResolvedValue(current);
  const systems = [];
  callTextAi
    .mockImplementationOnce(async (request) => {
      systems.push(request.system);
      return { content: JSON.stringify({ clarifying_questions: ['Bạn có buồn nôn không?'] }) };
    })
    .mockImplementationOnce(async (request) => {
      systems.push(request.system);
      return { content: JSON.stringify({ clarifying_questions: ['Bác có buồn nôn không ạ?'] }) };
    });
  const output = await createDoctorAiAssist({}, input);
  expect(output.clarifying_questions).toEqual(['Bác có buồn nôn không ạ?']);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(systems[1]).toContain('Use the selected communication_style consistently');
  expect(systems[1]).toContain('Never diagnose, prescribe');
  const retryPrompt = JSON.parse(callTextAi.mock.calls[1][0].prompt);
  expect(retryPrompt.validation_feedback.already_answered_topics).toEqual(['duration', 'location']);
  expect(retryPrompt.recent_conversation).toEqual(current.conversation);
});

test.each(['consultation_draft', 'follow_up_draft'])(
  'a %s cannot change the established address',
  async (touchpoint) => {
    const current = context();
    current.conversation[1].message = 'Bác đau ở vùng nào của bụng?';
    loadDoctorClinicalContext.mockResolvedValue(current);
    const field = touchpoint === 'consultation_draft' ? 'patient_reply' : 'follow_up_draft';
    callTextAi.mockResolvedValue({
      content: JSON.stringify({ [field]: 'Chị có buồn nôn không?' }),
    });
    await expect(createDoctorAiAssist({}, { ...input, touchpoint })).rejects.toMatchObject({
      code: 'DOCTOR_AI_INVALID_RESPONSE',
    });
    expect(callTextAi).toHaveBeenCalledTimes(3);
  }
);

test('the opening complaint supports a consultation draft without a synthetic patient-message version', async () => {
  const current = context();
  current.initial_patient_statement = {
    ...current.conversation[0],
    id: 'intake:task-1',
    source: 'intake',
  };
  current.conversation = [current.initial_patient_statement];
  current.latest_patient_message = null;
  current.context_version = '0';
  loadDoctorClinicalContext.mockResolvedValue(current);
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ patient_reply: 'Bạn đau ở vùng nào của bụng?' }),
  });
  const output = await createDoctorAiAssist({}, { ...input, touchpoint: 'consultation_draft' });
  expect(output.patient_reply).toBe('Bạn đau ở vùng nào của bụng?');
  expect(output.context_version).toBe('0');
  expect(JSON.parse(callTextAi.mock.calls[0][0].prompt).question_to_answer_now.source).toBe(
    'intake'
  );
});

test('the complete consultation reaches the provider without cutting older turns or the middle of a message', async () => {
  const current = context();
  current.conversation = Array.from({ length: 120 }, (_, i) => ({
    id: String(i + 1),
    role: i % 2 ? 'patient' : 'doctor',
    message: `${i === 1 ? 'Câu trả lời đầu cuộc trao đổi: ba ngày. ' : ''}${'Nội dung kiểm thử. '.repeat(250)}Thông tin ở giữa tin nhắn phải được giữ.${' Nội dung kiểm thử.'.repeat(250)}`,
  }));
  current.latest_patient_message = current.conversation.at(-1);
  loadDoctorClinicalContext.mockResolvedValue(current);
  await createDoctorAiAssist({}, input);
  const turns = JSON.parse(callTextAi.mock.calls[0][0].prompt).recent_conversation;
  expect(turns).toHaveLength(120);
  expect(turns[1].message).toContain('Câu trả lời đầu cuộc trao đổi: ba ngày.');
  expect(turns.map((turn) => turn.id)).toEqual(current.conversation.map((turn) => turn.id));
  expect(turns.map((turn) => turn.message)).toEqual(
    current.conversation.map((turn) => turn.message)
  );
  expect(turns[1].message).toContain('Thông tin ở giữa tin nhắn phải được giữ.');
});
