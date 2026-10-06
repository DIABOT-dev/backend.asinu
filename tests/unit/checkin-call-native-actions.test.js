const jwt = require('jsonwebtoken');
const { createHmac } = require('node:crypto');
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({ decline: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../../src/middleware/auth.middleware', () => ({ requireAuth: (_req, res) => res.status(401).json({ ok: false }) }));
const { createDeclineCapability, verifyDeclineCapability } = require('../../src/services/checkin-call/native-action.service');
const service = require('../../src/services/checkin-call/checkin-call.service');
const express = require('express');
const request = require('supertest');
const id = 'bca2c9da-26fe-44a3-ac05-3f8dd75bc9e0';
const other = 'bca2c9da-26fe-44a3-ac05-3f8dd75bc9e1';
const original = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'test-only-native-action-secret'; });
afterAll(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
beforeEach(() => jest.clearAllMocks());
const capability = () => createDeclineCapability(id, 7, new Date(Date.now() + 60_000));

test('capability authorizes only this recipient and attempt, with a bounded expiry', () => {
  const token = capability();
  expect(verifyDeclineCapability(id, token)).toBe(7);
  const claims = jwt.decode(token);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(240);
  expect(claims).toEqual(expect.objectContaining({ action: 'decline', sub: '7' }));
  expect(() => verifyDeclineCapability(other, token)).toThrow();
});
test('capability is not a login credential and login tokens cannot decline', () => {
  expect(() => jwt.verify(capability(), process.env.JWT_SECRET)).toThrow();
  const login = jwt.sign({ userId: 7 }, process.env.JWT_SECRET);
  expect(() => verifyDeclineCapability(id, login)).toThrow();
});
test.each([null, '', 7, {}, 'broken', 'x'.repeat(2049)])('rejects malformed capability without leaking it: %p', token => {
  try { verifyDeclineCapability(id, token); throw new Error('Unexpected success'); }
  catch (error) { expect(error.statusCode).toBe(401); expect(error.message).toBe('Invalid native call action'); }
});
test('expired, wrong audience, wrong action and missing expiry are rejected', () => {
  const secret = createHmac('sha256', process.env.JWT_SECRET).update('asinu:checkin-native-decline').digest();
  const now = Math.floor(Date.now() / 1000);
  for (const patch of [{ exp: now - 1 }, { aud: 'login' }, { action: 'accept' }, { exp: undefined }]) {
    const claims = { attemptId: id, sub: '7', action: 'decline', aud: 'asinu:checkin-native-decline', iss: 'asinu:checkin-call', exp: now + 60, ...patch };
    if (claims.exp === undefined) delete claims.exp;
    const token = jwt.sign(claims, secret);
    expect(() => verifyDeclineCapability(id, token)).toThrow();
  }
});
test('invalid identities and expired ringing deadlines never mint a credential', () => {
  expect(createDeclineCapability('bad', 7, new Date(Date.now() + 60_000))).toBeNull();
  expect(createDeclineCapability(id, 0, new Date(Date.now() + 60_000))).toBeNull();
  expect(createDeclineCapability(id, 7, new Date(Date.now() - 60_000))).toBeNull();
});
test('native endpoint works without login only with the exact capability; cannot check in or accept', async () => {
  const pool = {};
  const app = express(); app.use(express.json());
  app.use('/api/mobile/checkin-call', require('../../src/routes/checkin-call.routes')(pool));
  const url = `/api/mobile/checkin-call/native/attempts/${id}/decline`;
  await request(app).post(url).send({ capability: capability(), userId: 999 }).expect(200);
  expect(service.decline).toHaveBeenCalledWith(pool, id, 7, { ringingOnly: true });
  await request(app).post(url).send({}).expect(401);
  await request(app).post(`/api/mobile/checkin-call/attempts/${id}/accept`).send({ capability: capability() }).expect(401);
  await request(app).post(`/api/mobile/checkin-call/episodes/${id}/answer`).send({ capability: capability() }).expect(401);
  expect(service.decline).toHaveBeenCalledTimes(1);
});
