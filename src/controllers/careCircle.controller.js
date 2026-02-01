const { careCircleInvitationSchema } = require('../validation/validation.schemas');
const { notifyCareCircleInvitation, notifyCareCircleAccepted } = require('../services/push.notification.service');

const DEFAULT_PERMISSIONS = {
  can_view_logs: false,
  can_receive_alerts: false,
  can_ack_escalation: false
};

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

async function createInvitation(pool, req, res) {
  console.log('[care-circle] POST /invitations req.body:', JSON.stringify(req.body, null, 2));
  console.log('[care-circle] req.user.id:', req.user.id);
  
  if (req.body?.user_id && Number(req.body.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'ID người dùng không khớp' });
  }

  const parsed = careCircleInvitationSchema.safeParse(req.body || {});
  console.log('[care-circle] Validation result:', JSON.stringify(parsed, null, 2));
  
  if (!parsed.success) {
    console.log('[care-circle] Validation errors:', parsed.error.issues);
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ', details: parsed.error.issues });
  }

  const { addressee_id, relationship_type, role, permissions } = parsed.data;
  console.log('[care-circle] Parsed data - addressee_id:', addressee_id, 'type:', typeof addressee_id);
  
  if (addressee_id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'Không thể mời chính mình' });
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
      [req.user.id, addressee_id, relationship_type || null, role || null, JSON.stringify(perms)]
    );

    const invitation = result.rows[0];

    // Get requester name for notification
    const requesterResult = await pool.query(
      'SELECT display_name, full_name, email FROM users WHERE id = $1',
      [req.user.id]
    );
    const requesterName = requesterResult.rows[0]?.display_name 
      || requesterResult.rows[0]?.full_name 
      || requesterResult.rows[0]?.email 
      || 'Người dùng';

    // Send push notification to addressee
    notifyCareCircleInvitation(pool, addressee_id, requesterName, invitation.id)
      .catch(err => console.error('[careCircle] Failed to send notification:', err));

    return res.status(200).json({ ok: true, invitation });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Kết nối đã tồn tại' });
    }
    console.error('create invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getInvitations(pool, req, res) {
  const direction = String(req.query.direction || '').toLowerCase();
  const conditions = [];
  const params = [];

  if (direction === 'sent') {
    params.push(req.user.id);
    conditions.push(`requester_id = $${params.length}`);
  } else if (direction === 'received') {
    params.push(req.user.id);
    conditions.push(`addressee_id = $${params.length}`);
  } else {
    params.push(req.user.id);
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
    return res.status(200).json({ ok: true, invitations: result.rows });
  } catch (err) {
    console.error('get invitations failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function acceptInvitation(pool, req, res) {
  const invitationId = req.params.id;
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [invitationId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy lời mời' });
    }

    const connection = result.rows[0];

    // Get accepter name for notification
    const accepterResult = await pool.query(
      'SELECT display_name, full_name, email FROM users WHERE id = $1',
      [req.user.id]
    );
    const accepterName = accepterResult.rows[0]?.display_name 
      || accepterResult.rows[0]?.full_name 
      || accepterResult.rows[0]?.email 
      || 'Người dùng';

    // Send push notification to requester
    notifyCareCircleAccepted(pool, connection.requester_id, accepterName)
      .catch(err => console.error('[careCircle] Failed to send acceptance notification:', err));

    return res.status(200).json({ ok: true, connection });
  } catch (err) {
    console.error('accept invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function rejectInvitation(pool, req, res) {
  const invitationId = req.params.id;
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [invitationId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy lời mời' });
    }

    return res.status(200).json({ ok: true, invitation: result.rows[0] });
  } catch (err) {
    console.error('reject invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getConnections(pool, req, res) {
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
      [req.user.id]
    );
    return res.status(200).json({ ok: true, connections: result.rows });
  } catch (err) {
    console.error('get connections failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function deleteConnection(pool, req, res) {
  const connectionId = req.params.id;
  try {
    const result = await pool.query(
      `UPDATE user_connections
       SET status = 'removed', updated_at = NOW()
       WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)
       RETURNING *`,
      [connectionId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy kết nối' });
    }

    return res.status(200).json({ ok: true, connection: result.rows[0] });
  } catch (err) {
    console.error('delete connection failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

module.exports = {
  createInvitation,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  getConnections,
  deleteConnection
};
