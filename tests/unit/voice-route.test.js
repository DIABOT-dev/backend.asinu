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
jest.mock('../../src/controllers/voice.controller', () => ({
  createVoiceController: jest.fn(() => ({
    chat: (req, res) =>
      res.json({ ok: true, name: req.file.originalname, type: req.file.mimetype }),
    usage: (_req, res) => res.json({ ok: true, voiceUsed: 0 }),
  })),
}));

const voiceRoutes = require('../../src/routes/voice.routes');
const { createVoiceController } = require('../../src/controllers/voice.controller');

const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);

describe('voice route wiring and upload policy', () => {
  const pool = {};
  const app = express();
  app.use('/api/voice', voiceRoutes(pool));

  test('passes the pool to the controller factory and requires authentication', async () => {
    expect(createVoiceController).toHaveBeenCalledWith(pool);
    await request(app).get('/api/voice/usage').expect(401);
    await request(app)
      .get('/api/voice/usage')
      .set('authorization', 'Bearer test-token')
      .expect(200, {
        ok: true,
        voiceUsed: 0,
      });
  });

  test('accepts authenticated audio with valid container bytes', async () => {
    const response = await request(app)
      .post('/api/voice/chat')
      .set('authorization', 'Bearer test-token')
      .attach('audio', wav, { filename: 'message.wav', contentType: 'audio/wav' })
      .expect(200);
    expect(response.body).toEqual({ ok: true, name: 'message.wav', type: 'audio/wav' });
  });

  test('rejects non-audio MIME types and spoofed audio bytes', async () => {
    const wrongMime = await request(app)
      .post('/api/voice/chat')
      .set('authorization', 'Bearer test-token')
      .attach('audio', wav, { filename: 'message.wav', contentType: 'text/plain' })
      .expect(400);
    expect(wrongMime.body).toMatchObject({ ok: false });

    const wrongSignature = await request(app)
      .post('/api/voice/chat')
      .set('authorization', 'Bearer test-token')
      .attach('audio', Buffer.from('this is not audio'), {
        filename: 'message.wav',
        contentType: 'audio/wav',
      })
      .expect(400);
    expect(wrongSignature.body).toMatchObject({ ok: false });
  });

  test('rejects audio exceeding the 10 MB limit', async () => {
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1);
    wav.copy(tooLarge);
    const response = await request(app)
      .post('/api/voice/chat')
      .set('authorization', 'Bearer test-token')
      .attach('audio', tooLarge, { filename: 'large.wav', contentType: 'audio/wav' })
      .expect(400);
    expect(response.body).toMatchObject({ ok: false });
  });
});
