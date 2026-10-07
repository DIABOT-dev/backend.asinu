'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn() }));
jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn().mockResolvedValue({ connectionLimit: 8, isAnTam: true }),
}));
jest.mock('../../src/lib/redis', () => ({ cacheGet: jest.fn().mockResolvedValue('Relative'), cacheSet: jest.fn() }));
jest.mock('../../src/services/integrations/crm-event.service', () => ({ emitCrmEventAsync: jest.fn() }));
jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    if (req.headers.authorization !== 'test-session') return res.sendStatus(401);
    req.user = { id: 7 };
    return next();
  },
}));
jest.mock('../../src/middleware/care-circle.gate.middleware', () => ({
  careCircleEnabled: (_req, _res, next) => next(), caregiverViewLogs: (_req, _res, next) => next(),
}));

const service = require('../../src/services/care-circle/careCircle.service');
const routes = require('../../src/routes/careCircle.routes');
const entitlement = require('../../src/services/payment/entitlement.service');
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const stored = 'x'.repeat(43);

function fixture({ permanent = true, existing = false, missing = false } = {}) {
  const pool = { query: jest.fn(async (sql, values) => {
    if (sql.includes('INSERT INTO care_circle_qr_tokens')) return { rows: [{ token_value: stored }] };
    if (sql.includes('FROM care_circle_qr_tokens q')) return { rows: missing ? [] : [{
      owner_user_id: 9, permanent, name: 'Parent', avatar_url: null,
    }] };
    if (sql.includes('SELECT status')) return { rows: existing ? [{ status: 'pending' }] : [], rowCount: existing ? 1 : 0 };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('INSERT INTO user_connections')) return { rows: [{
      id: '10000000-0000-4000-8000-000000000001', requester_id: values[0], addressee_id: values[1],
      status: 'pending', permissions: JSON.parse(values[4]),
    }] };
    return { rows: [] };
  }) };
  return pool;
}

beforeEach(() => {
  jest.clearAllMocks();
  entitlement.getEntitlement.mockResolvedValue({ connectionLimit: 8, isAnTam: true });
});

test('returns the database-owned code, never a new candidate or an expiry', async () => {
  const pool = fixture();
  const first = await service.createQrToken(pool, 7);
  const second = await service.createQrToken(pool, 7);
  expect(first).toEqual({ token: stored, value: `asinu-lite://care-circle/scan?token=${stored}` });
  expect(second).toEqual(first);
  const [sql, values] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT \(owner_user_id\) WHERE token_value IS NOT NULL/);
  expect(sql).not.toMatch(/DELETE|revoked_at|INTERVAL/);
  expect(values[0]).toBe(7);
  expect(values[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(values[1]).toBe(hash(values[2]));
});

test('QR preview exposes only the public name/avatar, not an id, phone, expiry or credentials', async () => {
  const pool = fixture();
  const result = await service.previewQrToken(pool, stored, 7);
  expect(result).toEqual({ ok: true, preview: { name: 'Parent', avatarUrl: null } });
  const [sql, values] = pool.query.mock.calls[0];
  expect(values[0]).toBe(hash(stored));
  expect(sql).toMatch(/q\.token_value IS NOT NULL OR q\.expires_at > NOW\(\)/);
  expect(sql).toMatch(/q\.revoked_at IS NULL/);
});

test('scanning never creates a connection or writes health data', async () => {
  const pool = fixture();
  await service.previewQrToken(pool, stored, 7);
  expect(pool.query.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
});

test('self scans, nonexistent codes and existing relationships are rejected', async () => {
  expect(await service.previewQrToken(fixture(), stored, 9)).toMatchObject({ code: 'CARE_CIRCLE_QR_SELF', statusCode: 400 });
  expect(await service.previewQrToken(fixture({ missing: true }), stored, 7)).toMatchObject({ code: 'CARE_CIRCLE_QR_INVALID', statusCode: 410 });
  expect(await service.previewQrToken(fixture({ existing: true }), stored, 7)).toMatchObject({ code: 'CARE_CIRCLE_CONNECTION_EXISTS', statusCode: 409 });
});

test('different relatives can invite using the same permanent code without consuming it', async () => {
  const pool = fixture();
  for (const requester of [7, 8]) {
    const result = await service.createInvitationFromQr(pool, requester, {
      token: stored, role: 'than-nhan', relationship_type: 'Bố', permissions: { can_view_logs: false },
    });
    expect(result).toMatchObject({ ok: true, invitation: {
      requester_id: requester, addressee_id: 9, status: 'pending', permissions: { can_view_logs: false },
    } });
  }
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('SET consumed_at'))).toBe(false);
});

test('a permanent code still respects plan limits and never auto-accepts', async () => {
  const pool = fixture();
  entitlement.getEntitlement.mockResolvedValue({ connectionLimit: 0, isAnTam: false });
  expect(await service.createInvitationFromQr(pool, 7, { token: stored, role: 'than-nhan' }))
    .toMatchObject({ ok: false, code: 'CARE_CIRCLE_LIMIT', statusCode: 403 });
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO user_connections'))).toBe(false);
});

test('permanent codes cannot bypass family-role validation', async () => {
  const pool = fixture();
  expect(await service.createInvitationFromQr(pool, 7, { token: stored, role: 'bac-si' }))
    .toMatchObject({ ok: false, code: 'CARE_CIRCLE_FAMILY_ROLE_REQUIRED' });
  expect(pool.query).not.toHaveBeenCalled();
});

test('historical temporary codes retain their one-use behavior', async () => {
  const pool = fixture({ permanent: false });
  const result = await service.createInvitationFromQr(pool, 7, { token: stored, role: 'than-nhan' });
  expect(result.ok).toBe(true);
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('SET consumed_at'))).toBe(true);
});

test('authenticated QR endpoints ignore supplied owner ids and preserve opaque responses', async () => {
  const pool = fixture();
  const app = express();
  // Do not retain sockets to Supertest's short-lived ephemeral servers across
  // requests/suites when the next fixture happens to reuse the same port.
  app.use((_req, res, next) => { res.setHeader('Connection', 'close'); next(); });
  app.use(express.json()); app.use('/circle', routes(pool));
  expect((await request(app).post('/circle/qr-token')).status).toBe(401);
  expect(pool.query).not.toHaveBeenCalled();
  const response = await request(app).post('/circle/qr-token').set('Authorization', 'test-session').send({ owner_user_id: 99 });
  expect(response.status).toBe(201);
  expect(response.body).toEqual({ ok: true, token: stored, value: `asinu-lite://care-circle/scan?token=${stored}` });
  expect(pool.query.mock.calls[0][1][0]).toBe(7);
  const preview = await request(app).post('/circle/qr-token/preview').set('Authorization', 'test-session').send({ token: stored });
  expect(preview.body).toEqual({ ok: true, preview: { name: 'Parent', avatarUrl: null } });
  const invalid = await request(app).post('/circle/qr-token/preview').set('Authorization', 'test-session').send({ token: 'bad' });
  expect(invalid.status).toBe(400);
});
