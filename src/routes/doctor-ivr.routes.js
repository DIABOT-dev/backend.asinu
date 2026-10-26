'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireDoctorSignature } = require('../middleware/doctor-signature.middleware');
const {
  handleUpload,
  audioUpload,
  verifyAudioMagicBytes,
} = require('../middleware/upload.middleware');
const ivr = require('../services/doctor-ivr/ivr.service');
const wrapper = (work) => async (req, res, next) => {
  try {
    await work(req, res);
  } catch (e) {
    if (e instanceof z.ZodError)
      return res.status(400).json({
        ok: false,
        code: 'IVR_INVALID_INPUT',
        error: 'Dữ liệu phiên chưa hợp lệ.',
        details: e.issues,
      });
    return next(e);
  }
};
const uuid = (value) => z.string().uuid().parse(value);
const patientInput = z
  .object({
    action: z.enum(['start', 'ack', 'back', 'snooze', 'answer']),
    revision: z.coerce.number().int().nonnegative().optional(),
    question_id: z.string().max(64).optional(),
    option_id: z.string().max(64).optional(),
    request_id: z.string().uuid().optional(),
    minutes: z.union([z.literal(15), z.literal(60), z.literal('tonight')]).optional(),
    skip_reason: z.enum(['no_response', 'no_speech', 'user_skip']).optional(),
    recording_consent: z.union([z.boolean(), z.literal('true')]).optional(),
    voice_pending: z.boolean().optional(),
    duration_s: z.coerce.number().nonnegative().max(65).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if ((data.action === 'answer' || data.action === 'back') && data.revision === undefined)
      ctx.addIssue({ code: 'custom', message: 'Missing revision' });
    if (data.action === 'answer' && (!data.request_id || !data.question_id))
      ctx.addIssue({ code: 'custom', message: 'Missing answer identity' });
  });
module.exports = function doctorIvrRoutes(pool) {
  const router = express.Router();
  const generationLimit = rateLimit({
    windowMs: 60000,
    limit: 5,
    keyGenerator: (req) => `${req.body?.tenant_id}:${req.body?.doctor_id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      ok: false,
      code: 'IVR_RATE_LIMIT',
      error: 'Bạn đã tạo nhiều bộ câu hỏi. Vui lòng thử lại sau một phút.',
    },
  });
  router.post(
    '/ivr/doctor',
    requireDoctorSignature,
    (req, res, next) =>
      req.body?.operation === 'generate' ? generationLimit(req, res, next) : next(),
    wrapper(async (req, res) => {
      const input = z
        .object({
          tenant_id: z.string().min(1).max(120),
          task_id: z.string().min(1).max(160),
          app_user_id: z.string().regex(/^[1-9]\d*$/),
          doctor_id: z.string().uuid(),
          doctor_name: z.string().min(1).max(160),
          specialty: z.string().max(160).optional(),
          operation: z.enum(['list', 'generate', 'save', 'approve', 'template', 'cancel', 'reply']),
          data: z.record(z.unknown()).default({}),
        })
        .strict()
        .parse(req.body);
      if (input.operation === 'list' && !ivr.enabled())
        return res.json({ ok: true, data: { enabled: false } });
      if (input.data.source !== undefined)
        z.enum(['ai', 'template', 'manual']).parse(input.data.source);
      if (input.data.session_id !== undefined) uuid(input.data.session_id);
      if (input.data.supplement !== undefined) z.boolean().parse(input.data.supplement);
      return res.json({ ok: true, data: await ivr.doctorOperation(pool, input) });
    })
  );
  router.get('/ivr/config', requireAuth, (_req, res) =>
    res.json({ ok: true, enabled: ivr.enabled(), capabilities: { app: true, call: false } })
  );
  router.get(
    '/ivr/sessions',
    requireAuth,
    wrapper(async (req, res) => {
      const query = z
        .object({ tenant_id: z.string().min(1), task_id: z.string().min(1) })
        .parse(req.query);
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        data: await ivr.patientList(pool, req.user.id, query.tenant_id, query.task_id),
      });
    })
  );
  router.get(
    '/ivr/sessions/:id',
    requireAuth,
    wrapper(async (req, res) =>
      res
        .set('Cache-Control', 'no-store')
        .json({ ok: true, data: await ivr.patientGet(pool, req.user.id, uuid(req.params.id)) })
    )
  );
  router.post(
    '/ivr/sessions/:id/action',
    requireAuth,
    wrapper(async (req, res) =>
      res.json({
        ok: true,
        data: await ivr.patientAction(
          pool,
          req.user.id,
          uuid(req.params.id),
          patientInput.parse(req.body)
        ),
      })
    )
  );
  router.post(
    '/ivr/sessions/:id/voice',
    requireAuth,
    handleUpload(audioUpload.single('file')),
    verifyAudioMagicBytes,
    wrapper(async (req, res) =>
      res.json({
        ok: true,
        data: await ivr.patientAction(
          pool,
          req.user.id,
          uuid(req.params.id),
          patientInput.parse({ ...req.body, action: 'answer' }),
          req.file
        ),
      })
    )
  );
  router.get(
    '/ivr/sessions/:id/audio/:questionId',
    requireAuth,
    wrapper(async (req, res) =>
      res.set('Cache-Control', 'private, no-store').json({
        ok: true,
        data: await ivr.questionAudio(
          pool,
          req.user.id,
          uuid(req.params.id),
          String(req.params.questionId)
        ),
      })
    )
  );
  router.get(
    '/ivr/media/:id',
    wrapper(async (req, res) => {
      const result = await ivr.media(
        pool,
        uuid(req.params.id),
        req.query.expires,
        req.query.signature,
        req.query.actor
      );
      res
        .set({
          'Cache-Control': 'private, no-store',
          'Content-Type': result.mime,
          'X-Content-Type-Options': 'nosniff',
        })
        .send(result.buffer);
    })
  );
  return router;
};
