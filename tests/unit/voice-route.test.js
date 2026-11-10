const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    if (req.get('authorization') !== 'Bearer test-token') {
      return res.status(401).json({ ok: false });
    }
    req.user = { id: 7 };
    return next();
  },
}));
const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);

describe('check-in dictation routing stays independent from the chatbot switch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { requireAuth } = require('../../src/middleware/auth.middleware');
  const { chatbotGate } = require('../../src/middleware/chatbot.gate.middleware');
  const upload = require('../../src/middleware/upload.middleware');
  const source = fs.readFileSync(path.join(__dirname, '../../src/routes/mobile.routes.js'), 'utf8');
  const registrations = ['/checkin/transcribe', '/chat/transcribe'].map((route) => {
    const start = source.indexOf(`  router.post(\n    '${route}',`);
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf('\n  );', start) + '\n  );'.length);
  }).join('\n');
  function harness() {
    const router = express.Router();
    const transcribe = jest.fn((_pool, req, res) => {
      if (!req.file) return res.status(400).json({ ok: false });
      return res.json({ ok: true, text: 'Tôi hơi mệt' });
    });
    const requireAiConsent = () => (req, res, next) => req.get('X-Test-AI-Consent') === 'yes'
      ? next() : res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    // Execute the actual registrations with the real upload and chatbot middleware.
    // Authentication/consent and the provider are deterministic boundary doubles.
    // eslint-disable-next-line no-new-func
    new Function('router', 'pool', 'requireAuth', 'requireAiConsent', 'chatbotGate', 'handleUpload',
      'audioUpload', 'verifyAudioMagicBytes', 'bindController', 'transcribeAudio', registrations)(
      router, {}, requireAuth, requireAiConsent, chatbotGate, upload.handleUpload, upload.audioUpload,
      upload.verifyAudioMagicBytes, (handler, pool) => (req, res) => handler(pool, req, res), transcribe
    );
    const app = express(); app.use('/api/mobile', router);
    return { app, transcribe };
  }
  const call = (app, route) => request(app).post('/api/mobile' + route)
    .set('authorization', 'Bearer test-token').set('X-Test-AI-Consent', 'yes');
  test('turning off the chatbot does not disable check-in dictation and does not reopen chat', async () => {
    const original = process.env.CHATBOT_ENABLED;
    process.env.CHATBOT_ENABLED = 'false';
    try {
      const { app, transcribe } = harness();
      const result = await call(app, '/checkin/transcribe').attach('audio', wav, { filename: 'voice.wav', contentType: 'audio/wav' }).expect(200);
      expect(result.body).toEqual({ ok: true, text: 'Tôi hơi mệt' });
      await call(app, '/chat/transcribe').attach('audio', wav, { filename: 'voice.wav', contentType: 'audio/wav' }).expect(403);
      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env.CHATBOT_ENABLED;
      else process.env.CHATBOT_ENABLED = original;
    }
  });
  test('dictation still requires authentication, AI consent and valid audio before reaching the provider', async () => {
    const { app, transcribe } = harness();
    await request(app).post('/api/mobile/checkin/transcribe').expect(401);
    await request(app).post('/api/mobile/checkin/transcribe').set('authorization', 'Bearer test-token').expect(403);
    await call(app, '/checkin/transcribe').attach('audio', Buffer.from('not an audio file'), { filename: 'voice.wav', contentType: 'audio/wav' }).expect(400);
    await call(app, '/checkin/transcribe').expect(400);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
