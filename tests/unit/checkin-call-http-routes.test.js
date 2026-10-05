'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 7 };
    next();
  },
}));
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({
  settings: jest.fn(),
  eligibleContacts: jest.fn().mockResolvedValue([]),
  saveSettings: jest.fn(),
  getActive: jest.fn(),
  startTestCall: jest.fn(),
  getEpisode: jest.fn(),
  getAttempt: jest.fn(),
  getFamilyAudio: jest.fn(),
  answer: jest.fn(),
  startTriage: jest.fn(),
  completeTriage: jest.fn(),
  confirmFamily: jest.fn(),
  seen: jest.fn(),
  accept: jest.fn(),
  decline: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/audio.service', () => ({
  getAudio: jest.fn(),
  synthesizeText: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/access.service', () => ({
  createAttemptToken: jest.fn(),
}));

const checkinCallRoutes = require('../../src/routes/checkin-call.routes');
const service = require('../../src/services/checkin-call/checkin-call.service');
const audio = require('../../src/services/checkin-call/audio.service');
const { createAttemptToken } = require('../../src/services/checkin-call/access.service');

describe('check-in call HTTP routes', () => {
  const pool = {};
  const router = checkinCallRoutes(pool);
  const app = express();
  app.use(express.json());
  app.use('/checkin-call', router);

  beforeEach(() => jest.clearAllMocks());

  test('retains every endpoint and method during controller extraction', () => {
    const actual = router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route.path}`
        )
      );
    expect(actual).toEqual([
      'GET /settings',
      'PUT /settings',
      'GET /active',
      'POST /test-call',
      'GET /episodes/:id',
      'GET /audio/:key',
      'POST /audio/conclusion',
      'GET /attempts/:id',
      'GET /attempts/:id/family-audio',
      'POST /episodes/:id/answer',
      'POST /episodes/:id/triage/start',
      'POST /episodes/:id/triage/complete',
      'POST /episodes/:id/family-confirm',
      'POST /attempts/:id/seen',
      'POST /attempts/:id/accept',
      'POST /attempts/:id/decline',
      'GET /attempts/:id/token',
    ]);
  });

  test('declining is scoped to the authenticated recipient', async () => {
    service.decline.mockResolvedValueOnce({ ok: true });
    await request(app).post('/checkin-call/attempts/attempt-7/decline').expect(200);
    expect(service.decline).toHaveBeenCalledWith(pool, 'attempt-7', 7);
  });

  test('settings preserve the authenticated user id and response shape', async () => {
    service.settings.mockResolvedValueOnce({ enabled: true });
    const response = await request(app).get('/checkin-call/settings').expect(200);
    expect(response.body).toEqual({ ok: true, settings: { enabled: true }, contacts: [] });
    expect(service.eligibleContacts).toHaveBeenCalledWith(pool, 7);
    expect(service.settings).toHaveBeenCalledWith(pool, 7);
  });

  test('episode response exposes only public fields', async () => {
    service.getEpisode.mockResolvedValueOnce({
      id: 'episode-1',
      user_id: 7,
      state: 'CONTACT_USER',
      severity: 'NONE',
      triage_context: { body_location: 'head' },
      private_token: 'hidden',
    });
    const response = await request(app).get('/checkin-call/episodes/episode-1').expect(200);
    expect(response.body.episode).toMatchObject({ id: 'episode-1', state: 'CONTACT_USER' });
    expect(response.body.episode).not.toHaveProperty('private_token');
  });

  test('audio keeps the base64 payload contract', async () => {
    audio.getAudio.mockResolvedValueOnce({
      mime_type: 'audio/mpeg',
      audio_data: Buffer.from('sound'),
    });
    const response = await request(app).get('/checkin-call/audio/user_prompt').expect(200);
    expect(response.body).toEqual({ ok: true, mimeType: 'audio/mpeg', base64: 'c291bmQ=' });
  });

  test('family audio passes the exact recipient and request language to the service', async () => {
    service.getFamilyAudio.mockResolvedValueOnce({
      mime_type: 'audio/mpeg',
      audio_data: Buffer.from('family-sound'),
    });
    const response = await request(app)
      .get('/checkin-call/attempts/attempt-1/family-audio')
      .set('accept-language', 'en')
      .expect(200);
    expect(service.getFamilyAudio).toHaveBeenCalledWith(pool, 'attempt-1', 7, 'en');
    expect(response.body).toEqual({
      ok: true,
      mimeType: 'audio/mpeg',
      base64: Buffer.from('family-sound').toString('base64'),
    });
  });

  test('unavailable call token remains a localized 503', async () => {
    createAttemptToken.mockResolvedValueOnce({ unavailable: true });
    const response = await request(app).get('/checkin-call/attempts/attempt-1/token').expect(503);
    expect(response.body).toMatchObject({ ok: false });
    expect(response.body.error).toBeTruthy();
  });

  test('service errors are mapped through the controller, not leaked', async () => {
    service.settings.mockRejectedValueOnce(new Error('secret DB failure'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(app).get('/checkin-call/settings').expect(500);
      expect(response.body).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
      expect(response.body.error).not.toContain('secret DB failure');
    } finally {
      spy.mockRestore();
    }
  });
});
