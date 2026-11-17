'use strict';
jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-owner']) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
    req.user = { id: Number(req.headers['x-test-owner']) };
    return next();
  },
}));
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/services/ai/ai-consent.service', () => ({
  ...jest.requireActual('../../src/services/ai/ai-consent.service'), hasAiConsent: jest.fn().mockResolvedValue(true),
}));

const express = require('express');
const http = require('supertest');
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'read-cache-http-fixture-only';
const mobileRoutes = require('../../src/routes/mobile.routes');
const cache = require('../../src/services/assistant/assistant-read-cache.service');
const domains = require('../../src/services/assistant/domain-tools.service');
const { hasAiConsent } = require('../../src/services/ai/ai-consent.service');
const { callTextAi } = require('../../src/services/ai/ai.service');
const input = { text: 'Tôi còn thông báo nào chưa đọc?', current: { language: 'vi', fontSize: 'normal' } };
let app, router, capability;

beforeEach(() => {
  process.env.JWT_SECRET = 'read-cache-http-fixture-only';
  hasAiConsent.mockReset().mockResolvedValue(true);
  callTextAi.mockReset();
  jest.spyOn(domains, 'prepare').mockResolvedValue({ answer: 'Fresh data from current read.' });
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  const pool = { connect: async () => client, query: jest.fn() };
  router = mobileRoutes(pool);
  app = express(); app.use(express.json()); app.use('/api/mobile', router);
  capability = cache.issue(input, [{ type: 'app_tool', tool: 'notifications.list', parameters: { unread: true }, evidence: input.text }],
    { status: 'answer', actions: [], answer: 'Old answer, not stored in token.' }, 7, 'vi');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret; });
const send = () => http(app).post('/api/mobile/assistant/read-cache').set('x-test-owner', '7').set('x-lang', 'vi');

test('read replay shares all auth, consent and rate-limit gates with normal planning', () => {
  expect(router.stack.filter(layer => layer.route?.path === '/assistant/read-cache')).toHaveLength(1);
  const route = name => router.stack.find(layer => layer.route?.path === name).route.stack;
  const plan = route('/assistant/plan'), replay = route('/assistant/read-cache');
  for (let i = 0; i < 3; i++) expect(replay[i].handle).toBe(plan[i].handle);
});

test('the authenticated endpoint returns live answer data, no AI, and unchanged cache metadata', async () => {
  const response = await send().send({ token: capability.token, request: input });
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({ ok: true, status: 'answer', actions: [], answer: 'Fresh data from current read.', readCache: capability });
  expect(callTextAi).not.toHaveBeenCalled();
});

test('expired, invalid or mismatched cache requests have the explicit recoverable miss code', async () => {
  const response = await send().send({ token: capability.token, request: { ...input, text: 'Xem tất cả thông báo' } });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ ok: false, code: 'APP_ASSISTANT_READ_CACHE_MISS' });
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('normal authentication and revoked consent errors do not become cache misses', async () => {
  const unauthenticated = await http(app).post('/api/mobile/assistant/read-cache').send({ token: capability.token, request: input });
  expect(unauthenticated.status).toBe(401);
  hasAiConsent.mockResolvedValue(false);
  const revoked = await send().send({ token: capability.token, request: input });
  expect(revoked.status).toBe(403);
  expect(revoked.body).toEqual({ ok: false, code: 'AI_CONSENT_REQUIRED' });
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('live permission and feature errors are returned unchanged instead of replanning', async () => {
  domains.prepare.mockRejectedValueOnce(Object.assign(new Error('Feature disabled'), { code: 'CARE_CIRCLE_DISABLED', statusCode: 403 }));
  const response = await send().send({ token: capability.token, request: input });
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ ok: false, code: 'CARE_CIRCLE_DISABLED' });
  expect(callTextAi).not.toHaveBeenCalled();
});
