'use strict';
const { z } = require('zod');
const { t, getLang } = require('../i18n');
const ivr = require('../services/doctor-ivr/ivr.service');
const calls = require('../services/doctor-ivr/ivr.calls');
const policy = require('../services/doctor-ivr/ivr.policy');
const uuid = (value) => z.string().uuid().parse(value);
const previewInput = z
  .object({
    text: z.string().trim().min(1).max(600),
    greeting: z.string().trim().max(300).optional(),
    fixed: z.boolean().optional(),
    options: z
      .array(
        z
          .object({
            key: z.number().int().min(1).max(6),
            label: z.string().trim().min(1).max(120),
          })
          .strict()
      )
      .max(6),
  })
  .strict();
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
    if (['answer', 'back'].includes(data.action) && data.revision === undefined)
      ctx.addIssue({ code: 'custom', message: 'Missing revision' });
    if (data.action === 'answer' && (!data.request_id || !data.question_id))
      ctx.addIssue({ code: 'custom', message: 'Missing answer identity' });
  });
const handle = (work) => async (req, res, next) => {
  try {
    await work(req, res);
  } catch (e) {
    if (e instanceof z.ZodError)
      return res.status(400).json({
        ok: false,
        code: 'IVR_INVALID_INPUT',
        error: t('doctor_ivr.invalid_input', getLang(req)),
        details: e.issues,
      });
    next(e);
  }
};
const json = (res, data) => res.set('Cache-Control', 'no-store').json({ ok: true, data });
function createDoctorIvrController(pool) {
  return {
    config: handle(async (_req, res) =>
      res.json({
        ok: true,
        enabled: ivr.enabled(),
        capabilities: { app: true, call: calls.enabled() },
      })
    ),
    doctorOperation: handle(async (req, res) => {
      const input = z
        .object({
          tenant_id: z.string().min(1).max(120),
          task_id: z.string().min(1).max(160),
          app_user_id: z.string().regex(/^[1-9]\d*$/),
          doctor_id: z.string().uuid(),
          doctor_name: z.string().min(1).max(160),
          specialty: z.string().max(160).optional(),
          operation: z.enum([
            'list',
            'generate',
            'dictate',
            'draft_reply',
            'preview',
            'recording',
            'save',
            'approve',
            'template',
            'cancel',
            'reply',
            'reply_video',
          ]),
          data: z.record(z.string(), z.unknown()).default({}),
        })
        .strict()
        .parse(req.body);
      if (input.data.source !== undefined)
        z.enum(['ai', 'template', 'manual']).parse(input.data.source);
      if (input.operation === 'draft_reply' || input.data.session_id !== undefined)
        uuid(input.data.session_id);
      if (input.operation === 'draft_reply')
        input.data = z.object({
          session_id: z.string().uuid(),
          revision: z.object({
            current_reply: z.string().trim().min(1),
            feedback: z.string().trim().min(1),
          }).strict().optional(),
        }).strict().parse(input.data);
      if (input.operation === 'reply_video')
        input.data = z.object({
          session_id: z.string().uuid(),
          request_id: z.string().uuid(),
          mime_type: z.enum(['video/mp4', 'video/webm']),
          video_base64: z.string().min(1).max(13_981_016),
        }).strict().parse(input.data);
      if (input.data.replace_session_id !== undefined) uuid(input.data.replace_session_id);
      if (input.data.supplement !== undefined) z.boolean().parse(input.data.supplement);
      if (input.operation === 'preview' || input.operation === 'recording') {
        const audio = await ivr.doctorOperation(pool, {
          ...input,
          data: input.operation === 'preview'
            ? previewInput.parse(input.data)
            : z.object({ answer_id: z.string().uuid() }).strict().parse(input.data),
        });
        return res
          .set('Cache-Control', 'private, no-store')
          .type(audio.mime_type)
          .send(audio.audio_data);
      }
      return json(res, await ivr.doctorOperation(pool, input));
    }),
    adminOperation: handle(async (req, res) => {
      const input = z
        .object({
          tenant_id: z.string().min(1).max(120),
          admin_id: z.string().uuid(),
          operation: z.enum(['get', 'save', 'templates', 'template_save', 'template_delete']),
          data: z.record(z.string(), z.unknown()).default({}),
        })
        .strict()
        .parse(req.body);
      return json(res, await policy.adminOperation(pool, input));
    }),
    registerCallDevice: handle(async (req, res) => {
      const { supported, platform, token } = z
        .object({
          supported: z.boolean(),
          platform: z.enum(['ios', 'android']),
          token: z.string().min(1).max(4096).nullable().optional(),
        })
        .strict()
        .parse(req.body);
      return json(res, await calls.registerDevice(pool, req.user.id, supported, platform, token));
    }),
    callAction: handle(async (req, res) => {
      const { action } = z
        .object({ action: z.enum(['accept', 'decline', 'end']) })
        .strict()
        .parse(req.body);
      return json(res, await calls.callAction(pool, req.user.id, uuid(req.params.id), action));
    }),
    declineNativeCall: handle(async (req, res) => {
      const { capability } = z
        .object({ capability: z.string().max(160) })
        .strict()
        .parse(req.body);
      return json(
        res,
        await calls.callAction(pool, null, uuid(req.params.id), 'decline', capability)
      );
    }),
    listSessions: handle(async (req, res) => {
      const input = z
        .object({ tenant_id: z.string().min(1), task_id: z.string().min(1) })
        .parse(req.query);
      return json(res, await ivr.patientList(pool, req.user.id, input.tenant_id, input.task_id));
    }),
    getSession: handle(async (req, res) =>
      json(res, await ivr.patientGet(pool, req.user.id, uuid(req.params.id)))
    ),
    patientAction: handle(async (req, res) =>
      json(
        res,
        await ivr.patientAction(
          pool,
          req.user.id,
          uuid(req.params.id),
          patientInput.parse(req.body)
        )
      )
    ),
    uploadVoice: handle(async (req, res) =>
      json(
        res,
        await ivr.patientAction(
          pool,
          req.user.id,
          uuid(req.params.id),
          patientInput.parse({ ...req.body, action: 'answer' }),
          req.file
        )
      )
    ),
    questionAudio: handle(async (req, res) =>
      json(
        res,
        await ivr.questionAudio(
          pool,
          req.user.id,
          uuid(req.params.id),
          String(req.params.questionId)
        )
      )
    ),
    answerAudio: handle(async (req, res) =>
      json(
        res.set('Cache-Control', 'private, no-store'),
        await ivr.answerAudio(
          pool,
          req.user.id,
          uuid(req.params.id),
          req.params.questionId,
          req.params.optionId
        )
      )
    ),
    closingAudio: handle(async (req, res) =>
      json(res, await ivr.closingAudio(pool, req.user.id, uuid(req.params.id)))
    ),
    media: handle(async (req, res) => {
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
    }),
  };
}
module.exports = { createDoctorIvrController };
