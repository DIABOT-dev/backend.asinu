'use strict';

const subscriptionService = require('../services/payment/subscription.service');
const { PLAN_DEFINITIONS, localizedPlanName } = require('../services/payment/subscription-catalog');
const { t, getLang } = require('../i18n');

async function getStatus(pool, req, res) {
  try {
    const status = await subscriptionService.getStatus(pool, req.user.id);
    res.vary('Accept-Language');
    return res.json({ ok: true, ...status, planName: localizedPlanName(status.planCode, getLang(req)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

function getPlans(_pool, req, res) {
  res.set('Cache-Control', 'public, max-age=3600');
  res.vary('Accept-Language');
  return res.json({ ok: true, plans: Object.values(PLAN_DEFINITIONS).map((plan) => ({
    ...plan,
    label: localizedPlanName(plan.code, getLang(req)),
  })) });
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
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
  }
}

module.exports = { getStatus, getPlans, getHistory };
