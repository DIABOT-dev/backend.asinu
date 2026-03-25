/**
 * CareCircle Controller
 * HTTP handlers for care circle endpoints
 */

const { t, getLang } = require('../i18n');
const { careCircleInvitationSchema } = require('../validation/validation.schemas');
const checkinService = require('../services/checkin/checkin.service');
const {
  createInvitation: serviceCreateInvitation,
  getInvitations: serviceGetInvitations,
  acceptInvitation: serviceAcceptInvitation,
  rejectInvitation: serviceRejectInvitation,
  getConnections: serviceGetConnections,
  deleteConnection: serviceDeleteConnection,
  updateConnection: serviceUpdateConnection,
  updateConnectionPermissions: serviceUpdateConnectionPermissions
} = require('../services/care-circle/careCircle.service');

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
    return res.status(403).json({ ok: false, error: t('error.user_id_mismatch', getLang(req)) });
  }

  // Validate request body
  const parsed = careCircleInvitationSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)), details: parsed.error.issues });
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

/**
 * PUT /api/care-circle/connections/:id/permissions
 * Update permissions for a connection
 */
async function updateConnectionPermissions(pool, req, res) {
  const connectionId = req.params.id;
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
  }
  const result = await serviceUpdateConnectionPermissions(pool, connectionId, req.user.id, permissions);
  if (!result.ok) {
    return res.status(result.statusCode || 400).json({ ok: false, error: result.error });
  }
  return res.json({ ok: true, connection: result.connection });
}

/**
 * GET /api/mobile/caregiver/logs/:patientId
 * Caregiver view patient logs (requires can_view_logs permission)
 */
async function getCaregiverLogs(pool, req, res) {
  const caregiverId = req.user.id;
  const patientId = parseInt(req.params.patientId);
  if (!patientId) return res.status(400).json({ ok: false, error: 'Invalid patient ID' });

  try {
    // Check connection exists and has can_view_logs permission
    const { rows: connRows } = await pool.query(
      `SELECT id, permissions FROM user_connections
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND COALESCE((permissions->>'can_view_logs')::boolean, false) = true`,
      [patientId, caregiverId]
    );
    if (connRows.length === 0) {
      return res.status(403).json({ ok: false, error: 'No permission to view logs' });
    }

    // Fetch patient's recent logs (last 7 days, max 50)
    const { rows: logs } = await pool.query(
      `SELECT lc.id, lc.log_type, lc.occurred_at, lc.note, lc.metadata
       FROM logs_common lc
       WHERE lc.user_id = $1 AND lc.occurred_at > NOW() - INTERVAL '7 days'
       ORDER BY lc.occurred_at DESC
       LIMIT 50`,
      [patientId]
    );

    // Get patient name
    const { rows: patientRows } = await pool.query(
      `SELECT display_name, full_name FROM users WHERE id = $1`,
      [patientId]
    );
    const patientName = patientRows[0]?.display_name || patientRows[0]?.full_name || 'Patient';

    return res.json({ ok: true, patientName, logs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

/**
 * GET /api/mobile/caregiver/checkins/:patientId
 * Caregiver view patient's check-in history (requires can_view_logs permission)
 */
async function getCaregiverCheckins(pool, req, res) {
  const caregiverId = req.user.id;
  const patientId = parseInt(req.params.patientId);
  if (!patientId) return res.status(400).json({ ok: false, error: 'Invalid patient ID' });

  try {
    // Check connection exists and has can_view_logs permission
    const { rows: connRows } = await pool.query(
      `SELECT id FROM user_connections
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND COALESCE((permissions->>'can_view_logs')::boolean, false) = true`,
      [patientId, caregiverId]
    );
    if (connRows.length === 0) {
      return res.status(403).json({ ok: false, error: 'No permission to view logs' });
    }

    // Fetch patient's check-in sessions (last 14 days)
    const { rows: sessions } = await pool.query(
      `SELECT id, session_date, initial_status, current_status, flow_state,
              triage_summary, triage_severity, family_alerted, emergency_triggered,
              resolved_at, created_at
       FROM health_checkins
       WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '14 days'
       ORDER BY session_date DESC`,
      [patientId]
    );

    // Get patient name
    const { rows: patientRows } = await pool.query(
      `SELECT display_name, full_name FROM users WHERE id = $1`,
      [patientId]
    );
    const patientName = patientRows[0]?.display_name || patientRows[0]?.full_name || '';

    return res.json({ ok: true, patientName, sessions });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

/**
 * GET /api/mobile/care-circle/member/:memberId/health-summary
 * Care Circle Dashboard — caregiver views member's health summary
 */
async function getMemberHealthSummary(pool, req, res) {
  const caregiverId = req.user.id;
  const memberId = parseInt(req.params.memberId);

  // Verify caregiver has access to this member
  const accessCheck = await pool.query(
    `SELECT id FROM user_connections
     WHERE ((requester_id = $2 AND addressee_id = $1) OR (requester_id = $1 AND addressee_id = $2))
       AND status = 'accepted'`,
    [caregiverId, memberId]
  );

  if (accessCheck.rows.length === 0) {
    return res.status(403).json({ ok: false, error: 'Không có quyền truy cập' });
  }

  try {
    // Get member's health summary (last 7 days)
    const report = await checkinService.getHealthReport(pool, memberId, 7);
    const healthScore = await checkinService.getHealthScore(pool, memberId);

    return res.json({
      ok: true,
      healthScore,
      report: {
        checkinDays: report.checkinDays,
        totalDays: report.totalDays,
        trend: report.trend,
        severityDistribution: report.severityDistribution,
        responseRate: report.responseRate || 0,
        recentSessions: report.sessions?.slice(0, 5) || [],
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  createInvitation,
  getInvitations,
  acceptInvitation,
  rejectInvitation,
  getConnections,
  deleteConnection,
  updateConnection,
  updateConnectionPermissions,
  getCaregiverLogs,
  getCaregiverCheckins,
  getMemberHealthSummary,
};
