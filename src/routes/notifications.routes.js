const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const notificationService = require('../services/notification.service');
const { runEngagementNotifications, previewEngagementNotification } = require('../services/engagement.notification.service');
const { t, getLang } = require('../i18n');

function notificationRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/notifications
   * Lấy danh sách notifications của user
   */
  router.get('/', requireAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await notificationService.getNotifications(pool, req.user.id, { page, limit });

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  });

  /**
   * PUT /api/notifications/:id/read
   * Đánh dấu notification đã đọc
   */
  router.put('/:id/read', requireAuth, async (req, res) => {
    const notificationId = parseInt(req.params.id);

    if (isNaN(notificationId)) {
      return res.status(400).json({
        ok: false,
        error: t('error.invalid_notification_id', getLang(req))
      });
    }

    const result = await notificationService.markAsRead(pool, notificationId, req.user.id);

    if (!result.ok) {
      const statusCode = result.statusCode || 500;
      return res.status(statusCode).json(result);
    }

    return res.status(200).json(result);
  });

  /**
   * PUT /api/notifications/mark-all-read
   * Đánh dấu tất cả notifications đã đọc
   */
  router.put('/mark-all-read', requireAuth, async (req, res) => {
    const result = await notificationService.markAllAsRead(pool, req.user.id);

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  });

  /**
   * GET /api/notifications/engagement/preview
   * AI sinh nội dung thông báo cho user hiện tại (KHÔNG gửi push thật).
   * Dùng cho nút test trong app — frontend nhận title+body rồi show local notification.
   */
  router.get('/engagement/preview', requireAuth, async (req, res) => {
    try {
      const result = await previewEngagementNotification(pool, req.user.id);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error('[notifications] preview error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/notifications/engagement/run
   * Chạy AI-driven engagement notifications cho tất cả users lâu không vào app.
   * Được gọi bởi external scheduler (cron) — bảo vệ bằng CRON_SECRET.
   */
  router.post('/engagement/run', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['x-cron-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
    }

    try {
      console.log('[notifications] Manual trigger: engagement notifications');
      const result = await runEngagementNotifications(pool);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[notifications] engagement run error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = notificationRoutes;