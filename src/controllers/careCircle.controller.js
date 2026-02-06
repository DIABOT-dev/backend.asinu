/**
 * CareCircle Controller
 * HTTP handlers for care circle endpoints
 */

const { careCircleInvitationSchema } = require('../validation/validation.schemas');
const {
  createInvitation: serviceCreateInvitation,
  getInvitations: serviceGetInvitations,
  acceptInvitation: serviceAcceptInvitation,
  rejectInvitation: serviceRejectInvitation,
  getConnections: serviceGetConnections,
  deleteConnection: serviceDeleteConnection,
  updateConnection: serviceUpdateConnection
} = require('../services/careCircle.service');

// =====================================================
// INVITATION HANDLERS
// =====================================================

/**
 * POST /api/care-circle/invitations
 * Create a new invitation
 */
async function createInvitation(pool, req, res) {
  // Validate user_id matches
  if (req.body?.user_id && Number(req.body.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'ID người dùng không khớp' });
  }

  // Validate request body
  const parsed = careCircleInvitationSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ', details: parsed.error.issues });
  }

  // Call service
  const result = await serviceCreateInvitation(pool, req.user.id, parsed.data);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, invitation: result.invitation });
}

/**
 * GET /api/care-circle/invitations
 * Get invitations (sent/received/all)
 */
async function getInvitations(pool, req, res) {
  const direction = String(req.query.direction || '').toLowerCase();

  const result = await serviceGetInvitations(pool, req.user.id, direction);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json({ ok: true, invitations: result.invitations });
}

/**
 * POST /api/care-circle/invitations/:id/accept
 * Accept an invitation
 */
async function acceptInvitation(pool, req, res) {
  const invitationId = req.params.id;

  const result = await serviceAcceptInvitation(pool, invitationId, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, connection: result.connection });
}

/**
 * POST /api/care-circle/invitations/:id/reject
 * Reject an invitation
 */
async function rejectInvitation(pool, req, res) {
  const invitationId = req.params.id;

  const result = await serviceRejectInvitation(pool, invitationId, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, invitation: result.invitation });
}

// =====================================================
// CONNECTION HANDLERS
// =====================================================

/**
 * GET /api/care-circle/connections
 * Get all accepted connections
 */
async function getConnections(pool, req, res) {
  const result = await serviceGetConnections(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json({ ok: true, connections: result.connections });
}

/**
 * DELETE /api/care-circle/connections/:id
 * Remove a connection
 */
async function deleteConnection(pool, req, res) {
  const connectionId = req.params.id;

  const result = await serviceDeleteConnection(pool, connectionId, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, connection: result.connection });
}

/**
 * PATCH /api/care-circle/connections/:id
 * Update a connection
 */
async function updateConnection(pool, req, res) {
  const connectionId = req.params.id;

  const result = await serviceUpdateConnection(pool, connectionId, req.user.id, req.body);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, connection: result.connection });
}

module.exports = {
  createInvitation,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  getConnections,
  deleteConnection,
  updateConnection
};
