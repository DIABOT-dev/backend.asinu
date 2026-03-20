/**
 * Payment Controller
 * HTTP handlers for payment endpoints
 */

const { t, getLang } = require('../i18n');
const paymentService = require('../services/payment/payment.service');

/**
 * POST /api/payments/qr
 * Create QR code for deposit
 */
async function createQR(pool, req, res) {
  const userId = req.user?.id;
  const amount = Number(req.body?.amount);

  if (!amount || isNaN(amount) || amount < 1000) {
    return res.status(400).json({ ok: false, error: t('error.min_amount', getLang(req)) });
  }

  try {
    const result = await paymentService.createQR(pool, userId, amount);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /api/payments/webhook
 * SePay webhook after user transfer
 */
async function handleWebhook(pool, req, res) {
  try {
    const result = await paymentService.handleWebhook(pool, req);
    return res.status(result.statusCode || 200).json({ ok: result.ok, message: result.message });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/payments/balance
 * Get user wallet balance
 */
async function getBalance(pool, req, res) {
  try {
    const result = await paymentService.getBalance(pool, req.user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/payments/history
 * Get user transaction history
 */
async function getHistory(pool, req, res) {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  try {
    const result = await paymentService.getHistory(pool, req.user.id, { page, limit });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  createQR,
  handleWebhook,
  getBalance,
  getHistory,
};
