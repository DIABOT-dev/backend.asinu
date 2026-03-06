const express = require('express');
const { t, getLang } = require('../i18n');
const { requireAuth } = require('../middleware/auth.middleware');
const paymentService = require('../services/payment.service');

function paymentRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/payments/qr
   * Tạo QR nạp tiền — user cần đăng nhập
   * Body: { amount: number }
   */
  router.post('/qr', requireAuth, async (req, res) => {
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
  });

  /**
   * POST /api/payments/webhook
   * SePay gọi vào sau khi user chuyển khoản.
   * Không cần JWT — xác thực bằng API key trong header Authorization.
   * Header: Authorization: Apikey {SEPAY_API_KEY}
   */
  router.post('/webhook', async (req, res) => {
    try {
      const result = await paymentService.handleWebhook(pool, req);
      return res.status(result.statusCode || 200).json({ ok: result.ok, message: result.message });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/payments/balance
   * Lấy số dư ví của user hiện tại
   */
  router.get('/balance', requireAuth, async (req, res) => {
    try {
      const result = await paymentService.getBalance(pool, req.user.id);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/payments/history?page=1&limit=20
   * Lịch sử giao dịch của user
   */
  router.get('/history', requireAuth, async (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    try {
      const result = await paymentService.getHistory(pool, req.user.id, { page, limit });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {

      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = paymentRoutes;
