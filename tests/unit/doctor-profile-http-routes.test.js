'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/integrations/doctor-profile.service', () => ({
  loadPatientProfile: jest.fn(),
  createPatientFile: jest.fn(),
  verifyDoctorSignature: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-lifecycle.service', () => ({
  ingestDoctorLifecycle: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-messaging.service', () => ({
  queryDoctorMessages: jest.fn(),
  sendDoctorMessage: jest.fn(),
  doctorMessageAction: jest.fn(),
  sendDoctorVoice: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-ai.service', () => ({
  createDoctorAiAssist: jest.fn(),
  getDoctorAiContextVersion: jest.fn(),
}));

const profile = require('../../src/services/integrations/doctor-profile.service');
const lifecycle = require('../../src/services/integrations/doctor-lifecycle.service');
const messaging = require('../../src/services/integrations/doctor-messaging.service');
const ai = require('../../src/services/integrations/doctor-ai.service');
const policy = require('../../src/services/integrations/doctor-task.policy');
const doctorProfileRoutes = require('../../src/routes/doctor-profile.routes');
const { t } = require('../../src/i18n');

const pool = {};
const router = doctorProfileRoutes(pool);
const app = express();
app.use(express.json());
app.use('/doctor-profile', router);
app.use((error, _req, res, _next) =>
  res.status(error.statusCode || 500).json({ ok: false, code: error.code || 'INTERNAL_ERROR' })
);

const base = { tenant_id: ' clinic-demo ', task_id: ' task-1 ', app_user_id: ' 42 ' };
const messageId = '11111111-1111-4111-8111-111111111111';
const signedCases = [
  {
    path: '/messages/query',
    operation: messaging.queryDoctorMessages,
    schema: policy.doctorMessageQuerySchema,
    errorKey: 'error.invalid_message_query',
    input: base,
  },
  {
    path: '/messages/send',
    operation: messaging.sendDoctorMessage,
    schema: policy.doctorMessageSendSchema,
    errorKey: 'error.invalid_doctor_message',
    input: {
      ...base,
      content: ' Please measure again. ',
      message_type: 'question',
      client_message_id: messageId,
      sender_ref: ' doctor-1 ',
    },
    createsResource: true,
  },
  {
    path: '/messages/action',
    operation: messaging.doctorMessageAction,
    schema: policy.doctorMessageActionSchema,
    errorKey: 'error.invalid_doctor_action',
    input: { ...base, action: 'typing', is_typing: true, actor_ref: ' doctor-1 ' },
  },
  {
    path: '/messages/voice',
    operation: messaging.sendDoctorVoice,
    schema: policy.doctorVoiceSendSchema,
    errorKey: 'error.invalid_voice_message',
    input: {
      ...base,
      content_base64: 'SUQzAAAAAAAA',
      file_name: ' voice.webm ',
      mime_type: ' audio/webm ',
      size_bytes: 9,
      duration_ms: 1200,
      client_message_id: messageId,
      sender_ref: ' doctor-1 ',
    },
    createsResource: true,
  },
  {
    path: '/ai-assist',
    operation: ai.createDoctorAiAssist,
    schema: policy.doctorAiAssistSchema,
    errorKey: 'error.invalid_ai_request',
    input: { ...base, touchpoint: 'auto_triage', task_summary: ' Review latest trends. ' },
    aiOperation: true,
  },
  {
    path: '/ai-context-version',
    operation: ai.getDoctorAiContextVersion,
    schema: policy.doctorAiAssistSchema,
    errorKey: 'error.invalid_ai_context',
    input: { ...base, touchpoint: 'auto_triage', task_summary: ' Review latest trends. ' },
    aiOperation: true,
  },
];

beforeEach(() => jest.resetAllMocks());

test('keeps all Doctor integration endpoints and methods unchanged', () => {
  expect(
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route.path}`
        )
      )
  ).toEqual([
    'POST /profile',
    'POST /patient-files',
    'POST /lifecycle',
    'POST /messages/query',
    'POST /messages/send',
    'POST /messages/action',
    'POST /messages/voice',
    'POST /ai-assist',
    'POST /ai-context-version',
  ]);
});

test.each(signedCases)(
  '$path passes schema-normalized input to the same service',
  async (entry) => {
    const data = { marker: entry.path, duplicate: false };
    entry.operation.mockResolvedValueOnce(data);
    const response = await request(app)
      .post(`/doctor-profile${entry.path}`)
      .send(entry.input)
      .expect(entry.createsResource ? 201 : 200);

    expect(response.body).toEqual({ ok: true, data });
    expect(profile.verifyDoctorSignature).toHaveBeenCalledTimes(1);
    const normalized = entry.schema.parse(entry.input);
    if (entry.aiOperation) {
      expect(entry.operation).toHaveBeenCalledWith(pool, normalized);
    } else {
      expect(entry.operation).toHaveBeenCalledWith(
        pool,
        expect.objectContaining({ body: entry.input }),
        normalized
      );
    }
  }
);

test.each(signedCases.flatMap((entry) => ['vi', 'en'].map((lang) => ({ ...entry, lang }))))(
  '$path retains $lang validation errors and Zod details',
  async (entry) => {
    const input = { unexpected: true };
    const parsed = entry.schema.safeParse(input);
    const response = await request(app)
      .post(`/doctor-profile${entry.path}`)
      .set('Accept-Language', entry.lang)
      .send(input)
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      error: t(entry.errorKey, entry.lang),
      details: parsed.error.issues,
    });
    expect(entry.operation).not.toHaveBeenCalled();
    expect(profile.verifyDoctorSignature).toHaveBeenCalledTimes(1);
  }
);

test.each(signedCases)(
  '$path rejects a signature before validating or executing',
  async (entry) => {
    const error = Object.assign(new Error('Invalid signature'), {
      statusCode: 401,
      code: 'DOCTOR_PROFILE_SIGNATURE_INVALID',
    });
    profile.verifyDoctorSignature.mockImplementationOnce(() => {
      throw error;
    });
    const response = await request(app).post(`/doctor-profile${entry.path}`).send({}).expect(401);
    expect(response.body).toEqual({ ok: false, code: 'DOCTOR_PROFILE_SIGNATURE_INVALID' });
    expect(entry.operation).not.toHaveBeenCalled();
  }
);

test.each(signedCases.filter((entry) => entry.createsResource))(
  '$path retains 200 for a duplicate and does not re-wrap service data',
  async (entry) => {
    const data = { duplicate: true, id: 'existing-record' };
    entry.operation.mockResolvedValueOnce(data);
    const response = await request(app)
      .post(`/doctor-profile${entry.path}`)
      .send(entry.input)
      .expect(200);
    expect(response.body).toEqual({ ok: true, data });
  }
);

test('profile preserves its 200 response and service-owned signature checks', async () => {
  const data = { app_user_id: '42' };
  profile.loadPatientProfile.mockResolvedValueOnce(data);
  const response = await request(app).post('/doctor-profile/profile').send(base).expect(200);
  expect(response.body).toEqual({ ok: true, data });
  expect(profile.loadPatientProfile).toHaveBeenCalledWith(
    pool,
    expect.objectContaining({ body: base })
  );
  expect(profile.verifyDoctorSignature).not.toHaveBeenCalled();
});

test('patient-file creation preserves its 201 response and service-owned validation', async () => {
  const data = { id: 'file-1' };
  profile.createPatientFile.mockResolvedValueOnce(data);
  const response = await request(app).post('/doctor-profile/patient-files').send(base).expect(201);
  expect(response.body).toEqual({ ok: true, data });
  expect(profile.createPatientFile).toHaveBeenCalledWith(
    pool,
    expect.objectContaining({ body: base })
  );
  expect(profile.verifyDoctorSignature).not.toHaveBeenCalled();
});

test.each([false, true])(
  'lifecycle duplicate=%s retains its original response status',
  async (duplicate) => {
    const data = { duplicate, event_id: 'event-1' };
    lifecycle.ingestDoctorLifecycle.mockResolvedValueOnce(data);
    const response = await request(app)
      .post('/doctor-profile/lifecycle')
      .send(base)
      .expect(duplicate ? 200 : 201);
    expect(response.body).toEqual({ ok: true, data });
    expect(lifecycle.ingestDoctorLifecycle).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ body: base })
    );
    expect(profile.verifyDoctorSignature).not.toHaveBeenCalled();
  }
);

test('service failures still reach the Express error handler', async () => {
  const error = Object.assign(new Error('Doctor task not found'), {
    statusCode: 404,
    code: 'DOCTOR_TASK_NOT_FOUND',
  });
  messaging.queryDoctorMessages.mockRejectedValueOnce(error);
  const response = await request(app).post('/doctor-profile/messages/query').send(base).expect(404);
  expect(response.body).toEqual({ ok: false, code: 'DOCTOR_TASK_NOT_FOUND' });
});
