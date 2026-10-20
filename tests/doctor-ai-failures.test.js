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
