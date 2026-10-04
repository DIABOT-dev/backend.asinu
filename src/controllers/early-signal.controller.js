'use strict';

const service = require('../services/early-signal/early-signal-request.service');
const { getLang, t } = require('../i18n');

function sendError(req, res, error) {
  return res.status(error.statusCode || 500).json({
    ok: false,
    code: error.code || 'EARLY_SIGNAL_ERROR',
    error: error.i18nKey
      ? t(error.i18nKey, getLang(req), error.i18nParams)
      : t('early_signal.unavailable', getLang(req)),
  });
}

async function evaluate(pool, req, res) {
  try {
    const assessment = await service.evaluate(pool, req.user.id, req.body, getLang(req));
    return res.status(201).json({ ok: true, assessment });
  } catch (error) {
    return sendError(req, res, error);
  }
}

async function latest(pool, req, res) {
  try {
    const assessment = await service.latest(pool, req.user.id, req.query, getLang(req));
    return res.json({ ok: true, assessment });
  } catch (error) {
    return sendError(req, res, error);
  }
}

async function familyLatest(pool, req, res) {
  try {
    const assessments = await service.familyLatest(pool, req.user.id, getLang(req));
    return res.json({ ok: true, assessments });
  } catch (error) {
    return sendError(req, res, error);
  }
}

module.exports = { evaluate, latest, familyLatest };
