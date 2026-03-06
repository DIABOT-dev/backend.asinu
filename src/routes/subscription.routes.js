const express = require('express');
const { t, getLang } = require('../i18n');
const { requireAuth } = require('../middleware/auth.middleware');
const subscriptionService = require('../services/subscription.service');

function subscriptionRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/subscriptions/qr
   * Tạo QR thanh toán Premium.
   * Body: { months?: number } (default 1)
   */
  router.post('/qr', requireAuth, async (req, res) => {
    const userId = req.user?.id;
    const requested = parseInt(req.body?.months) || 1;
    const VALID_MONTHS = [1, 3, 6, 12];
    if (!VALID_MONTHS.includes(requested)) {
      return res.status(400).json({ ok: false, error: t('error.invalid_subscription_months', getLang(req)) });
    }

    try {
      const result = await subscriptionService.createQR(pool, userId, requested);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/subscriptions/status
   * Trạng thái subscription hiện tại.
   */
  router.get('/status', requireAuth, async (req, res) => {
    try {
      const result = await subscriptionService.getStatus(pool, req.user.id);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/subscriptions/plans
   * Danh sách gói cước (public — không cần auth).
   */
  router.get('/plans', (req, res) => {
    return res.status(200).json({ ok: true, plans: Object.values(subscriptionService.PLANS) });
  });

  /**
   * GET /api/subscriptions/history?page=1&limit=20
   * Lịch sử đăng ký.
   */
  router.get('/history', requireAuth, async (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    try {
      const result = await subscriptionService.getHistory(pool, req.user.id, { page, limit });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = subscriptionRoutes;
