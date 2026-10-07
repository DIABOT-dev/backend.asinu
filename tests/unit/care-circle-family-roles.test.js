'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 7 }; next(); },
}));
jest.mock('../../src/middleware/care-circle.gate.middleware', () => ({
  careCircleEnabled: (_req, _res, next) => next(),
  caregiverViewLogs: (_req, _res, next) => next(),
}));
jest.mock('../../src/services/care-circle/careCircle.service', () => ({
  createInvitation: jest.fn(),
  createInvitationFromQr: jest.fn(),
  updateConnection: jest.fn(),
}));
jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn() }));
jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn().mockResolvedValue({ connectionLimit: 1, isAnTam: false }),
}));
jest.mock('../../src/lib/redis', () => ({ cacheGet: jest.fn().mockResolvedValue('Parent'), cacheSet: jest.fn() }));
jest.mock('../../src/services/integrations/crm-event.service', () => ({ emitCrmEventAsync: jest.fn() }));

const circle = require('../../src/services/care-circle/careCircle.service');
const service = jest.requireActual('../../src/services/care-circle/careCircle.service');
const routes = require('../../src/routes/careCircle.routes');
const { t } = require('../../src/i18n');
const pool = { query: jest.fn() };
const connectionId = '10000000-0000-4000-8000-000000000001';
const endpoints = [
  ['post', '/circle/invitations', { addressee_id: '8' }, 'createInvitation'],
  ['post', '/circle/qr-token/invitations', { token: 'a'.repeat(43) }, 'createInvitationFromQr'],
  ['put', `/circle/connections/${connectionId}`, {}, 'updateConnection'],
];
const blockedRoles = ['bac-si', 'Bác sĩ', 'Family Specialist', 'y-ta', 'duoc-si',
  'chuyen-gia-dinh-duong', 'huan-luyen-vien', 'nguoi-ho-tro', 'nguoi-giup-viec',
  'tu-van-tam-ly', 'Custom professional', { id: 'than-nhan' }];
let app;

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  for (const operation of Object.values(circle)) {
    operation.mockResolvedValue({ ok: true, invitation: { id: connectionId }, connection: { id: connectionId } });
  }
  app = express();
  app.use(express.json());
  app.use('/circle', routes(pool));
  app.use((_error, _req, res, _next) => res.status(500).json({ ok: false }));
});

describe.each(endpoints)('%s %s', (method, endpoint, body, operation) => {
  test.each(blockedRoles)('blocks non-family role %j before invoking any mutation', async (role) => {
    const response = await request(app)[method](endpoint).send({ ...body, relationship_type: 'Bố', role });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'CARE_CIRCLE_FAMILY_ROLE_REQUIRED', error: t('careCircle.family_role_required', 'vi') });
    expect(circle[operation]).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    ['Thân nhân', 'than-nhan', 'vi'],
    ['Người thân', 'than-nhan', 'vi'],
    [' Family member ', 'than-nhan', 'en'],
    ['Người chăm sóc', 'than-nhan', 'vi'],
    ['Người thân chăm sóc chính', 'than-nhan', 'vi'],
    ['Primary Caregiver', 'than-nhan', 'en'],
    ['FAMILY CAREGIVER', 'than-nhan', 'en'],
    ['than-nhan', 'than-nhan', 'en'],
    ['nguoi-cham-soc', 'than-nhan', 'vi'],
    ['Người thân'.normalize('NFD'), 'than-nhan', 'vi'],
  ])('accepts legacy family label %s and sends stable ID %s to the service', async (role, expectedRole, lang) => {
    const response = await request(app)[method](endpoint).set('Accept-Language', lang).send({ ...body, role });
    expect(response.status).toBe(200);
    const args = circle[operation].mock.calls[0];
    expect(args[0]).toBe(pool);
    expect(args[method === 'put' ? 2 : 1]).toBe(7);
    expect(args[method === 'put' ? 3 : 2].role).toBe(expectedRole);
    expect(args.at(-1)).toBe(lang);
  });

  test('rejection uses the selected English language', async () => {
    const response = await request(app)[method](endpoint).set('Accept-Language', 'en').send({ ...body, role: 'bac-si' });
    expect(response.body.error).toBe(t('careCircle.family_role_required', 'en'));
    expect(circle[operation]).not.toHaveBeenCalled();
  });
});

test.each(blockedRoles)('direct service calls cannot bypass the role gate with %j', async (role) => {
  const results = await Promise.all([
    service.createInvitation(pool, 7, { addressee_id: 8, role }),
    service.createInvitationFromQr(pool, 7, { token: 'a'.repeat(43), role }),
    service.updateConnection(pool, connectionId, 7, { relationship_type: 'Bố', role }),
  ]);
  for (const result of results) expect(result).toMatchObject({ ok: false, statusCode: 400, code: 'CARE_CIRCLE_FAMILY_ROLE_REQUIRED' });
  expect(pool.query).not.toHaveBeenCalled();
});

test('a legacy invitation label persists the canonical role and preserves explicit viewing opt-out', async () => {
  pool.query.mockImplementation(async (sql, values) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('INSERT INTO user_connections')) return { rows: [{ id: connectionId, role: values[3], permissions: JSON.parse(values[4]) }] };
    return { rows: [] };
  });
  const result = await service.createInvitation(pool, 7, {
    addressee_id: 8,
    role: 'Family member',
    permissions: { can_view_logs: false, can_receive_alerts: true, can_ack_escalation: false },
  });
  expect(result).toMatchObject({ ok: true, invitation: { role: 'than-nhan', permissions: { can_view_logs: false, can_receive_alerts: true, can_ack_escalation: false } } });
});

test('empty connection updates return a localized 400 without calling the service', async () => {
  const response = await request(app).put(`/circle/connections/${connectionId}`).set('Accept-Language', 'en').send({});
  expect(response.status).toBe(400);
  expect(response.body.error).toBe(t('careCircle.need_at_least_one_field', 'en'));
  expect(circle.updateConnection).not.toHaveBeenCalled();
});

test.each([undefined, null, ''])('new invitations default to the family role for input %j', async role => {
  for (const [method, endpoint, body, operation] of endpoints.filter(item => item[0] === 'post')) {
    const response = await request(app)[method](endpoint).send({ ...body, role });
    expect(response.status).toBe(200);
    expect(circle[operation].mock.calls.at(-1)[2].role).toBe('than-nhan');
  }
  pool.query.mockImplementation(async (sql, values) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('INSERT INTO user_connections')) return { rows: [{ id: connectionId, role: values[3] }] };
    return { rows: [] };
  });
  expect(await service.createInvitation(pool, 7, { addressee_id: 8, role }))
    .toMatchObject({ ok: true, invitation: { role: 'than-nhan' } });
});

test('a relationship-only update never injects a hidden role update', async () => {
  const response = await request(app).put(`/circle/connections/${connectionId}`).send({ relationship_type: 'Dì' });
  expect(response.status).toBe(200);
  const data = circle.updateConnection.mock.calls[0][3];
  expect(data.relationship_type).toBe('di');
  expect(data.role).toBeUndefined();
});
