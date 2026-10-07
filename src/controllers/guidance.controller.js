'use strict';

const service = require('../services/onboarding/guidance.service');
const { t, getLang } = require('../i18n');

async function getGuidance(pool, req, res) {
  const progress = await service.getProgress(pool, req.user.id);
  return res.json({ ok: true, progress });
}

async function updateGuidance(pool, req, res) {
  const result = await service.updateProgress(pool, req.user.id, req.body);
  if (!result.ok) {
    return res.status(result.statusCode).json({ ...result, error: t('error.invalid_data', getLang(req)) });
  }
  return res.json(result);
}

async function replayGuidance(pool, req, res) {
  const progress = await service.replayProgress(pool, req.user.id);
  return res.json({ ok: true, progress });
}

module.exports = { getGuidance, updateGuidance, replayGuidance };
