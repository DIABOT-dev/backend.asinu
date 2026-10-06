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
  audioMimeType: jest.fn(() => 'audio/mpeg'),
  audioVersion: jest.fn(() => 'voice-v1'),
}));
jest.mock('../../src/services/checkin-call/access.service', () => ({
  createAttemptToken: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/personalization.service', () => ({
  preferences: jest.fn(),
  savePreferences: jest.fn(),
  userNotice: jest.fn(),
  userAudio: jest.fn(),
}));

const checkinCallRoutes = require('../../src/routes/checkin-call.routes');
const service = require('../../src/services/checkin-call/checkin-call.service');
const audio = require('../../src/services/checkin-call/audio.service');
const { createAttemptToken } = require('../../src/services/checkin-call/access.service');
const personalization = require('../../src/services/checkin-call/personalization.service');

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
      'POST /native/attempts/:id/decline',
      'GET /settings',
      'PUT /settings',
      'GET /voice-preferences',
      'PUT /voice-preferences',
      'GET /attempts/:id/user-notice',
      'GET /attempts/:id/user-audio/:key',
      'GET /active',
      'POST /test-call',
      'GET /episodes/:id',
      'GET /audio-config',
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

  test('voice preferences are read and saved only for the session user, with no shared cache', async () => {
    const preferences = {
      use_name: true,
      use_health: false,
      weather_enabled: false,
      address: 'bac',
    };
    personalization.preferences.mockResolvedValueOnce({ preferences });
    const read = await request(app).get('/checkin-call/voice-preferences').expect(200);
    expect(read.body).toEqual({ ok: true, preferences });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(personalization.preferences).toHaveBeenCalledWith(pool, 7);
    personalization.savePreferences.mockResolvedValueOnce(preferences);
    const write = await request(app)
      .put('/checkin-call/voice-preferences')
      .send(preferences)
      .expect(200);
    expect(write.headers['cache-control']).toBe('no-store');
    expect(personalization.savePreferences).toHaveBeenCalledWith(pool, 7, preferences);
  });

  test('personalized notice uses authenticated ownership and language without exposing it through caches', async () => {
    const notice = { version: 'snapshot', prompts: { user_prompt: 'Hello' } };
    personalization.userNotice.mockResolvedValueOnce(notice);
    const result = await request(app)
      .get('/checkin-call/attempts/own/user-notice')
      .set('accept-language', 'en')
      .expect(200);
    expect(result.body).toEqual({ ok: true, notice });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(personalization.userNotice).toHaveBeenCalledWith(pool, 'own', 7, 'en');
  });

  test('personalized audio preserves the exact snapshot and uses the normal base64 contract', async () => {
    personalization.userAudio.mockResolvedValueOnce({
      mime_type: 'audio/mpeg',
      audio_data: Buffer.from('test'),
    });
    const result = await request(app)
      .get('/checkin-call/attempts/own/user-audio/user_prompt')
      .set('X-Checkin-Notice-Version', 'snapshot')
      .set('accept-language', 'vi')
      .expect(200);
    expect(result.body).toEqual({
      ok: true,
      mimeType: 'audio/mpeg',
      base64: Buffer.from('test').toString('base64'),
    });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(personalization.userAudio).toHaveBeenCalledWith(
      pool,
      'own',
      7,
      'user_prompt',
      'vi',
      'snapshot'
    );
  });

  test('foreign-user notices and invalid consent settings return localized errors', async () => {
    personalization.userNotice.mockRejectedValueOnce(
      Object.assign(new Error('private details'), {
        statusCode: 404,
        i18nKey: 'checkinCall.error.attempt_not_found',
      })
    );
    const foreign = await request(app)
      .get('/checkin-call/attempts/foreign/user-notice')
      .expect(404);
    expect(foreign.body.error).not.toContain('private details');
    personalization.savePreferences.mockRejectedValueOnce(
      Object.assign(new Error('invalid'), {
        statusCode: 400,
        i18nKey: 'checkinCall.error.invalid_voice_preferences',
      })
    );
    const invalid = await request(app)
      .put('/checkin-call/voice-preferences')
      .send({ use_name: 'true' })
      .expect(400);
    expect(invalid.body.error).not.toBe('invalid');
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

  test('audio metadata is locale-specific, authenticated and never HTTP cached', async () => {
    const response = await request(app).get('/checkin-call/audio-config')
      .set('accept-language', 'en').expect(200);
    expect(audio.audioVersion).toHaveBeenCalledWith('en');
    expect(response.body).toEqual({ ok: true, version: 'voice-v1', language: 'en', mimeType: 'audio/mpeg' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(router.stack.find((layer) => layer.name === 'requireAuth')).toBeDefined();
  });

  test.each([
    ['get', '/audio/user_prompt', () => audio.getAudio],
    ['post', '/audio/conclusion', () => audio.synthesizeText],
    ['get', '/attempts/attempt-1/user-audio/user_prompt', () => personalization.userAudio],
    ['get', '/attempts/attempt-1/family-audio', () => service.getFamilyAudio],
  ])('%s %s includes the actual recording revision', async (method, path, mock) => {
    mock().mockResolvedValueOnce({
      mime_type: 'audio/mpeg', audio_data: Buffer.from('sound'), audio_version: 'actual-voice',
    });
    const response = await request(app)[method]('/checkin-call' + path)
      .send(method === 'post' ? { text: 'Conclusion' } : undefined).expect(200);
    expect(response.body).toEqual({
      ok: true, mimeType: 'audio/mpeg', base64: 'c291bmQ=', audioVersion: 'actual-voice',
    });
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
