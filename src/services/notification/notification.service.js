/**
 * Notification Service
 * Business logic cho notifications
 */

const { t } = require('../../i18n');
const { capitalizeFirstLetter, formatPersonName } = require('../../lib/text-format');
const { withNotificationTransaction } = require('./notification-dispatch.service');
const {
  getHiddenNotificationTypes,
  isHealthMetricReminderSuppressed,
} = require('./health-metric-reminders.policy');

function presentNotification(notification) {
  const displayed = {
    ...notification,
    title: capitalizeFirstLetter(notification.title),
    message: capitalizeFirstLetter(notification.message),
  };
  if (
    notification.type !== 'caregiver_alert' ||
    notification.data?.templateId !== 'reengage_care_circle'
  )
    return displayed;

  // Older inbox rows contain the rendered sentence, not its name parameters.
  // Correct only this known template; retain its original name and day count
  // as a snapshot. Never rewrite stored history or recalculate today's count.
  const legacyTemplates = [
    ['vi', /^(.*?) đã (\d+) ngày chưa cập nhật sức khỏe\. Vui lòng liên hệ để kiểm tra\.$/u],
    [
      'en',
      /^(.*?) has not shared a health update for (\d+) days\. Please contact them to check in\.$/u,
    ],
  ];
  for (const [language, pattern] of legacyTemplates) {
    const match = notification.message?.match(pattern);
    if (!match) continue;
    const fallback = t('notification.reengagement.family_fallback', language);
    const name =
      match[1].toLowerCase() === fallback.toLowerCase()
        ? capitalizeFirstLetter(fallback)
        : formatPersonName(match[1]);
    displayed.title = t('notification.reengagement.family_title', language);
    displayed.message = t('notification.reengagement.care_circle_alert', language, {
      patientName: name,
      days: match[2],
    });
    break;
  }
  return displayed;
}

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
  const hiddenTypes = getHiddenNotificationTypes();

  try {
    const result = await pool.query(
      `SELECT id, type, title, message, data, is_read, created_at, read_at, priority
       FROM notifications
       WHERE user_id = $1
         AND NOT (type = ANY($4::text[]))
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset, hiddenTypes]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND NOT (type = ANY($2::text[]))',
      [userId, hiddenTypes]
    );

    const unreadResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false AND NOT (type = ANY($2::text[]))',
      [userId, hiddenTypes]
    );

    return {
      ok: true,
      notifications: result.rows.map(presentNotification),
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        unreadCount: parseInt(unreadResult.rows[0].count),
      },
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
         AND NOT (type = ANY($2::text[]))
       RETURNING id`,
      [userId, getHiddenNotificationTypes()]
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
  const { rows } = await pool.query('SELECT push_token FROM users WHERE id = $1', [userId]);
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
 * @returns {Promise<{notificationId: number, existing: boolean}|null>} null when this reminder family is paused
 */
async function saveInAppNotification(
  pool,
  userId,
  type,
  title,
  message,
  data = {},
  priority = 'low'
) {
  if (isHealthMetricReminderSuppressed(type)) return null;
  const values = [
    userId,
    type,
    capitalizeFirstLetter(title),
    capitalizeFirstLetter(message),
    JSON.stringify(data),
    priority,
  ];
  return withNotificationTransaction(pool, userId, async (client) => {
    // Client retries must not create repeated inbox entries. JSONB equality
    // ignores object key order, while preserving distinct event payloads.
    const existing = await client.query(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = $2
        AND title = $3 AND message = $4 AND data = $5::jsonb
        AND created_at >= NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      values.slice(0, 5)
    );
    if (existing.rows[0]) return { notificationId: existing.rows[0].id, existing: true };
    const inserted = await client.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
      values
    );
    return { notificationId: inserted.rows[0].id, existing: false };
  });
}

/**
 * Delete a single notification
 * @param {Object} pool - Database pool
 * @param {number} notificationId - Notification ID
 * @param {number} userId - User ID (ownership check)
 * @returns {Promise<void>}
 */
async function deleteNotification(pool, notificationId, userId) {
  const result = await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [
    notificationId,
    userId,
  ]);
  return { deleted: result.rowCount > 0 };
}

/**
 * Delete all notifications for a user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteAllNotifications(pool, userId) {
  await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
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
