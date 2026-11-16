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

test('a brief reply to an open question reaches the model as an unresolved clinical turn', async () => {
  const current = context();
  current.conversation.at(-1).message = 'Dạ.';
  current.latest_patient_message = current.conversation.at(-1);
  loadDoctorClinicalContext.mockResolvedValue(current);
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      patient_reply: 'Bạn nói rõ vị trí đau giúp tôi nhé?',
      understanding: {
        reply_to_message_id: '3',
        speaker: 'patient',
        subject: 'self',
        intent: 'uncertain',
        next_action: 'clarify',
        evidence: [{ message_id: '3', quote: 'Dạ.' }],
      },
    }),
  });
  const output = await createDoctorAiAssist({}, { ...input, touchpoint: 'consultation_draft' });
  expect(JSON.parse(callTextAi.mock.calls[0][0].prompt).conversation_intent).toBe('clinical');
  expect(output.patient_reply).toBe('Bạn nói rõ vị trí đau giúp tôi nhé?');
  expect(output.tools_used).toContain('grounded_turn_understanding');
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('a new measurement-context question survives validation after the value was answered', async () => {
  const current = context();
  current.conversation[0].message = 'Tôi theo dõi huyết áp từ sáng nay.';
  current.conversation[1].message = 'Chỉ số huyết áp bạn đo được là bao nhiêu?';
  current.conversation[2].message = '120/80 ạ.';
  current.latest_patient_message = current.conversation[2];
  loadDoctorClinicalContext.mockResolvedValue(current);
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ patient_reply: 'Bạn đo huyết áp khi nào?' }),
  });
  const output = await createDoctorAiAssist({}, { ...input, touchpoint: 'consultation_draft' });
  expect(output.patient_reply).toBe('Bạn đo huyết áp khi nào?');
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('a model pain-scale question reaches the specialist without a generic replacement', async () => {
  const generated = 'Trên thang điểm 0–10, cơn đau hiện tại ở mức mấy?';
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ clarifying_questions: [generated] }),
  });
  const output = await createDoctorAiAssist({}, input);
  expect(output.clarifying_questions).toEqual([generated]);
  expect(output.validation_status).toBe('valid');
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('internal summaries use the configured Doctor model instead of falling through to an unrelated provider default', async () => {
  const previousChat = process.env.DOCTOR_AI_CHAT_MODEL;
  const previousInternal = process.env.DOCTOR_AI_MODEL;
  process.env.DOCTOR_AI_CHAT_MODEL = 'doctor-chat-model';
  delete process.env.DOCTOR_AI_MODEL;
  try {
    await createDoctorAiAssist({}, { ...input, touchpoint: 'soap_note' });
    expect(callTextAi.mock.calls[0][0].model).toBe('doctor-chat-model');
    process.env.DOCTOR_AI_MODEL = 'explicit-internal-model';
    await createDoctorAiAssist({}, { ...input, touchpoint: 'patient_summary' });
    expect(callTextAi.mock.calls[1][0].model).toBe('explicit-internal-model');
  } finally {
    if (previousChat === undefined) delete process.env.DOCTOR_AI_CHAT_MODEL;
    else process.env.DOCTOR_AI_CHAT_MODEL = previousChat;
    if (previousInternal === undefined) delete process.env.DOCTOR_AI_MODEL;
    else process.env.DOCTOR_AI_MODEL = previousInternal;
  }
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
