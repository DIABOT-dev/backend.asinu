process.env.JWT_SECRET = 'ivr-http-fixture-secret';
jest.mock('../src/services/doctor-ivr/ivr.service', () => ({
  patientAction: jest.fn(),
  enabled: jest.fn(() => true),
}));
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const ivr = require('../src/services/doctor-ivr/ivr.service');
const routes = require('../src/routes/doctor-ivr.routes');

describe('patient IVR HTTP contract with actual authentication and input validation', () => {
  let app, pool, id, token, body;
  beforeEach(() => {
    jest.clearAllMocks();
    id = randomUUID();
    pool = { query: jest.fn(async () => ({ rows: [{ auth_token_version: 0 }] })) };
    app = express();
    app.locals.authPool = pool;
    app.use(express.json());
    app.use('/api/doctor', routes(pool));
    app.use((error, _req, res, _next) =>
      res.status(error.statusCode || 500).json({ code: error.code })
    );
    token = jwt.sign({ id: 1, auth_version: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    body = { action: 'answer', question_id: 'q1', request_id: randomUUID(), revision: 0 };
    ivr.patientAction.mockResolvedValue({ id, current_question_id: 'q2' });
  });
  const endpoint = (id) => `/api/doctor/ivr/sessions/${id}/action`;

  test.each(['user_skip', 'no_speech', 'no_response'])(
    'accepts the app skip reason %s without inventing an option',
    async (reason) => {
      const input = { ...body, skip_reason: reason };
      const result = await request(app)
        .post(endpoint(id))
        .auth(token, { type: 'bearer' })
        .send(input);
      expect(result.status).toBe(200);
      expect(ivr.patientAction).toHaveBeenCalledWith(pool, 1, id, input);
      expect(ivr.patientAction.mock.calls[0][3].option_id).toBeUndefined();
    }
  );

  test.each(['invalid_reason', '', null])('rejects an unknown skip reason: %j', async (reason) => {
    const result = await request(app)
      .post(endpoint(id))
      .auth(token, { type: 'bearer' })
      .send({ ...body, skip_reason: reason });
    expect(result.status).toBe(400);
    expect(ivr.patientAction).not.toHaveBeenCalled();
  });

  test.each([
    'missing_revision',
    'missing_request',
    'bad_request_id',
    'unknown_field',
    'negative_revision',
  ])('rejects %s before mutating progress', async (kind) => {
    const input = { ...body, option_id: 'q1_a' };
    if (kind === 'missing_revision') delete input.revision;
    if (kind === 'missing_request') delete input.request_id;
    if (kind === 'bad_request_id') input.request_id = 'not-a-uuid';
    if (kind === 'unknown_field') input.is_red_flag = false;
    if (kind === 'negative_revision') input.revision = -1;
    const result = await request(app)
      .post(endpoint(id))
      .auth(token, { type: 'bearer' })
      .send(input);
    expect(result.status).toBe(400);
    expect(ivr.patientAction).not.toHaveBeenCalled();
  });

  test('rejects a missing token, expired token and revoked session', async () => {
    expect((await request(app).post(endpoint(id)).send(body)).status).toBe(401);
    const expired = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: -1 });
    expect(
      (await request(app).post(endpoint(id)).auth(expired, { type: 'bearer' }).send(body)).status
    ).toBe(401);
    pool.query.mockResolvedValue({ rows: [{ auth_token_version: 1 }] });
    expect(
      (await request(app).post(endpoint(id)).auth(token, { type: 'bearer' }).send(body)).status
    ).toBe(401);
    expect(ivr.patientAction).not.toHaveBeenCalled();
  });

  test('does not advertise the unimplemented native call channel', async () => {
    const result = await request(app).get('/api/doctor/ivr/config').auth(token, { type: 'bearer' });
    expect(result.status).toBe(200);
    expect(result.body.capabilities).toEqual({ app: true, call: false });
  });
});
