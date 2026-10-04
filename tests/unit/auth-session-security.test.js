'use strict';

process.env.JWT_SECRET = 'session-regression-test-only';
jest.mock('../../src/services/integrations/crm-event.service', () => ({
  emitCrmEventAsync: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { authenticateJWT } = require('../../src/middleware/auth.middleware');
const auth = require('../../src/services/auth/auth.service');
const password = require('../../src/services/profile/password.service');
const { bindController } = require('../../src/middleware/controller-handler.middleware');
const { changePassword } = require('../../src/controllers/profile.controller');

function fixture() {
  const user = { id: 7, email: 'session@example.test', auth_token_version: 0 };
  const pool = {
    query: jest.fn(async (sql) => {
      if (sql.startsWith('SELECT auth_token_version')) return { rows: user.deleted ? [] : [user] };
      if (sql.startsWith('SELECT password_hash')) return { rows: [user] };
      if (sql.includes('auth_token_version = auth_token_version + 1')) {
        user.auth_token_version++;
        return { rows: [user] };
      }
      return { rows: [] };
    }),
  };
  const app = express();
  app.locals.authPool = pool;
  app.use(express.json());
  app.get('/private', authenticateJWT, (_req, res) => res.json({ ok: true }));
  app.post('/password', authenticateJWT, bindController(changePassword, pool));
  app.use((_error, _req, res, _next) => res.status(500).json({ ok: false, error: 'safe error' }));
  return { app, pool, user };
}

test('logout invalidates copied tokens and newly issued sessions remain usable', async () => {
  const { app, pool, user } = fixture();
  const oldToken = auth.issueJwt(user).token;
  expect((await request(app).get('/private').auth(oldToken, { type: 'bearer' })).status).toBe(200);
  await auth.logout(pool, user.id);
  expect((await request(app).get('/private').auth(oldToken, { type: 'bearer' })).status).toBe(401);
  const freshToken = auth.issueJwt(user).token;
  expect((await request(app).get('/private').auth(freshToken, { type: 'bearer' })).status).toBe(
    200
  );
});

test('legacy JWTs work until the first revocation and cannot bypass it', async () => {
  const { app, user } = fixture();
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  expect((await request(app).get('/private').auth(token, { type: 'bearer' })).status).toBe(200);
  user.auth_token_version = 1;
  expect((await request(app).get('/private').auth(token, { type: 'bearer' })).status).toBe(401);
});

test('deleted accounts and tokens without expiry cannot access private data', async () => {
  const { app, user } = fixture();
  user.deleted = true;
  expect(
    (await request(app).get('/private').auth(auth.issueJwt(user).token, { type: 'bearer' })).status
  ).toBe(401);
  user.deleted = false;
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
  expect((await request(app).get('/private').auth(token, { type: 'bearer' })).status).toBe(401);
});

test('authentication fails closed during a database outage', async () => {
  const { app, pool, user } = fixture();
  pool.query.mockRejectedValue(new Error('sensitive database information'));
  const res = await request(app)
    .get('/private')
    .auth(auth.issueJwt(user).token, { type: 'bearer' });
  expect(res.status).toBe(503);
  expect(JSON.stringify(res.body)).not.toContain('sensitive');
});

test('password change revokes old sessions and supplies a replacement token for this device', async () => {
  const { app, pool, user } = fixture();
  user.password_hash = await auth.hashPassword('old-password');
  const oldToken = auth.issueJwt(user).token;
  const result = await password.changePassword(pool, user.id, 'old-password', 'new-password');
  expect(jwt.verify(result.token, process.env.JWT_SECRET).auth_version).toBe(1);
  expect((await request(app).get('/private').auth(oldToken, { type: 'bearer' })).status).toBe(401);
  expect((await request(app).get('/private').auth(result.token, { type: 'bearer' })).status).toBe(
    200
  );
  const update = pool.query.mock.calls.find(([sql]) =>
    sql.startsWith('UPDATE users SET password_hash')
  );
  expect(update[0]).toContain('AND password_hash = $3');
});

test('rejected controller promise is forwarded to the error handler instead of hanging', async () => {
  const { app, pool, user } = fixture();
  pool.query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT auth_token_version')) return { rows: [user] };
    throw new Error('private database failure');
  });
  const res = await request(app)
    .post('/password')
    .auth(auth.issueJwt(user).token, { type: 'bearer' })
    .send({ currentPassword: 'old-password', newPassword: 'new-password' })
    .timeout(1000);
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ ok: false, error: 'safe error' });
});
