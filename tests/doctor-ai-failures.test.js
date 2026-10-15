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
