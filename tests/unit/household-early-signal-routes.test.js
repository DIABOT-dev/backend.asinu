'use strict';

process.env.JWT_SECRET = 'route-regression-test-only';

jest.mock('../../src/services/payment/household.service', () => ({
  listProtectedMembers: jest.fn(),
  addProtectedMember: jest.fn(),
  removeProtectedMember: jest.fn(),
}));
jest.mock('../../src/services/early-signal/early-signal.service', () => ({
  evaluate: jest.fn(),
  latest: jest.fn(),
  familyLatest: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const household = require('../../src/services/payment/household.service');
const earlySignal = require('../../src/services/early-signal/early-signal.service');
const householdRoutes = require('../../src/routes/household.routes');
const earlySignalRoutes = require('../../src/routes/early-signal.routes');
const { bindController } = require('../../src/middleware/controller-handler.middleware');
const { t } = require('../../src/i18n');

const pool = {};
const token = jwt.sign({ id: 7 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const app = express();
app.locals.authPool = {
  query: jest.fn().mockResolvedValue({ rows: [{ auth_token_version: 0 }] }),
};
app.use(express.json());
app.use('/household', householdRoutes(pool));
app.use('/early-signals', earlySignalRoutes(pool));

beforeEach(() => {
  jest.resetAllMocks();
  app.locals.authPool.query.mockResolvedValue({ rows: [{ auth_token_version: 0 }] });
});

describe('household HTTP contract after route extraction', () => {
  test('retains authentication on every household endpoint', async () => {
    for (const [method, path] of [
      ['get', '/household'],
      ['post', '/household/members'],
      ['delete', '/household/members/8'],
    ]) {
      expect((await request(app)[method](path)).status).toBe(401);
    }
    expect(household.listProtectedMembers).not.toHaveBeenCalled();
    expect(household.addProtectedMember).not.toHaveBeenCalled();
    expect(household.removeProtectedMember).not.toHaveBeenCalled();
  });

  test('lists members for the authenticated owner in the selected language', async () => {
    household.listProtectedMembers.mockResolvedValue({ members: [], ownerUserId: 7 });
    const res = await request(app)
      .get('/household')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept-Language', 'en');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, members: [], ownerUserId: 7 });
    expect(household.listProtectedMembers).toHaveBeenCalledWith(pool, 7, 'en');
  });

  test('keeps numeric member conversion, 201 and authenticated ownership for add', async () => {
    household.addProtectedMember.mockResolvedValue({ members: [{ userId: 8 }] });
    const res = await request(app)
      .post('/household/members')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: '8', owner_user_id: 999 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, members: [{ userId: 8 }] });
    expect(household.addProtectedMember).toHaveBeenCalledWith(pool, 7, 8, 'vi');
  });

  test('keeps delete response and path member conversion', async () => {
    household.removeProtectedMember.mockResolvedValue({ members: [] });
    const res = await request(app)
      .delete('/household/members/8')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, members: [] });
    expect(household.removeProtectedMember).toHaveBeenCalledWith(pool, 7, 8, 'vi');
  });

  test('preserves entitlement denial and localized error details', async () => {
    household.addProtectedMember.mockRejectedValue({
      statusCode: 409,
      code: 'PROTECTED_MEMBER_LIMIT',
      i18nKey: 'error.household_limit',
      i18nParams: { plan: 'An Tâm 2', count: 2 },
    });
    const res = await request(app)
      .post('/household/members')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept-Language', 'en')
      .send({ user_id: 8 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      code: 'PROTECTED_MEMBER_LIMIT',
      error: t('error.household_limit', 'en', { plan: 'An Tâm 2', count: 2 }),
    });
  });

  test('does not expose an internal error message', async () => {
    household.listProtectedMembers.mockRejectedValue(new Error('private database detail'));
    const res = await request(app).get('/household').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      code: 'HOUSEHOLD_ERROR',
      error: t('error.household_unavailable', 'vi'),
    });
  });
});

describe('early-signal HTTP contract after route extraction', () => {
  test('retains authentication on every early-signal endpoint', async () => {
    for (const [method, path] of [
      ['post', '/early-signals/evaluate'],
      ['get', '/early-signals/latest'],
      ['get', '/early-signals/family'],
    ]) {
      expect((await request(app)[method](path)).status).toBe(401);
    }
    expect(earlySignal.evaluate).not.toHaveBeenCalled();
    expect(earlySignal.latest).not.toHaveBeenCalled();
    expect(earlySignal.familyLatest).not.toHaveBeenCalled();
  });

  test.each([{}, { user_id: 0 }, { user_id: '8' }])(
    'retains manual evaluation identity/defaults for %p',
    async (body) => {
      earlySignal.evaluate.mockResolvedValue({ severity: 'monitor' });
      const res = await request(app)
        .post('/early-signals/evaluate')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept-Language', 'en')
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, assessment: { severity: 'monitor' } });
      expect(earlySignal.evaluate).toHaveBeenCalledWith(pool, body.user_id ? 8 : 7, {
        requestedBy: 7,
        triggerType: 'manual',
        lang: 'en',
      });
    }
  );

  test.each([
    ['', 7],
    ['?user_id=8', 8],
  ])('retains latest identity for %s', async (query, id) => {
    earlySignal.latest.mockResolvedValue(null);
    const res = await request(app)
      .get(`/early-signals/latest${query}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, assessment: null });
    expect(earlySignal.latest).toHaveBeenCalledWith(pool, id, 7, 'vi');
  });

  test('retains family result envelope', async () => {
    earlySignal.familyLatest.mockResolvedValue([{ user_id: 8 }]);
    const res = await request(app)
      .get('/early-signals/family')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, assessments: [{ user_id: 8 }] });
    expect(earlySignal.familyLatest).toHaveBeenCalledWith(pool, 7, 'vi');
  });

  test('preserves the service permission denial', async () => {
    earlySignal.latest.mockRejectedValue({
      statusCode: 403,
      code: 'FORBIDDEN',
      i18nKey: 'error.unauthorized',
    });
    const res = await request(app)
      .get('/early-signals/latest?user_id=8')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      error: t('error.unauthorized', 'vi'),
    });
  });
});

describe('controller binding', () => {
  test('forwards synchronous and asynchronous failures to the error middleware', async () => {
    const error = new Error('test failure');
    const next = jest.fn();
    bindController(() => {
      throw error;
    }, pool)({}, {}, next);
    expect(next).toHaveBeenCalledWith(error);
    next.mockClear();
    await bindController(() => Promise.reject(error), pool)({}, {}, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
