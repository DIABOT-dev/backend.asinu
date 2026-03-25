const { answerSchema, emergencySchema, emergencyTriageAnswerSchema } = require('../validation/asinuBrain.schemas');
const { getNextState, submitAnswer, getTimeline, postEmergency, startEmergencyTriage, submitEmergencyTriageAnswer } = require('../services/asinuBrain.service');
const { t, getLang } = require('../../src/i18n');

async function getNextHandler(pool, req, res) {
  try {
    const result = await getNextState(pool, req.userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain next failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function postAnswerHandler(pool, req, res) {
  if (req.body?.user_id) {
    return res.status(400).json({ ok: false, error: t('error.user_id_not_allowed', getLang(req)) });
  }
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: t('error.invalid_payload', getLang(req)), details: parsed.error.issues });
  }

  try {
    const result = await submitAnswer(pool, req.userId, parsed.data);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain answer failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function getTimelineHandler(pool, req, res) {
  try {
    const timeline = await getTimeline(pool, req.userId);
    return res.status(200).json({ ok: true, timeline });
  } catch (err) {
    console.error('asinu-brain timeline failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function postEmergencyHandler(pool, req, res) {
  if (req.body?.user_id) {
    return res.status(400).json({ ok: false, error: t('error.user_id_not_allowed', getLang(req)) });
  }
  const parsed = emergencySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: t('error.invalid_payload', getLang(req)), details: parsed.error.issues });
  }

  try {
    const result = await postEmergency(pool, req.userId, parsed.data);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain emergency failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function startEmergencyTriageHandler(pool, req, res) {
  try {
    const result = await startEmergencyTriage(pool, req.userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('emergency triage start failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

async function submitEmergencyTriageAnswerHandler(pool, req, res) {
  if (req.body?.user_id) {
    return res.status(400).json({ ok: false, error: t('error.user_id_not_allowed', getLang(req)) });
  }
  const parsed = emergencyTriageAnswerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: t('error.invalid_payload', getLang(req)), details: parsed.error.issues });
  }
  try {
    const result = await submitEmergencyTriageAnswer(pool, req.userId, parsed.data);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('emergency triage answer failed:', err);
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

module.exports = {
  getNextHandler,
  postAnswerHandler,
  getTimelineHandler,
  postEmergencyHandler,
  startEmergencyTriageHandler,
  submitEmergencyTriageAnswerHandler
};
