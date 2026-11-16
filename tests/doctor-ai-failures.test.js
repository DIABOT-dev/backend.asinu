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
  app_user_id: '1',
  task_summary: 'Synthetic test',
  touchpoint: 'consultation_draft',
  locale: 'vi',
  clinical_support: { rules: [], knowledge_chunks: [] },
};

beforeEach(() => {
  jest.resetAllMocks();
  loadDoctorClinicalContext.mockResolvedValue({
    latest_patient_message: { message: 'Synthetic connection test.' },
    conversation: [],
    profile: {},
    blood_pressure: [],
    glucose: [],
    medications: [],
    symptoms: [],
    checkins: [],
    medical_records: [],
    missing_data: [],
    conflicts: [],
  });
});

test('clinical AI exposes exhausted provider credit without fallback or repeated generation', async () => {
  callTextAi.mockRejectedValue(
    Object.assign(new Error('MedGemma API 402'), {
      status: 402,
      code: 'MEDGEMMA_INSUFFICIENT_CREDIT',
    })
  );
  const previousProvider = process.env.DOCTOR_AI_PROVIDER;
  process.env.DOCTOR_AI_PROVIDER = 'medgemma';
  try {
    await expect(createDoctorAiAssist({}, input)).rejects.toMatchObject({
      statusCode: 503,
      code: 'DOCTOR_AI_QUOTA_EXCEEDED',
    });
    expect(callTextAi).toHaveBeenCalledTimes(1);
    expect(callTextAi.mock.calls[0][0]).toMatchObject({
      provider: 'medgemma',
      strictProvider: true,
    });
  } finally {
    if (previousProvider === undefined) delete process.env.DOCTOR_AI_PROVIDER;
    else process.env.DOCTOR_AI_PROVIDER = previousProvider;
  }
});

test('regenerates an empty draft with corrective feedback, then returns the valid draft', async () => {
  const systems = [];
  callTextAi
    .mockImplementationOnce(async (request) => {
      systems.push(request.system);
      return { content: '{}' };
    })
    .mockImplementationOnce(async (request) => {
      systems.push(request.system);
      return {
        content: JSON.stringify({ patient_reply: 'Bạn đang cần hỗ trợ điều gì?' }),
        provider: 'medgemma',
        model: 'synthetic',
      };
    });
  const result = await createDoctorAiAssist({}, input);
  expect(result.patient_reply).toBe('Bạn đang cần hỗ trợ điều gì?');
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(systems[1]).toContain('left patient_reply empty');
  expect(systems[1]).toContain('Never diagnose, prescribe');
  expect(systems[0]).not.toContain('OUTPUT CORRECTION');
});

test('regeneration retains all earlier corrections instead of oscillating between failures', async () => {
  const systems = [];
  for (const reply of ['', 'Tôi là bác sĩ, bạn cần hỗ trợ gì?', 'Bạn muốn trao đổi điều gì?'])
    callTextAi.mockImplementationOnce(async (request) => {
      systems.push(request.system);
      return { content: JSON.stringify({ patient_reply: reply }) };
    });
  await createDoctorAiAssist({}, input);
  expect(systems[2]).toContain('left patient_reply empty');
  expect(systems[2]).toContain('Use chuyên gia');
});

test('a recordkeeping question gets a practical answer before more symptom collection', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    conversation: [],
    latest_patient_message: { message: 'Em đau bụng. Em nên theo dõi thế nào?' },
    missing_data: [],
    conflicts: [],
  });
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify({ patient_reply: 'Em đau vào lúc nào?' }) })
    .mockResolvedValueOnce({
      content: JSON.stringify({ patient_reply: 'Em nên ghi lại giờ đau và mức độ đau.' }),
    });
  const result = await createDoctorAiAssist({}, input);
  expect(result.patient_reply).toContain('ghi lại');
  expect(callTextAi).toHaveBeenCalledTimes(2);
});

test('a recordkeeping request cannot suppress an urgent care response', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    conversation: [],
    latest_patient_message: { message: 'Em nên ghi lại thế nào?' },
    missing_data: [],
    conflicts: [],
  });
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ patient_reply: 'Bạn cần đến cơ sở y tế ngay.', urgency: 'urgent' }),
  });
  expect((await createDoctorAiAssist({}, input)).urgency).toBe('urgent');
});

test('foreign emergency numbers from reference text are not copied into Vietnamese advice', async () => {
  callTextAi
    .mockResolvedValueOnce({ content: JSON.stringify({ patient_reply: 'Bạn cần gọi 999 ngay.' }) })
    .mockResolvedValueOnce({
      content: JSON.stringify({ patient_reply: 'Bạn cần đến cơ sở y tế ngay.' }),
    });
  const result = await createDoctorAiAssist({}, input);
  expect(result.patient_reply).toBe('Bạn cần đến cơ sở y tế ngay.');
  expect(callTextAi.mock.calls[1][0].system).toContain('foreign emergency number');
});

test.each([
  'Chưa đủ dữ liệu để chẩn đoán tăng huyết áp qua trao đổi này.',
  'Để chẩn đoán tăng huyết áp cần có sự đánh giá qua nhiều lần đo.',
])(
  'uncertainty and requirements for clinician assessment are not an AI diagnosis: %s',
  async (patient_reply) => {
    callTextAi.mockResolvedValue({ content: JSON.stringify({ patient_reply }) });
    expect((await createDoctorAiAssist({}, input)).patient_reply).toBe(patient_reply);
    expect(callTextAi).toHaveBeenCalledTimes(1);
  }
);

test.each([
  'Chẩn đoán của bạn là tăng huyết áp.',
  'Chưa đủ dữ liệu để chẩn đoán, bạn nên dùng metformin 500 mg.',
])(
  'the assessment wording exception still rejects diagnosis and prescribing: %s',
  async (patient_reply) => {
    callTextAi.mockResolvedValue({ content: JSON.stringify({ patient_reply }) });
    await expect(createDoctorAiAssist({}, input)).rejects.toMatchObject({
      code: 'DOCTOR_AI_INVALID_RESPONSE',
    });
  }
);

test('a redundant greeting is removed and a referral for clinician diagnosis remains valid', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    conversation: [
      { role: 'patient', message: 'Tôi đau bụng.' },
      { role: 'doctor', message: 'Bạn đau bao lâu?' },
      { role: 'patient', message: 'Ba ngày.' },
    ],
    latest_patient_message: { message: 'Ba ngày.' },
    missing_data: [],
    conflicts: [],
  });
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      patient_reply: 'Chào bạn. Bạn nên đến cơ sở y tế để được chẩn đoán và điều trị phù hợp.',
    }),
  });
  const result = await createDoctorAiAssist({}, input);
  expect(result.patient_reply).toBe(
    'Bạn nên đến cơ sở y tế để được chẩn đoán và điều trị phù hợp.'
  );
  expect(callTextAi).toHaveBeenCalledTimes(1);
});

test('removing a greeting never makes an unsupported diagnosis or a prescription acceptable', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    conversation: [
      { role: 'doctor', message: 'Bạn cần hỗ trợ gì?' },
      { role: 'patient', message: 'Tôi đau đầu.' },
    ],
    latest_patient_message: { message: 'Tôi đau đầu.' },
    missing_data: [],
    conflicts: [],
  });
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      patient_reply: 'Chào bạn. Bạn bị tăng huyết áp. Uống aspirin 500 mg.',
    }),
  });
  await expect(createDoctorAiAssist({}, input)).rejects.toMatchObject({
    code: 'DOCTOR_AI_INVALID_RESPONSE',
  });
});

test('rejects repeated unsafe drafts after the bounded retry budget', async () => {
  const systems = [];
  callTextAi.mockImplementation(async (request) => {
    systems.push(request.system);
    return { content: JSON.stringify({ patient_reply: 'Bạn bị tăng huyết áp.' }) };
  });
  await expect(createDoctorAiAssist({}, input)).rejects.toMatchObject({
    statusCode: 502,
    code: 'DOCTOR_AI_INVALID_RESPONSE',
  });
  expect(callTextAi).toHaveBeenCalledTimes(3);
  expect(systems[1]).toContain('failed the safety check');
  expect(systems[2]).toContain('preserve urgent care advice');
});

test('records tokens for rejected attempts as well as the final valid generation', async () => {
  const { logAiInteraction } = require('../src/services/ai/ai-logger.service');
  callTextAi
    .mockResolvedValueOnce({
      content: '{}',
      model: 'medgemma-4b-it',
      usage: { prompt: 100, completion: 10 },
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({ patient_reply: 'Bạn cần trao đổi điều gì?' }),
      model: 'medgemma-4b-it',
      usage: { prompt: 120, completion: 20 },
    });
  const output = await createDoctorAiAssist({}, input);
  expect(output.usage).toEqual({ input_tokens: 220, output_tokens: 30 });
  expect(logAiInteraction).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ inputTokens: 220, outputTokens: 30, success: true })
  );
});

test('does not spend a model call while the specialist is waiting for an answer', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    conversation: [
      { id: '1', role: 'patient', message: 'Tôi mất ngủ.' },
      { id: '2', role: 'doctor', message: 'Bạn thường ngủ lúc mấy giờ?' },
    ],
    latest_patient_message: { id: '1', message: 'Tôi mất ngủ.' },
    context_version: '1',
    missing_data: [],
    conflicts: [],
  });
  const output = await createDoctorAiAssist({}, input);
  expect(callTextAi).not.toHaveBeenCalled();
  expect(output.patient_reply).toBe('');
  expect(output.model).toBe('awaiting-patient-v1');
  expect(output.uncertainties.join(' ')).toContain('đang chờ');
});

test('regenerates drafts using the wrong service title instead of publishing them', async () => {
  callTextAi
    .mockResolvedValueOnce({
      content: JSON.stringify({ patient_reply: 'Tôi là bác sĩ, bạn cần hỗ trợ gì?' }),
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({ patient_reply: 'Chuyên gia có thể hỗ trợ bạn điều gì?' }),
    });
  const result = await createDoctorAiAssist({}, input);
  expect(result.patient_reply).toContain('Chuyên gia');
  expect(result.patient_reply).not.toMatch(/bác sĩ/iu);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(callTextAi.mock.calls[1][0].system).toContain('Use chuyên gia');
});

test('regenerates a summary that broadens a vomiting denial into a nausea denial', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    medications: [],
    missing_data: [],
    conflicts: [],
    latest_patient_message: { message: 'Em không sốt, chưa nôn.' },
    conversation: [{ role: 'patient', message: 'Em không sốt, chưa nôn.' }],
  });
  callTextAi
    .mockResolvedValueOnce({
      content: JSON.stringify({ clinical_summary: 'Không sốt, không buồn nôn.' }),
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({ clinical_summary: 'Không sốt, chưa nôn.' }),
    });
  const output = await createDoctorAiAssist({}, { ...input, touchpoint: 'patient_summary' });
  expect(output.clinical_summary).toBe('Không sốt, chưa nôn.');
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(callTextAi.mock.calls[1][0].system).toContain(
    'Do not assert presence or absence of nausea'
  );
});

test('triages the submitted complaint even before the first chat message', async () => {
  loadDoctorClinicalContext.mockResolvedValue({
    profile: {},
    medications: [],
    missing_data: [],
    conflicts: [],
    latest_patient_message: null,
    initial_patient_statement: { message: 'Em đau bụng từ sáng nay.' },
    conversation: [{ role: 'patient', message: 'Em đau bụng từ sáng nay.' }],
  });
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ urgency: 'soon', clinical_summary: 'Đau bụng từ sáng nay.' }),
    provider: 'medgemma',
    model: 'fixture',
  });
  const output = await createDoctorAiAssist({}, { ...input, touchpoint: 'auto_triage' });
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(output.urgency).toBe('soon');
  expect(output.provider).toBe('medgemma');
});

test('regenerates an internal English summary when Vietnamese was requested', async () => {
  callTextAi
    .mockResolvedValueOnce({
      content: JSON.stringify({
        clinical_summary:
          'Patient reports intermittent abdominal pain for three days and is asking for advice.',
      }),
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({ clinical_summary: 'Bệnh nhân đang hỏi về tình trạng đau bụng.' }),
    });
  const result = await createDoctorAiAssist({}, { ...input, touchpoint: 'patient_summary' });
  expect(result.clinical_summary).toBe('Bệnh nhân đang hỏi về tình trạng đau bụng.');
  expect(callTextAi.mock.calls[1][0].system).toContain(
    'Write every human-readable field in Vietnamese'
  );
});
