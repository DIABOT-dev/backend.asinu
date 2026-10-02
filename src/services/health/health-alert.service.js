/**
 * Health Alert Service
 * Business logic for health alerts to care circle members
 */

const { sendAndSave } = require('../notification/basic.notification.service');

/**
 * Get all active care-circle connections for a user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Array>} - Array of { care_member_id, care_member_name }
 */
async function getActiveConnections(pool, userId) {
  // Only return connections where the OTHER side has opted into receiving
  // alerts. Without `can_receive_alerts` filter, caregivers who explicitly
  // turned alerts off would still be paged for emergencies — a real
  // privacy + permissions violation.
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
      AND (uc.requester_id = $1 OR uc.addressee_id = $1)
      AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true`,
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
  const { rows } = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
  return rows[0]?.full_name || `User ${userId}`;
}

/**
 * Save and push alert notifications for permitted care circle members.
 * @param {Object} pool - Database pool
 * @param {Array} connections - Array of { care_member_id }
 * @param {Object} notificationTemplate - { type, title, message, data }
 * @returns {Promise<number>} - Number of notifications inserted
 */
async function insertAlertNotifications(pool, connections, notificationTemplate) {
  if (connections.length === 0) return 0;

  const deliveries = await Promise.all(
    connections.map((connection) =>
      sendAndSave(
        pool,
        connection.care_member_id,
        notificationTemplate.type,
        notificationTemplate.title,
        notificationTemplate.message,
        notificationTemplate.data
      )
    )
  );
  return deliveries.filter(Boolean).length;
}

module.exports = {
  getActiveConnections,
  getUserName,
  insertAlertNotifications,
};
