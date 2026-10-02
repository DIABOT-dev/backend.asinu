'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const householdService = require('../services/payment/household.service');
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

function householdRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    try {
      return res.json({
        ok: true,
        ...(await householdService.listProtectedMembers(pool, req.user.id, getLang(req))),
      });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.post('/members', async (req, res) => {
    try {
      const result = await householdService.addProtectedMember(
        pool,
        req.user.id,
        Number(req.body?.user_id),
        getLang(req)
      );
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  router.delete('/members/:userId', async (req, res) => {
    try {
      const result = await householdService.removeProtectedMember(
        pool,
        req.user.id,
        Number(req.params.userId),
        getLang(req)
      );
      return res.json({ ok: true, ...result });
    } catch (error) {
      return respondError(req, res, error);
    }
  });

  return router;
}

module.exports = householdRoutes;
