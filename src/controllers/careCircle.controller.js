const { careCircleInvitationSchema } = require('../validation/validation.schemas');

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
  if (req.body?.user_id && Number(req.body.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'User mismatch' });
  }

  const parsed = careCircleInvitationSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  const { addressee_id, relationship_type, role, permissions } = parsed.data;
  if (Number(addressee_id) === Number(req.user.id)) {
    return res.status(400).json({ ok: false, error: 'Cannot invite yourself' });
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

    return res.status(200).json({ ok: true, invitation: result.rows[0] });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Connection already exists' });
    }
    console.error('create invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      `SELECT * FROM user_connections ${whereClause} ORDER BY created_at DESC`,
      params
    );
    return res.status(200).json({ ok: true, invitations: result.rows });
  } catch (err) {
    console.error('get invitations failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      return res.status(404).json({ ok: false, error: 'Invitation not found' });
    }

    return res.status(200).json({ ok: true, connection: result.rows[0] });
  } catch (err) {
    console.error('accept invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      return res.status(404).json({ ok: false, error: 'Invitation not found' });
    }

    return res.status(200).json({ ok: true, invitation: result.rows[0] });
  } catch (err) {
    console.error('reject invitation failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function getConnections(pool, req, res) {
  try {
    const result = await pool.query(
      `SELECT * FROM user_connections
       WHERE status = 'accepted'
         AND (requester_id = $1 OR addressee_id = $1)
       ORDER BY updated_at DESC`,
      [req.user.id]
    );
    return res.status(200).json({ ok: true, connections: result.rows });
  } catch (err) {
    console.error('get connections failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
      return res.status(404).json({ ok: false, error: 'Connection not found' });
    }

    return res.status(200).json({ ok: true, connection: result.rows[0] });
  } catch (err) {
    console.error('delete connection failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
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
