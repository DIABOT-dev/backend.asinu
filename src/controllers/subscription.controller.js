'use strict';

const subscriptionService = require('../services/payment/subscription.service');
const { PLAN_DEFINITIONS } = require('../services/payment/subscription-catalog');

async function getStatus(pool, req, res) {
  try {
    return res.json({ ok: true, ...(await subscriptionService.getStatus(pool, req.user.id)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function getPlans(_pool, _req, res) {
  res.set('Cache-Control', 'public, max-age=3600');
  return res.json({ ok: true, plans: Object.values(PLAN_DEFINITIONS) });
}

async function getHistory(pool, req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  try {
    return res.json({
      ok: true,
      ...(await subscriptionService.getHistory(pool, req.user.id, { page, limit })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = { getStatus, getPlans, getHistory };
