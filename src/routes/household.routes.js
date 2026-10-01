'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const householdService = require('../services/payment/household.service');

function respondError(res, error) {
  return res.status(error.statusCode || 500).json({
    ok: false,
    code: error.code || 'HOUSEHOLD_ERROR',
    error: error.statusCode ? error.message : 'Không thể xử lý gói gia đình lúc này.',
  });
}

function householdRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    try {
      return res.json({ ok: true, ...(await householdService.listProtectedMembers(pool, req.user.id)) });
    } catch (error) {
      return respondError(res, error);
    }
  });

  router.post('/members', async (req, res) => {
    try {
      const result = await householdService.addProtectedMember(
        pool,
        req.user.id,
        Number(req.body?.user_id)
      );
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      return respondError(res, error);
    }
  });

  router.delete('/members/:userId', async (req, res) => {
    try {
      const result = await householdService.removeProtectedMember(
        pool,
        req.user.id,
        Number(req.params.userId)
      );
      return res.json({ ok: true, ...result });
    } catch (error) {
      return respondError(res, error);
    }
  });

  return router;
}

module.exports = householdRoutes;
