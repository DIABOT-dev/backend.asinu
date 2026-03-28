/**
 * Subscription Controller
 * HTTP handlers for subscription endpoints
 */

const { t, getLang } = require('../i18n');
const subscriptionService = require('../services/payment/subscription.service');

/**
 * POST /api/subscriptions/qr
 * Create QR code for Premium payment
 */
const VALID_MONTHS = [1, 3, 6, 12];

async function createQR(pool, req, res) {
  const userId = req.user?.id;
  const requested = parseInt(req.body?.months) || 1;
  if (!VALID_MONTHS.includes(requested)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_subscription_months', getLang(req)) });
  }

  try {
    const result = await subscriptionService.createQR(pool, userId, requested);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/subscriptions/status
 * Get current subscription status
 */
async function getStatus(pool, req, res) {
  try {
    const result = await subscriptionService.getStatus(pool, req.user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/subscriptions/plans
 * List available plans (public)
 */
function getPlans(pool, req, res) {
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ ok: true, plans: Object.values(subscriptionService.PLANS) });
}

/**
 * GET /api/subscriptions/history
 * Get subscription history
 */
async function getHistory(pool, req, res) {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  try {
    const result = await subscriptionService.getHistory(pool, req.user.id, { page, limit });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /api/subscriptions/wallet
 * Thanh toán gói Premium bằng số dư ví
 */
async function payWithWallet(pool, req, res) {
  const userId = req.user?.id;
  const requested = parseInt(req.body?.months) || 1;
  if (!VALID_MONTHS.includes(requested)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_subscription_months', getLang(req)) });
  }

  try {
    const result = await subscriptionService.payWithWallet(pool, userId, requested);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.message });
    }
    return res.status(200).json({ ok: true, expiresAt: result.expiresAt, planMonths: result.planMonths });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  createQR,
  getStatus,
  getPlans,
  getHistory,
  payWithWallet,
};
