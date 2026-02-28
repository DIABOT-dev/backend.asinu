/**
 * CareCircle Service
 * Business logic for care circle connections (invitations, connections, permissions)
 */

const { notifyCareCircleInvitation, notifyCareCircleAccepted } = require('./push.notification.service');
const { t } = require('../i18n');

// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_PERMISSIONS = {
  can_view_logs: false,
  can_receive_alerts: false,
  can_ack_escalation: false
};

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Normalize permissions object
 * @param {Object} input - Raw permissions input
 * @returns {Object} - Normalized permissions
 */
function normalizePermissions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_PERMISSIONS };
  }
  return {
    can_view_logs: Boolean(input.can_view_logs),
    can_receive_alerts: Boolean(input.can_receive_alerts),
    can_ack_escalation: Boolean(input.can_ack_escalation)
  };
}

/**
 * Get user display name
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<string>} - Display name
 */
async function getUserDisplayName(pool, userId) {
  const result = await pool.query(
    'SELECT display_name, full_name, email FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows[0];
  return user?.display_name || user?.full_name || user?.email || t('careCircle.user_label');
}

// =====================================================
// INVITATION OPERATIONS
// =====================================================

/**
 * Create a new invitation
 * @param {Object} pool - Database pool
 * @param {number} requesterId - Requester user ID
 * @param {Object} data - Invitation data
 * @returns {Promise<Object>} - { ok, invitation, error }
 */
async function createInvitation(pool, requesterId, data) {
  const { addressee_id, relationship_type, role, permissions } = data;

  // Validate not self-invite
  if (addressee_id === requesterId) {
    return { ok: false, error: t('careCircle.cannot_invite_self') };
  }

  const perms = normalizePermissions(permissions);

  try {
    const result = await pool.query(
      `INSERT INTO user_connections (
        requester_id,
        addressee_id,
        status,
        requested_by,
        relationship_type,
        role,
        permissions,
        created_at,
        updated_at
      ) VALUES ($1,$2,'pending',$1,$3,$4,$5,NOW(),NOW())
      RETURNING *`,
      [requesterId, addressee_id, relationship_type || null, role || null, JSON.stringify(perms)]
    );

    const invitation = result.rows[0];

    // Get requester name for notification
    const requesterName = await getUserDisplayName(pool, requesterId);

    // Send push notification (non-blocking)
    notifyCareCircleInvitation(pool, addressee_id, requesterName, invitation.id)
      .catch(err => console.error('[careCircle.service] Failed to send notification:', err));

    return { ok: true, invitation };
  } catch (err) {
    if (err?.code === '23505') {
      return { ok: false, error: t('careCircle.connection_exists'), statusCode: 409 };
    }
    console.error('[careCircle.service] createInvitation failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Get invitations for user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} direction - 'sent', 'received', or 'all'
 * @returns {Promise<Object>} - { ok, invitations, error }
 */
async function getInvitations(pool, userId, direction = 'all') {
  const conditions = [];
  const params = [];

  if (direction === 'sent') {
    params.push(userId);
    conditions.push(`requester_id = $${params.length}`);
  } else if (direction === 'received') {
    params.push(userId);
    conditions.push(`addressee_id = $${params.length}`);
  } else {
    params.push(userId);
    conditions.push(`(requester_id = $${params.length} OR addressee_id = $${params.length})`);
  }

  params.push('pending');
  conditions.push(`status = $${params.length}`);

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT uc.*,
              u1.full_name as requester_full_name, u1.email as requester_email, u1.phone as requester_phone,
              u2.full_name as addressee_full_name, u2.email as addressee_email, u2.phone as addressee_phone
       FROM user_connections uc
       LEFT JOIN users u1 ON uc.requester_id = u1.id
       LEFT JOIN users u2 ON uc.addressee_id = u2.id
       ${whereClause} ORDER BY uc.created_at DESC`,
      params
    );
    return { ok: true, invitations: result.rows };
  } catch (err) {
    console.error('[careCircle.service] getInvitations failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Accept an invitation
 * @param {Object} pool - Database pool
 * @param {number} invitationId - Invitation ID
 * @param {number} userId - Addressee user ID
 * @returns {Promise<Object>} - { ok, connection, error }
 */
async function acceptInvitation(pool, invitationId, userId) {
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [invitationId, userId]
    );

    if (result.rows.length === 0) {
      return { ok: false, error: t('careCircle.invitation_not_found'), statusCode: 404 };
    }

    const connection = result.rows[0];

    // Get accepter name for notification
    const accepterName = await getUserDisplayName(pool, userId);

    // Send push notification (non-blocking)
    notifyCareCircleAccepted(pool, connection.requester_id, accepterName)
      .catch(err => console.error('[careCircle.service] Failed to send acceptance notification:', err));

    return { ok: true, connection };
  } catch (err) {
    console.error('[careCircle.service] acceptInvitation failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Reject an invitation
 * @param {Object} pool - Database pool
 * @param {number} invitationId - Invitation ID
 * @param {number} userId - Addressee user ID
 * @returns {Promise<Object>} - { ok, invitation, error }
 */
async function rejectInvitation(pool, invitationId, userId) {
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [invitationId, userId]
    );

    if (result.rows.length === 0) {
      return { ok: false, error: t('careCircle.invitation_not_found'), statusCode: 404 };
    }

    return { ok: true, invitation: result.rows[0] };
  } catch (err) {
    console.error('[careCircle.service] rejectInvitation failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

// =====================================================
// CONNECTION OPERATIONS
// =====================================================

/**
 * Get all accepted connections for user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, connections, error }
 */
async function getConnections(pool, userId) {
  try {
    const result = await pool.query(
      `SELECT uc.*,
              u1.full_name as requester_full_name, u1.email as requester_email, u1.phone as requester_phone,
              u2.full_name as addressee_full_name, u2.email as addressee_email, u2.phone as addressee_phone
       FROM user_connections uc
       LEFT JOIN users u1 ON uc.requester_id = u1.id
       LEFT JOIN users u2 ON uc.addressee_id = u2.id
       WHERE uc.status = 'accepted'
         AND (uc.requester_id = $1 OR uc.addressee_id = $1)
       ORDER BY uc.updated_at DESC`,
      [userId]
    );
    return { ok: true, connections: result.rows };
  } catch (err) {
    console.error('[careCircle.service] getConnections failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Delete/remove a connection
 * @param {Object} pool - Database pool
 * @param {number} connectionId - Connection ID
 * @param {number} userId - User ID (must be part of connection)
 * @returns {Promise<Object>} - { ok, connection, error }
 */
async function deleteConnection(pool, connectionId, userId) {
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'removed', updated_at = NOW()
       WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)
       RETURNING *`,
      [connectionId, userId]
    );

    if (result.rows.length === 0) {
      return { ok: false, error: t('careCircle.connection_not_found'), statusCode: 404 };
    }

    return { ok: true, connection: result.rows[0] };
  } catch (err) {
    console.error('[careCircle.service] deleteConnection failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Update a connection (relationship_type, role)
 * @param {Object} pool - Database pool
 * @param {number} connectionId - Connection ID
 * @param {number} userId - User ID (must be part of connection)
 * @param {Object} data - Update data
 * @returns {Promise<Object>} - { ok, connection, error }
 */
async function updateConnection(pool, connectionId, userId, data) {
  const { relationship_type, role } = data;

  if (!relationship_type && !role) {
    return { ok: false, error: t('careCircle.need_at_least_one_field'), statusCode: 400 };
  }

  try {
    // First verify the user is part of this connection
    const checkResult = await pool.query(
      `SELECT * FROM user_connections 
       WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2) AND status = 'accepted'`,
      [connectionId, userId]
    );

    if (checkResult.rows.length === 0) {
      return { ok: false, error: t('careCircle.connection_not_found'), statusCode: 404 };
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (relationship_type !== undefined) {
      updates.push(`relationship_type = $${paramIndex}`);
      values.push(relationship_type);
      paramIndex++;
    }

    if (role !== undefined) {
      updates.push(`role = $${paramIndex}`);
      values.push(role);
      paramIndex++;
    }

    updates.push(`updated_at = NOW()`);
    values.push(connectionId, userId);

    const updateQuery = `
      UPDATE user_connections
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex} AND (requester_id = $${paramIndex + 1} OR addressee_id = $${paramIndex + 1})
      RETURNING *
    `;

    const result = await pool.query(updateQuery, values);

    return { ok: true, connection: result.rows[0] };
  } catch (err) {
    console.error('[careCircle.service] updateConnection failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Helpers
  normalizePermissions,
  getUserDisplayName,
  
  // Invitations
  createInvitation,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  
  // Connections
  getConnections,
  deleteConnection,
  updateConnection
};
