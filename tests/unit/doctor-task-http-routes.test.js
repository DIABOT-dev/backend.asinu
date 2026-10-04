'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: jest.fn((req, _res, next) => {
    req.user = { id: 42 };
    req.middlewareOrder = ['auth'];
    next();
  }),
}));
jest.mock('../../src/middleware/upload.middleware', () => ({
  imageUpload: { single: jest.fn(() => 'image') },
  audioUpload: { single: jest.fn(() => 'audio') },
  handleUpload: (kind) => (req, _res, next) => {
    req.middlewareOrder.push(`${kind}-upload`);
    next();
  },
  verifyImageMagicBytes: (req, _res, next) => {
    req.middlewareOrder.push('image-magic');
    next();
  },
  verifyAudioMagicBytes: (req, _res, next) => {
    req.middlewareOrder.push('audio-magic');
    next();
  },
}));
jest.mock('../../src/controllers/doctor-task.controller', () => ({
  requestDoctorTask: jest.fn(),
  submitDoctorRating: jest.fn(),
  requestDoctorPrivacy: jest.fn(),
  recommendDoctor: jest.fn(),
  listDoctorDirectory: jest.fn(),
  listDoctorDirectorySpecialties: jest.fn(),
  listDoctorReviews: jest.fn(),
  listDoctorSpecialties: jest.fn(),
  listDoctorClinics: jest.fn(),
  listDoctorTasks: jest.fn(),
  listDoctorMessages: jest.fn(),
  createDoctorMessage: jest.fn(),
  createDoctorAttachment: jest.fn(),
  createDoctorVoice: jest.fn(),
  createDoctorMessageAction: jest.fn(),
  getDoctorPrivacyReceipts: jest.fn(),
}));

const controller = require('../../src/controllers/doctor-task.controller');
const { requireAuth } = require('../../src/middleware/auth.middleware');
const doctorTaskRoutes = require('../../src/routes/doctor-task.routes');
const pool = {};
const router = doctorTaskRoutes(pool);
const app = express();
app.use(express.json());
app.use('/doctor', router);
app.use((_error, _req, res, _next) => res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' }));

const routes = [
  ['post', '/tasks', 'requestDoctorTask'],
  ['get', '/tasks', 'listDoctorTasks'],
  ['get', '/tasks/:taskId/messages', 'listDoctorMessages'],
  ['post', '/tasks/:taskId/messages', 'createDoctorMessage'],
  ['post', '/tasks/:taskId/messages/action', 'createDoctorMessageAction'],
  ['post', '/tasks/:taskId/attachments', 'createDoctorAttachment'],
  ['post', '/tasks/:taskId/voice', 'createDoctorVoice'],
  ['post', '/tasks/:taskId/rating', 'submitDoctorRating'],
  ['post', '/privacy', 'requestDoctorPrivacy'],
  ['get', '/privacy', 'getDoctorPrivacyReceipts'],
  ['post', '/recommendations', 'recommendDoctor'],
  ['post', '/specialists', 'listDoctorDirectory'],
  ['get', '/specialty-options', 'listDoctorDirectorySpecialties'],
  ['get', '/specialists/:doctorId/reviews', 'listDoctorReviews'],
  ['post', '/specialties', 'listDoctorSpecialties'],
  ['post', '/clinics', 'listDoctorClinics'],
];

beforeEach(() => {
  jest.clearAllMocks();
  for (const [name, handler] of Object.entries(controller)) {
    handler.mockImplementation((_pool, req, res) =>
      res.json({ handler: name, userId: req.user.id, middlewareOrder: req.middlewareOrder })
    );
  }
});

test('retains the complete Doctor task endpoint registration', () => {
  expect(
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map((method) => `${method} ${layer.route.path}`)
      )
  ).toEqual(routes.map(([method, path]) => `${method} ${path}`));
});

test.each(routes)(
  '%s %s binds the same controller, pool and authenticated request',
  async (method, path, name) => {
    const actualPath = path.replace(':taskId', 'task-1').replace(':doctorId', 'doctor-1');
    const response = await request(app)
      [method](`/doctor${actualPath}`)
      .send({ marker: 'body' })
      .expect(200);
    expect(response.body).toMatchObject({ handler: name, userId: 42 });
    expect(controller[name]).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ user: { id: 42 }, body: { marker: 'body' } }),
      expect.any(Object),
      expect.any(Function)
    );
    expect(requireAuth).toHaveBeenCalledTimes(1);
  }
);

test.each([
  ['/tasks/task-1/attachments', 'createDoctorAttachment', ['auth', 'image-upload', 'image-magic']],
  ['/tasks/task-1/voice', 'createDoctorVoice', ['auth', 'audio-upload', 'audio-magic']],
])('%s preserves authentication, upload and magic-byte ordering', async (path, name, order) => {
  const response = await request(app).post(`/doctor${path}`).send({}).expect(200);
  expect(response.body.middlewareOrder).toEqual(order);
  expect(controller[name]).toHaveBeenCalledTimes(1);
});

test.each(routes)(
  '%s %s cannot execute its controller when authentication fails',
  async (method, path, name) => {
    requireAuth.mockImplementationOnce((_req, res) => res.status(401).json({ ok: false }));
    const actualPath = path.replace(':taskId', 'task-1').replace(':doctorId', 'doctor-1');
    await request(app)[method](`/doctor${actualPath}`).send({}).expect(401);
    expect(controller[name]).not.toHaveBeenCalled();
  }
);

test('async controller failures still reach Express error middleware', async () => {
  controller.listDoctorTasks.mockRejectedValueOnce(new Error('database unavailable'));
  const response = await request(app).get('/doctor/tasks').expect(500);
  expect(response.body).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
});

test('sync controller failures still reach Express error middleware', async () => {
  controller.listDoctorTasks.mockImplementationOnce(() => {
    throw new Error('database unavailable');
  });
  const response = await request(app).get('/doctor/tasks').expect(500);
  expect(response.body).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
});
