'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const service = require('../services/early-signal/early-signal.service');

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    ok: false,
    code: error.code || 'EARLY_SIGNAL_ERROR',
    error: error.statusCode ? error.message : 'Không thể đánh giá Tín hiệu sớm lúc này.',
  });
}

function earlySignalRoutes(pool) {
  const router = express.Router();
  router.use(requireAuth);

  router.post('/evaluate', async (req, res) => {
    const userId = Number(req.body?.user_id || req.user.id);
    try {
      const assessment = await service.evaluate(pool, userId, {
        requestedBy: req.user.id,
        triggerType: 'manual',
      });
      return res.status(201).json({ ok: true, assessment });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/latest', async (req, res) => {
    const userId = Number(req.query.user_id || req.user.id);
    try {
      return res.json({ ok: true, assessment: await service.latest(pool, userId, req.user.id) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/family', async (req, res) => {
    try {
      return res.json({ ok: true, assessments: await service.familyLatest(pool, req.user.id) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = earlySignalRoutes;
