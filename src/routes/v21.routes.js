'use strict';
const express = require('express'),
  rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireAiConsent } = require('../middleware/ai-consent.middleware');
const {
  imageUpload,
  audioUpload,
  handleUpload,
  verifyImageMagicBytes,
  verifyAudioMagicBytes,
} = require('../middleware/upload.middleware');
const c = require('../services/v21/common'),
  coins = require('../services/v21/coins.service'),
  med = require('../services/v21/medication.service');
const scan = require('../services/v21/medication-scan.service'),
  calls = require('../services/v21/medication-calls.service'),
  audio = require('../services/v21/audio.service');
const handle = (work) => async (req, res) => {
  try {
    await work(req, res);
  } catch (e) {
    c.captureUnexpected(e, req.route?.path);
    res
      .status(e instanceof c.z.ZodError ? 400 : e.code === '23505' ? 409 : e.statusCode || 503)
      .json({
        ok: false,
        code:
          e instanceof c.z.ZodError
            ? 'V21_INVALID_REQUEST'
            : e.code === '23505'
              ? 'MED_TIME_EXISTS'
              : e.statusCode
                ? e.code
                : 'V21_UNAVAILABLE',
      });
  }
};
const json = (work) => handle(async (req, res) => res.json({ ok: true, ...(await work(req)) }));
module.exports = (pool) => {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  // Short-lived, purpose-bound bearer link, with current Care Circle access rechecked.
  r.get(
    '/med-media/:id',
    handle(async (req, res) => {
      const file = await scan.readMedia(pool, req.params.id, req.query.token);
      res.type(file.mimeType).send(file.buffer);
    })
  );
  r.post(
    '/med-native/:id/decline',
    json((req) => calls.nativeDecline(pool, req.params.id, req.body?.capability || req.body?.token))
  );
  r.post(
    '/med-native/:id/status',
    json((req) => calls.nativeStatus(pool, req.params.id, req.body?.capability))
  );
  r.use(requireAuth);
  r.get(
    '/v21/config',
    json(async (req) => ({
      ...(await c.config(pool, req.user.id)),
      ...(await med.patients(pool, req.user.id)),
    }))
  );
  r.get(
    '/coins/today',
    json((req) => coins.today(pool, req.user.id))
  );
  r.get(
    '/coins/history',
    json((req) => coins.history(pool, req.user.id, req.query.before))
  );
  r.get(
    '/rewards',
    json((req) => coins.catalog(pool, req.user.id))
  );
  r.post(
    '/rewards/:code/redeem',
    json((req) => coins.redeem(pool, req.user.id, req.params.code, req.body))
  );
  r.get(
    '/medication/weekly-report',
    json((req) => med.weekly(pool, req.user.id, req.query.patientId))
  );
  r.get(
    '/medication/patients',
    json((req) => med.patients(pool, req.user.id))
  );
  r.post(
    '/medication/consents',
    json((req) => med.consentMany(pool, req.user.id, req.body))
  );
  r.post(
    '/medication/setup',
    json((req) => med.setup(pool, req.user.id, req.query.patientId, req.body))
  );
  r.get(
    '/med-schedules',
    json(async (req) => {
      const result = await med.overview(pool, req.user.id, req.query.patientId);
      result.items = result.items.map((i) => ({
        ...i,
        photoUrl: i.photo_media_id
          ? scan.mediaUrl(i.photo_media_id, i.patient_user_id, req.user.id)
          : null,
      }));
      return result;
    })
  );
  r.post(
    '/med-items',
    json((req) => med.createItem(pool, req.user.id, req.query.patientId, req.body))
  );
  r.post(
    '/med-schedules',
    json((req) => med.saveSchedule(pool, req.user.id, req.query.patientId, null, req.body))
  );
  r.put(
    '/med-schedules/:id',
    json((req) => med.saveSchedule(pool, req.user.id, req.query.patientId, req.params.id, req.body))
  );
  r.delete(
    '/med-schedules/:id',
    json((req) => med.remove(pool, req.user.id, req.query.patientId, req.params.id))
  );
  r.post(
    '/med-schedules/:id/consent',
    json((req) => med.consent(pool, req.user.id, req.params.id, req.body?.accept))
  );
  r.put(
    '/meal-times',
    json((req) => med.saveMeals(pool, req.user.id, req.query.patientId, req.body))
  );
  r.get(
    '/med-doses/today',
    json((req) => med.doses(pool, req.user.id, req.query.patientId))
  );
  r.get(
    '/med-doses/:id',
    json(async (req) => {
      const result = await calls.detail(pool, req.user.id, req.params.id);
      result.items = result.items.map((i) => ({
        ...i,
        photoUrl: i.photo_media_id
          ? scan.mediaUrl(i.photo_media_id, req.user.id, req.user.id)
          : null,
      }));
      return result;
    })
  );
  r.post(
    '/med-doses/:id/answer',
    json((req) => calls.answer(pool, req.user.id, req.params.id, req.body))
  );
  r.post(
    '/med-doses/:id/checkin',
    json((req) => calls.checkin(pool, req.user.id, req.params.id, req.body?.status))
  );
  r.post(
    '/med-call-attempts/:id/end',
    json((req) => calls.end(pool, req.user.id, req.params.id))
  );
  r.post(
    '/med-call-attempts/:id/accept',
    json((req) => calls.accept(pool, req.user.id, req.params.id))
  );
  r.post(
    '/medication/device',
    json((req) =>
      calls.registerDevice(
        pool,
        req.user.id,
        req.body?.platform,
        req.body?.token,
        req.body?.supported
      )
    )
  );
  r.put(
    '/medication/family-preferences',
    json((req) => med.preferences(pool, req.user.id, req.query.patientId, req.body))
  );
  const uploadLimit = rateLimit({
    windowMs: 60000,
    max: 5,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: true,
    legacyHeaders: false,
  });
  r.post(
    '/med-items/scan',
    requireAiConsent(pool),
    uploadLimit,
    handleUpload(imageUpload.single('image')),
    verifyImageMagicBytes,
    json((req) => scan.scan(pool, req.user.id, req.query.patientId, req.file))
  );
  r.post(
    '/med-items/transcribe',
    requireAiConsent(pool),
    uploadLimit,
    handleUpload(audioUpload.single('audio')),
    verifyAudioMagicBytes,
    json(async (req) => {
      const patient = await c.patientAccess(pool, req.user.id, req.query.patientId);
      await c.assertFeature(pool, patient, 'medication');
      if (
        Number(req.user.id) !== patient &&
        !(await require('../services/ai/ai-consent.service').mayProcessAi(pool, patient))
      )
        throw c.error('MED_PATIENT_AI_CONSENT_REQUIRED', 403);
      const text = await require('../services/voice/voice.service').transcribeAudio(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
      return { text: scan.cleanName(text).slice(0, 120) };
    })
  );
  r.get(
    '/med-doses/:id/audio',
    handle(async (req, res) => {
      const result = await audio.getAudio(
        pool,
        req.user.id,
        req.params.id,
        req.query.phase || 'prompt',
        req.headers['accept-language']
      );
      res.type(result.mime_type || 'audio/wav').send(result.audio_data);
    })
  );
  r.get(
    '/med-schedules/:id/audio',
    handle(async (req, res) => {
      const result = await audio.getAudio(
        pool,
        req.user.id,
        req.params.id,
        'consent',
        req.headers['accept-language'],
        true
      );
      res.type(result.mime_type || 'audio/wav').send(result.audio_data);
    })
  );
  return r;
};
