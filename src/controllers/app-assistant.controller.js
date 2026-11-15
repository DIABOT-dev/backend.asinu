'use strict';
const assistant = require('../services/assistant/app-assistant.service');
const { hasAiConsent } = require('../services/ai/ai-consent.service');
const { getLang, t } = require('../i18n');
const medication = require('../services/assistant/medication-assistant.service');
const profileTools = require('../services/assistant/profile-assistant.service');
const domainTools = require('../services/assistant/domain-tools.service');
const { z } = require('zod');

async function consent(pool, req, res, next) {
  try {
    if (!(await hasAiConsent(pool, req.user.id))) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    return next();
  } catch (error) { return next(error); }
}
async function plan(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(Object.assign(new Error('Assistant request cancelled'), { code: 'APP_ASSISTANT_CANCELLED' })); };
  req.once('aborted', cancel);
  res.once('close', cancel);
  if (req.aborted || res.destroyed) cancel();
  try {
    controller.signal.throwIfAborted();
    const result = await assistant.plan(req.body, getLang(req), { pool, userId: req.user.id, signal: controller.signal });
    controller.signal.throwIfAborted();
    const allowed = await hasAiConsent(pool, req.user.id);
    controller.signal.throwIfAborted();
    if (!allowed) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (['CARE_CIRCLE_DISABLED', 'CAREGIVER_VIEW_DISABLED', 'V21_FEATURE_DISABLED'].includes(error.code)) return res.status(403).json({ ok: false, code: error.code });
    if (error.status === 429) return res.set('Retry-After', '30').status(429).json({ ok: false, code: 'APP_ASSISTANT_RATE_LIMITED' });
    const invalid = error.code === 'APP_ASSISTANT_INVALID_REQUEST';
    return res.status(invalid ? 400 : 503).json({ ok: false,
      code: invalid ? error.code : 'APP_ASSISTANT_UNAVAILABLE' });
  } finally {
    req.off('aborted', cancel);
    res.off('close', cancel);
  }
}
async function applyMedication(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  const input = z.object({ planToken: z.string().min(1).max(20000) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ ok: false, code: 'APP_ASSISTANT_INVALID_REQUEST' });
  try { return res.json({ ok: true, ...(await medication.execute(pool, req.user.id, input.data.planToken)) }); }
  catch (error) {
    const known = ['APP_ASSISTANT_PLAN_EXPIRED', 'APP_ASSISTANT_MEDICATION_CONFLICT', 'MED_SCHEDULE_LIMIT',
      'MED_ITEM_NOT_FOUND', 'MED_SCHEDULE_NOT_FOUND', 'V21_FEATURE_DISABLED', 'AI_CONSENT_REQUIRED', 'MED_REQUEST_CHANGED', '23505'].includes(error.code);
    return res.status(known ? error.code === '23505' ? 409 : error.statusCode || 409 : 503)
      .json({ ok: false, code: known ? error.code === '23505' ? 'MED_TIME_EXISTS' : error.code : 'APP_ASSISTANT_UNAVAILABLE' });
  }
}
async function applyProfile(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  const input = z.object({ planToken: z.string().min(1).max(12000) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ ok: false, code: 'APP_ASSISTANT_INVALID_REQUEST' });
  try { return res.json({ ok: true, ...(await profileTools.execute(pool, req.user.id, input.data.planToken)) }); }
  catch (error) {
    const known = ['APP_ASSISTANT_PLAN_EXPIRED', 'APP_ASSISTANT_PROFILE_CONFLICT', 'AI_CONSENT_REQUIRED'].includes(error.code);
    return res.status(known ? error.statusCode || 409 : 503).json({ ok: false, code: known ? error.code : 'APP_ASSISTANT_UNAVAILABLE' });
  }
}
async function applyTool(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  const input = z.object({ planToken: z.string().min(1).max(24000) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ ok: false, code: 'APP_ASSISTANT_INVALID_REQUEST' });
  try { return res.json({ ok: true, ...(await domainTools.execute(pool, req.user.id, input.data.planToken, getLang(req))) }); }
  catch (error) {
    const known = error.statusCode >= 400 && error.statusCode < 500;
    return res.status(known ? error.statusCode : 503).json({ ok: false,
      code: known ? error.code || 'APP_ASSISTANT_TOOL_REJECTED' : 'APP_ASSISTANT_UNAVAILABLE',
      ...(known && (error.publicMessage || error.i18nKey) ? { error: error.publicMessage || t(error.i18nKey, getLang(req), error.i18nParams) } : {}) });
  }
}
module.exports = { consent, plan, applyMedication, applyProfile, applyTool };
