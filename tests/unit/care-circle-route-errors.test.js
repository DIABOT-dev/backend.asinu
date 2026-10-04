'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 7 };
    next();
  },
}));
jest.mock('../../src/middleware/care-circle.gate.middleware', () => ({
  careCircleEnabled: (_req, _res, next) => next(),
}));
jest.mock('../../src/controllers/careCircle.controller', () => ({
  createInvitation: jest.fn().mockRejectedValue(new Error('database unavailable')),
  createQrToken: jest.fn(),
  previewQrToken: jest.fn(),
  createInvitationFromQr: jest.fn(),
  getInvitations: jest.fn(),
  acceptInvitation: jest.fn(),
  rejectInvitation: jest.fn(),
  cancelInvitation: jest.fn(),
  getConnections: jest.fn(),
  deleteConnection: jest.fn(),
  updateConnection: jest.fn(),
  updateConnectionPermissions: jest.fn(),
}));

const careCircleRoutes = require('../../src/routes/careCircle.routes');

test('Care Circle forwards async controller failures to Express error middleware', async () => {
  const app = express();
  app.use(express.json());
  app.use('/care-circle', careCircleRoutes({}));
  app.use((_error, _req, res, _next) => res.status(500).json({ ok: false }));

  const result = await request(app).post('/care-circle/invitations').send({});
  expect(result.status).toBe(500);
  expect(result.body).toEqual({ ok: false });
});
