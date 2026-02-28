const { t, getLang } = require('../i18n');
const { logBaseSchema, logDataSchemas } = require('../validation/validation.schemas');
const mobileService = require('../services/mobile.service');

function validateMobileLog(payload) {
  const base = logBaseSchema.safeParse(payload);
  if (!base.success) {
    return { ok: false, error: t('error.invalid_data'), details: base.error.issues };
  }

  const dataSchema = logDataSchemas[base.data.log_type];
  if (!dataSchema) {
    return { ok: false, error: t('error.invalid_log_type') };
  }

  const dataParsed = dataSchema.safeParse(base.data.data || {});
  if (!dataParsed.success) {
    return { ok: false, error: t('error.invalid_data'), details: dataParsed.error.issues };
  }

  return { ok: true, value: { ...base.data, data: dataParsed.data } };
}

async function createMobileLog(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  if (req.body?.user_id && Number(req.body.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: t('error.user_id_mismatch', getLang(req)) });
  }

  const validation = validateMobileLog(req.body || {});
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error, details: validation.details });
  }

  const result = await mobileService.createLog(pool, req.user.id, validation.value);

  if (!result.ok) {
    return res.status(result.statusCode || 500).json(result);
  }

  return res.status(200).json({ ok: true, log_id: result.logId, log_type: result.logType });
}

async function getTodayLogs(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  const result = await mobileService.getTodayLogs(pool, req.user.id, {
    type: req.query.type
  });

  if (!result.ok) {
    return res.status(result.statusCode || 500).json(result);
  }

  return res.status(200).json(result);
}

async function getRecentLogs(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  const result = await mobileService.getRecentLogs(pool, req.user.id, {
    type: req.query.type,
    limit: req.query.limit
  });

  if (!result.ok) {
    return res.status(result.statusCode || 500).json(result);
  }

  return res.status(200).json(result);
}

module.exports = { createMobileLog, getRecentLogs };
