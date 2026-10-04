'use strict';

const service = require('../services/payment/household-request.service');
const { getLang, t } = require('../i18n');

function respondError(req, res, error) {
  const lang = getLang(req);
  return res.status(error.statusCode || 500).json({
    ok: false,
    code: error.code || 'HOUSEHOLD_ERROR',
    error:
      error.statusCode && error.i18nKey
        ? t(error.i18nKey, lang, error.i18nParams)
        : t('error.household_unavailable', lang),
  });
}

async function listProtectedMembers(pool, req, res) {
  try {
    return res.json({ ok: true, ...(await service.listMembers(pool, req.user.id, getLang(req))) });
  } catch (error) {
    return respondError(req, res, error);
  }
}

async function addProtectedMember(pool, req, res) {
  try {
    const result = await service.addMember(pool, req.user.id, req.body, getLang(req));
    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    return respondError(req, res, error);
  }
}

async function removeProtectedMember(pool, req, res) {
  try {
    const result = await service.removeMember(pool, req.user.id, req.params, getLang(req));
    return res.json({ ok: true, ...result });
  } catch (error) {
    return respondError(req, res, error);
  }
}

module.exports = { listProtectedMembers, addProtectedMember, removeProtectedMember };
