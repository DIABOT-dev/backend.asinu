/**
 * Health Alert Service
 * Business logic for health alerts to care circle members
 */

/**
 * Get all active care-circle connections for a user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Array>} - Array of { care_member_id, care_member_name }
 */
async function getActiveConnections(pool, userId) {
  const { rows } = await pool.query(
    `SELECT
      CASE
        WHEN requester_id = $1 THEN addressee_id
        WHEN addressee_id = $1 THEN requester_id
      END as care_member_id,
      u.full_name as care_member_name
    FROM user_connections uc
    JOIN users u ON (
      (uc.requester_id = $1 AND u.id = uc.addressee_id) OR
      (uc.addressee_id = $1 AND u.id = uc.requester_id)
    )
    WHERE uc.status = 'accepted'
    AND (uc.requester_id = $1 OR uc.addressee_id = $1)`,
    [userId]
  );
  return rows;
}

/**
 * Get user's full name
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<string>} - Full name or fallback
 */
async function getUserName(pool, userId) {
  const { rows } = await pool.query(
    'SELECT full_name FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.full_name || `User ${userId}`;
}

/**
 * Build and insert alert notifications for care circle members
 * @param {Object} pool - Database pool
 * @param {Array} connections - Array of { care_member_id }
 * @param {Object} notificationTemplate - { type, title, message, data }
 * @returns {Promise<number>} - Number of notifications inserted
 */
async function insertAlertNotifications(pool, connections, notificationTemplate) {
  if (connections.length === 0) return 0;

  const notifications = connections.map(conn => ({
    user_id: conn.care_member_id,
    type: notificationTemplate.type,
    title: notificationTemplate.title,
    message: notificationTemplate.message,
    data: notificationTemplate.data,
    is_read: false,
    created_at: new Date(),
    updated_at: new Date(),
  }));

  const insertQuery = `
    INSERT INTO notifications (user_id, type, title, message, data, is_read, created_at, updated_at)
    VALUES ${notifications.map((_, index) =>
      `($${index * 8 + 1}, $${index * 8 + 2}, $${index * 8 + 3}, $${index * 8 + 4}, $${index * 8 + 5}, $${index * 8 + 6}, $${index * 8 + 7}, $${index * 8 + 8})`
    ).join(', ')}
  `;

  const insertValues = notifications.flatMap(n => [
    n.user_id, n.type, n.title, n.message,
    JSON.stringify(n.data), n.is_read, n.created_at, n.updated_at
  ]);

  await pool.query(insertQuery, insertValues);
  return notifications.length;
}

module.exports = {
  getActiveConnections,
  getUserName,
  insertAlertNotifications,
};
