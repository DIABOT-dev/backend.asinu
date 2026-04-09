/**
 * Notification Service
 * Business logic cho notifications
 */

const { t } = require('../../i18n');

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
      `SELECT id, type, title, message, data, is_read, created_at, read_at, priority
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

    return { ok: false, error: t('notification.cannot_get_list') };
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
      return { ok: false, error: t('notification.not_found'), statusCode: 404 };
    }

    return { ok: true, notification: result.rows[0] };
  } catch (err) {

    return { ok: false, error: t('notification.cannot_mark_read') };
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

    return { ok: false, error: t('notification.cannot_mark_all_read') };
  }
}

/**
 * Get user's push token
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<string|null>} - Push token or null
 */
async function getUserPushToken(pool, userId) {
  const { rows } = await pool.query(
    'SELECT push_token FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.push_token || null;
}

/**
 * Save an in-app notification
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} type - Notification type
 * @param {string} title - Notification title
 * @param {string} message - Notification body
 * @param {Object} data - JSON data payload
 * @returns {Promise<void>}
 */
async function saveInAppNotification(pool, userId, type, title, message, data) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data) VALUES ($1,$2,$3,$4,$5)`,
    [userId, type, title, message, JSON.stringify(data)]
  );
}

/**
 * Delete a single notification
 * @param {Object} pool - Database pool
 * @param {number} notificationId - Notification ID
 * @param {number} userId - User ID (ownership check)
 * @returns {Promise<void>}
 */
async function deleteNotification(pool, notificationId, userId) {
  await pool.query(
    'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
    [notificationId, userId]
  );
}

/**
 * Delete all notifications for a user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteAllNotifications(pool, userId) {
  await pool.query(
    'DELETE FROM notifications WHERE user_id = $1',
    [userId]
  );
}

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUserPushToken,
  saveInAppNotification,
  deleteNotification,
  deleteAllNotifications,
};
