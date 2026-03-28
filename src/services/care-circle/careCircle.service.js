/**
 * CareCircle Service
 * Business logic for care circle connections (invitations, connections, permissions)
 */

const { sendAndSave } = require('../notification/basic.notification.service');
const { t } = require('../../i18n');
const { isPremium, PREMIUM_CONNECTION_LIMIT } = require('../payment/subscription.service');
const { cacheGet, cacheSet } = require('../../lib/redis');

const FREE_TIER_CONNECTION_LIMIT = 3;

// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_PERMISSIONS = {
  can_view_logs: true,
  can_receive_alerts: true,
  can_ack_escalation: true,
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
  const cached = await cacheGet(`user:name:${userId}`);
  if (cached) return cached;

  const result = await pool.query(
    'SELECT display_name, full_name, email FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows[0];
  const name = user?.display_name || user?.full_name || user?.email || t('careCircle.user_label');
  await cacheSet(`user:name:${userId}`, name, 7200); // 2 hours
  return name;
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
  if (Number(addressee_id) === Number(requesterId)) {
    return { ok: false, error: t('careCircle.cannot_invite_self') };
  }

  // Check connection limit (3 free, 50 premium)
  const userIsPremium = await isPremium(pool, requesterId);
  const connectionLimit = userIsPremium ? PREMIUM_CONNECTION_LIMIT : FREE_TIER_CONNECTION_LIMIT;
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM user_connections
     WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
    [requesterId]
  );
  const connectionCount = Number(countRows[0].count);
  if (connectionCount >= connectionLimit) {
    return {
      ok: false,
      error: userIsPremium
        ? t('careCircle.premium_limit_reached', 'vi', { limit: PREMIUM_CONNECTION_LIMIT })
        : t('careCircle.upgrade_premium'),
      code: 'CARE_CIRCLE_LIMIT',
      statusCode: 403,
    };
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

    // Send push + save in-app notification (non-blocking)
    pool.query('SELECT push_token, language_preference FROM users WHERE id = $1', [addressee_id])
      .then(r => {
        const addressee = r.rows[0];
        if (!addressee?.push_token) return;
        const lang = addressee.language_preference || 'vi';
        const { t: tt } = require('../../i18n');
        return sendAndSave(pool, { id: addressee_id, push_token: addressee.push_token },
          'care_circle_invitation',
          tt('push.invitation_title', lang),
          tt('push.invitation_body', lang, { name: requesterName }),
          { invitationId: String(invitation.id), senderName: requesterName });
      })
      .catch(() => {});

    return { ok: true, invitation };
  } catch (err) {
    if (err?.code === '23505') {
      return { ok: false, error: t('careCircle.connection_exists'), statusCode: 409 };
    }

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
              COALESCE(u1.display_name, u1.full_name) as requester_full_name, u1.email as requester_email, u1.phone_number as requester_phone,
              COALESCE(u2.display_name, u2.full_name) as addressee_full_name, u2.email as addressee_email, u2.phone_number as addressee_phone
       FROM user_connections uc
       LEFT JOIN users u1 ON uc.requester_id = u1.id
       LEFT JOIN users u2 ON uc.addressee_id = u2.id
       ${whereClause} ORDER BY uc.created_at DESC`,
      params
    );
    return { ok: true, invitations: result.rows };
  } catch (err) {

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock user's connections to prevent concurrent accepts exceeding limit
    const { rows: addresseeCount } = await client.query(
      `SELECT COUNT(*) FROM user_connections
       WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
       FOR UPDATE`,
      [userId]
    );
    const addresseeIsPremium = await isPremium(pool, userId);
    const addresseeLimit = addresseeIsPremium ? PREMIUM_CONNECTION_LIMIT : FREE_TIER_CONNECTION_LIMIT;
    if (Number(addresseeCount[0].count) >= addresseeLimit) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        error: addresseeIsPremium
          ? t('careCircle.premium_limit_reached', 'vi', { limit: PREMIUM_CONNECTION_LIMIT })
          : t('careCircle.upgrade_premium_accept'),
        code: 'CARE_CIRCLE_LIMIT',
        statusCode: 403,
      };
    }

    const result = await client.query(
      `UPDATE user_connections
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [invitationId, userId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: t('careCircle.invitation_not_found'), statusCode: 404 };
    }

    await client.query('COMMIT');

    // Fetch full connection with user names (same shape as getConnections)
    const fullResult = await pool.query(
      `SELECT uc.*,
              COALESCE(u1.display_name, u1.full_name) as requester_full_name, u1.email as requester_email, u1.phone_number as requester_phone,
              COALESCE(u2.display_name, u2.full_name) as addressee_full_name, u2.email as addressee_email, u2.phone_number as addressee_phone
       FROM user_connections uc
       LEFT JOIN users u1 ON uc.requester_id = u1.id
       LEFT JOIN users u2 ON uc.addressee_id = u2.id
       WHERE uc.id = $1`,
      [result.rows[0].id]
    );
    const connection = fullResult.rows[0] || result.rows[0];

    // Get accepter name for notification
    const accepterName = await getUserDisplayName(pool, userId);

    // Send push + save in-app notification (non-blocking)
    pool.query('SELECT id, push_token, language_preference FROM users WHERE id = $1', [connection.requester_id])
      .then(r => {
        const requester = r.rows[0];
        if (!requester) return;
        const lang = requester.language_preference || 'vi';
        const title = t('push.accepted_title', lang);
        const body = t('push.accepted_body', lang, { name: accepterName });
        return sendAndSave(pool, { id: requester.id, push_token: requester.push_token }, 'care_circle_accepted', title, body, {
          accepterName,
          connectionId: String(connection.id),
        });
      })
      .catch(() => {});

    return { ok: true, connection };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: t('error.server') };
  } finally {
    client.release();
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

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Cancel a pending invitation (sender only)
 * @param {Object} pool - Database pool
 * @param {number} invitationId - Invitation ID
 * @param {number} requesterId - User who originally sent the invitation
 * @returns {Promise<Object>} - { ok, error }
 */
async function cancelInvitation(pool, invitationId, requesterId) {
  try {
    const result = await pool.query(
      `DELETE FROM user_connections
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'
       RETURNING id`,
      [invitationId, requesterId]
    );

    if (result.rows.length === 0) {
      return { ok: false, error: t('careCircle.invitation_not_found'), statusCode: 404 };
    }

    return { ok: true };
  } catch (err) {
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
              COALESCE(u1.display_name, u1.full_name) as requester_full_name, u1.email as requester_email, u1.phone_number as requester_phone,
              COALESCE(u2.display_name, u2.full_name) as addressee_full_name, u2.email as addressee_email, u2.phone_number as addressee_phone
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

    await pool.query(updateQuery, values);

    // Re-fetch with user names joined
    const { rows } = await pool.query(
      `SELECT uc.*,
              COALESCE(u1.display_name, u1.full_name) as requester_full_name, u1.email as requester_email, u1.phone_number as requester_phone,
              COALESCE(u2.display_name, u2.full_name) as addressee_full_name, u2.email as addressee_email, u2.phone_number as addressee_phone
       FROM user_connections uc
       JOIN users u1 ON u1.id = uc.requester_id
       JOIN users u2 ON u2.id = uc.addressee_id
       WHERE uc.id = $1`,
      [connectionId]
    );

    return { ok: true, connection: rows[0] };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Update permissions for an existing connection
 * @param {Object} pool - Database pool
 * @param {number} connectionId - Connection ID
 * @param {number} userId - User ID (must be the requester/patient)
 * @param {Object} newPermissions - New permissions object
 * @returns {Promise<Object>} - { ok, connection, error }
 */
async function updateConnectionPermissions(pool, connectionId, userId, newPermissions) {
  const perms = normalizePermissions(newPermissions);
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET permissions = $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND (requester_id = $3 OR addressee_id = $3) AND status = 'accepted'
       RETURNING id`,
      [JSON.stringify(perms), connectionId, userId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: t('careCircle.connection_not_found'), statusCode: 404 };
    }
    // Re-fetch with user names joined
    const { rows } = await pool.query(
      `SELECT uc.*,
              COALESCE(u1.display_name, u1.full_name) as requester_full_name, u1.email as requester_email, u1.phone_number as requester_phone,
              COALESCE(u2.display_name, u2.full_name) as addressee_full_name, u2.email as addressee_email, u2.phone_number as addressee_phone
       FROM user_connections uc
       JOIN users u1 ON u1.id = uc.requester_id
       JOIN users u2 ON u2.id = uc.addressee_id
       WHERE uc.id = $1`,
      [result.rows[0].id]
    );
    return { ok: true, connection: rows[0] };
  } catch (err) {
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
  cancelInvitation,

  // Connections
  getConnections,
  deleteConnection,
  updateConnection,
  updateConnectionPermissions
};
