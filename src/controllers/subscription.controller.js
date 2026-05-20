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
 * POST /api/subscriptions/qr/gift
 * body: { months: 1|3|6|12, recipient_user_id: number }
 *
 * Allows a paying user to buy Premium for a recipient who is already in
 * their Care Circle (MVP audit FIX #10). Refuses when the recipient is
 * not connected, to prevent gifting Premium to arbitrary user IDs.
 */
async function createQRForRecipient(pool, req, res) {
  const payerId = req.user?.id;
  const requested = parseInt(req.body?.months) || 1;
  const recipientId = parseInt(req.body?.recipient_user_id);

  if (!Number.isFinite(recipientId) || recipientId <= 0) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_RECIPIENT',
      error: t('error.invalid_recipient', getLang(req)) || 'recipient_user_id không hợp lệ',
    });
  }
  if (!VALID_MONTHS.includes(requested)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_subscription_months', getLang(req)) });
  }

  try {
    const result = await subscriptionService.createQRForRecipient(pool, payerId, recipientId, requested);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'NOT_IN_CARE_CIRCLE') {
      return res.status(403).json({
        ok: false,
        code: 'NOT_IN_CARE_CIRCLE',
        error: t('error.not_in_care_circle', getLang(req)) ||
               'Bạn chỉ có thể mua Premium cho người đã kết nối trong Care Circle.',
      });
    }
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
  createQRForRecipient,
  getStatus,
  getPlans,
  getHistory,
  payWithWallet,
};
