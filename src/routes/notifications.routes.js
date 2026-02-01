const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');

function notificationRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/notifications
   * Lấy danh sách notifications của user
   */
  router.get('/', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT id, type, title, message, data, is_read, created_at, read_at
         FROM notifications 
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      );

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
        [req.user.id]
      );

      const unreadResult = await pool.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
        [req.user.id]
      );

      return res.status(200).json({
        ok: true,
        notifications: result.rows,
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0].count),
          unreadCount: parseInt(unreadResult.rows[0].count)
        }
      });
    } catch (error) {
      console.error('[notifications] Error fetching notifications:', error);
      return res.status(500).json({
        ok: false,
        error: 'Không thể lấy danh sách thông báo'
      });
    }
  });

  /**
   * PUT /api/notifications/:id/read
   * Đánh dấu notification đã đọc
   */
  router.put('/:id/read', requireAuth, async (req, res) => {
    try {
      const notificationId = parseInt(req.params.id);

      if (isNaN(notificationId)) {
        return res.status(400).json({
          ok: false,
          error: 'ID thông báo không hợp lệ'
        });
      }

      const result = await pool.query(
        `UPDATE notifications 
         SET is_read = true, read_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, is_read, read_at`,
        [notificationId, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: 'Không tìm thấy thông báo'
        });
      }

      return res.status(200).json({
        ok: true,
        notification: result.rows[0]
      });
    } catch (error) {
      console.error('[notifications] Error marking notification as read:', error);
      return res.status(500).json({
        ok: false,
        error: 'Không thể đánh dấu thông báo đã đọc'
      });
    }
  });

  /**
   * PUT /api/notifications/mark-all-read
   * Đánh dấu tất cả notifications đã đọc
   */
  router.put('/mark-all-read', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE notifications 
         SET is_read = true, read_at = NOW()
         WHERE user_id = $1 AND is_read = false
         RETURNING id`,
        [req.user.id]
      );

      return res.status(200).json({
        ok: true,
        markedCount: result.rows.length
      });
    } catch (error) {
      console.error('[notifications] Error marking all notifications as read:', error);
      return res.status(500).json({
        ok: false,
        error: 'Không thể đánh dấu tất cả thông báo đã đọc'
      });
    }
  });

  return router;
}

module.exports = notificationRoutes;