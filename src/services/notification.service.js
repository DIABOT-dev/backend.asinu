/**
 * Notification Service
 * Business logic cho notifications
 */

/**
 * Get user notifications with pagination
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} options - { page, limit }
 * @returns {Promise<Object>} - { ok, notifications, pagination, error }
 */
async function getNotifications(pool, userId, options = {}) {
  const { page = 1, limit = 20 } = options;
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      `SELECT id, type, title, message, data, is_read, created_at, read_at
       FROM notifications 
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
      [userId]
    );

    const unreadResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );

    return {
      ok: true,
      notifications: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        unreadCount: parseInt(unreadResult.rows[0].count)
      }
    };
  } catch (err) {
    console.error('[notification.service] getNotifications failed:', err);
    return { ok: false, error: 'Không thể lấy danh sách thông báo' };
  }
}

/**
 * Mark notification as read
 * @param {Object} pool - Database pool
 * @param {number} notificationId - Notification ID
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, notification, error }
 */
async function markAsRead(pool, notificationId, userId) {
  try {
    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_read, read_at`,
      [notificationId, userId]
    );

    if (result.rows.length === 0) {
      return { ok: false, error: 'Không tìm thấy thông báo', statusCode: 404 };
    }

    return { ok: true, notification: result.rows[0] };
  } catch (err) {
    console.error('[notification.service] markAsRead failed:', err);
    return { ok: false, error: 'Không thể đánh dấu thông báo đã đọc' };
  }
}

/**
 * Mark all notifications as read
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, markedCount, error }
 */
async function markAllAsRead(pool, userId) {
  try {
    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND is_read = false
       RETURNING id`,
      [userId]
    );

    return { ok: true, markedCount: result.rows.length };
  } catch (err) {
    console.error('[notification.service] markAllAsRead failed:', err);
    return { ok: false, error: 'Không thể đánh dấu tất cả thông báo đã đọc' };
  }
}

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead
};
