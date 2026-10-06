'use strict';

const express = require('express');
const request = require('supertest');
jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user']) return res.status(401).json({ ok: false });
    req.user = { id: Number(req.headers['x-test-user']) };
    next();
  },
}));
jest.mock('../../src/services/care-circle/caregiver-view.service', () => ({
  memberHealthCalendar: jest.fn(),
}));
jest.mock('../../src/services/care-circle/careCircle.service', () => ({
  updateHealthAccess: jest.fn(),
}));
const view = require('../../src/services/care-circle/caregiver-view.service');
const circle = require('../../src/services/care-circle/careCircle.service');
const routes = require('../../src/routes/careCircle.routes');
const pool = {};
const connectionId = '10000000-0000-4000-8000-000000000001';
let app;
beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/circle', routes(pool));
  app.use((_error, _req, res, _next) => res.status(500).json({ ok: false }));
});

test('calendar requires authentication before reading anything', async () => {
  expect((await request(app).get('/circle/member/8/health-calendar?month=2026-10')).status).toBe(
    401
  );
  expect(view.memberHealthCalendar).not.toHaveBeenCalled();
});
test.each(['2026-13', '2026-00', '1999-12', '2101-01', '2026-2', '2026-10%27', ''])(
  'invalid month %s cannot trigger a query',
  async (month) => {
    const result = await request(app)
      .get(`/circle/member/8/health-calendar?month=${month}`)
      .set('x-test-user', '7');
    expect(result.status).toBe(400);
    expect(view.memberHealthCalendar).not.toHaveBeenCalled();
  }
);
test.each(['8abc', '-1', '0', '9007199254740992'])(
  'invalid member %s cannot trigger a query',
  async (id) => {
    expect(
      (
        await request(app)
          .get(`/circle/member/${id}/health-calendar?month=2026-10`)
          .set('x-test-user', '7')
      ).status
    ).toBe(400);
    expect(view.memberHealthCalendar).not.toHaveBeenCalled();
  }
);
test('denied access returns 403 without a medical payload', async () => {
  view.memberHealthCalendar.mockResolvedValueOnce(null);
  const result = await request(app)
    .get('/circle/member/8/health-calendar?month=2026-10')
    .set('x-test-user', '7');
  expect(result.status).toBe(403);
  expect(result.body.code).toBe('HEALTH_ACCESS_DENIED');
  expect(result.body.report).toBeUndefined();
});
test('an authorized month is tied to the authenticated viewer and cannot be cached', async () => {
  view.memberHealthCalendar.mockResolvedValueOnce({
    patientName: 'Parent',
    report: { sessions: [] },
  });
  const result = await request(app)
    .get('/circle/member/8/health-calendar?month=2026-10')
    .set('x-test-user', '7');
  expect(result.status).toBe(200);
  expect(view.memberHealthCalendar).toHaveBeenCalledWith(pool, 7, 8, '2026-10');
  expect(result.headers['cache-control']).toBe('private, no-store');
});
test.each([
  {},
  { can_view_logs: 'false' },
  { can_view_logs: 1 },
  { can_view_logs: true, owner_id: 8 },
])('invalid grant body %j cannot change permissions', async (body) => {
  expect(
    (
      await request(app)
        .put(`/circle/connections/${connectionId}/health-access`)
        .set('x-test-user', '7')
        .send(body)
    ).status
  ).toBe(400);
  expect(circle.updateHealthAccess).not.toHaveBeenCalled();
});
test('grant changes use the session owner, never an owner supplied by a client', async () => {
  circle.updateHealthAccess.mockResolvedValueOnce({ ok: true, connection: { id: connectionId } });
  const result = await request(app)
    .put(`/circle/connections/${connectionId}/health-access`)
    .set('x-test-user', '7')
    .send({ can_view_logs: true });
  expect(result.status).toBe(200);
  expect(circle.updateHealthAccess).toHaveBeenCalledWith(pool, connectionId, 7, true, 'vi');
});
test('disabled Care Circle never loads member health', async () => {
  const previous = process.env.CARE_CIRCLE_ENABLED;
  process.env.CARE_CIRCLE_ENABLED = 'false';
  try {
    expect(
      (
        await request(app)
          .get('/circle/member/8/health-calendar?month=2026-10')
          .set('x-test-user', '7')
      ).status
    ).toBe(403);
    expect(view.memberHealthCalendar).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.CARE_CIRCLE_ENABLED;
    else process.env.CARE_CIRCLE_ENABLED = previous;
  }
});
