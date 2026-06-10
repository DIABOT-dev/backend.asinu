/**
 * CareCircle Controller
 * HTTP handlers for care circle endpoints
 */

const { t, getLang } = require('../i18n');
const { careCircleInvitationSchema } = require('../validation/validation.schemas');
const checkinService = require('../services/checkin/checkin.service');
const treeService = require('../services/tree/tree.service');
const mobileService = require('../services/profile/mobile.service');
const { getMissions } = require('../services/missions/missions.service');
const {
  createInvitation: serviceCreateInvitation,
  getInvitations: serviceGetInvitations,
  acceptInvitation: serviceAcceptInvitation,
  rejectInvitation: serviceRejectInvitation,
  cancelInvitation: serviceCancelInvitation,
  getConnections: serviceGetConnections,
  deleteConnection: serviceDeleteConnection,
  updateConnection: serviceUpdateConnection,
  updateConnectionPermissions: serviceUpdateConnectionPermissions,
  verifyCaregiverAccess,
  getCaregiverLogs: serviceGetCaregiverLogs,
  getCaregiverCheckins: serviceGetCaregiverCheckins,
  getPatientName,
} = require('../services/care-circle/careCircle.service');

const dayLabel = (date) => date.toLocaleDateString('vi-VN', { weekday: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

function getLogDetail(log) {
  return log?.detail || log?.metadata || {};
}

function buildQuickMetrics(logs) {
  const latest = (types) => logs.find((log) => types.includes(log.log_type));
  const glucose = latest(['glucose']);
  const bp = latest(['bp', 'blood_pressure']);
  const weight = latest(['weight']);
  const water = latest(['water']);

  const glucoseDetail = getLogDetail(glucose);
  const bpDetail = getLogDetail(bp);
  const weightDetail = getLogDetail(weight);
  const waterDetail = getLogDetail(water);

  return {
    glucose: glucoseDetail.value ?? null,
    bloodPressure: bpDetail.systolic && bpDetail.diastolic ? `${bpDetail.systolic}/${bpDetail.diastolic}` : null,
    weight: weightDetail.weight_kg ?? weightDetail.value ?? null,
    water: waterDetail.volume_ml ?? waterDetail.amount_ml ?? null,
  };
}

function buildGlucoseTrendData(logs) {
  const today = new Date();
  return Array.from({ length: 7 }, (_, idx) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (6 - idx));
    const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const log = logs.find((item) => {
      if (item.log_type !== 'glucose') return false;
      const occurred = new Date(item.occurred_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      return occurred === dateKey;
    });
    return {
      label: dayLabel(d),
      value: Number(getLogDetail(log).value || 0),
    };
  });
}

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

/**
 * DELETE /api/care-circle/invitations/:id
 * Cancel a sent invitation (sender only)
 */
async function cancelInvitation(pool, req, res) {
  const invitationId = req.params.id;
  const result = await serviceCancelInvitation(pool, invitationId, req.user.id);
  if (!result.ok) {
    return res.status(result.statusCode || 400).json({ ok: false, error: result.error });
  }
  return res.status(200).json({ ok: true });
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
    const hasAccess = await verifyCaregiverAccess(pool, caregiverId, patientId);
    if (!hasAccess) {
      return res.status(403).json({ ok: false, error: 'No permission to view logs' });
    }

    const logs = await serviceGetCaregiverLogs(pool, patientId, 7);
    const patientName = await getPatientName(pool, patientId) || 'Patient';

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
    const hasAccess = await verifyCaregiverAccess(pool, caregiverId, patientId);
    if (!hasAccess) {
      return res.status(403).json({ ok: false, error: 'No permission to view logs' });
    }

    const sessions = await serviceGetCaregiverCheckins(pool, patientId, 14);
    const patientName = await getPatientName(pool, patientId);

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

  // Verify caregiver has access and can_view_logs permission
  const hasAccess = await verifyCaregiverAccess(pool, caregiverId, memberId);
  if (!hasAccess) {
    return res.status(403).json({ ok: false, error: 'Không có quyền truy cập' });
  }

  try {
    const [
      reportResult,
      healthScoreResult,
      treeSummaryResult,
      treeHistoryResult,
      logsResult,
      checkinsResult,
      missionsResult,
      patientNameResult,
    ] = await Promise.allSettled([
      checkinService.getHealthReport(pool, memberId, 7),
      checkinService.getHealthScore(pool, memberId),
      treeService.getTreeSummary(pool, memberId),
      treeService.getTreeHistory(pool, memberId),
      mobileService.getRecentLogs(pool, memberId, { limit: 20 }),
      serviceGetCaregiverCheckins(pool, memberId, 14),
      getMissions(pool, memberId),
      getPatientName(pool, memberId),
    ]);

    const report = reportResult.status === 'fulfilled' ? reportResult.value : null;
    const healthScore = healthScoreResult.status === 'fulfilled' ? healthScoreResult.value : null;
    const treeSummary = treeSummaryResult.status === 'fulfilled' ? treeSummaryResult.value : null;
    const treeHistoryPayload = treeHistoryResult.status === 'fulfilled' ? treeHistoryResult.value : null;
    const logsPayload = logsResult.status === 'fulfilled' && logsResult.value?.ok ? logsResult.value.logs : [];
    const checkins = checkinsResult.status === 'fulfilled' ? checkinsResult.value : [];
    const missions = missionsResult.status === 'fulfilled' ? missionsResult.value : [];
    const patientName = patientNameResult.status === 'fulfilled' ? patientNameResult.value : null;

    const recentCheckin = Array.isArray(checkins) && checkins.length > 0 ? checkins[0] : null;
    const alerts = [];
    if (recentCheckin?.emergency_triggered || recentCheckin?.triage_severity === 'high') {
      alerts.push({
        id: `checkin-${recentCheckin.id}`,
        severity: 'high',
        title: 'Cảnh báo sức khỏe',
        message: recentCheckin.triage_summary || 'Có dấu hiệu cần người thân theo dõi.',
        created_at: recentCheckin.created_at,
      });
    } else if (recentCheckin?.triage_severity === 'medium') {
      alerts.push({
        id: `checkin-${recentCheckin.id}`,
        severity: 'medium',
        title: 'Cần theo dõi',
        message: recentCheckin.triage_summary || 'Tình trạng gần đây cần được theo dõi thêm.',
        created_at: recentCheckin.created_at,
      });
    }

    return res.json({
      ok: true,
      patientName: patientName || 'Patient',
      permission: {
        can_view_logs: true,
        can_receive_alerts: true,
        can_ack_escalation: true,
      },
      healthScore,
      quickMetrics: buildQuickMetrics(logsPayload),
      treeSummary,
      treeHistory: treeHistoryPayload?.history || [],
      glucoseTrendData: buildGlucoseTrendData(logsPayload),
      recentLogs: logsPayload.slice(0, 5),
      recentCheckin,
      missions: missions.slice(0, 4),
      alerts,
      report: report ? {
        ...report,
        recentSessions: report.sessions?.slice(0, 5) || [],
      } : null,
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
  cancelInvitation,
  getConnections,
  deleteConnection,
  updateConnection,
  updateConnectionPermissions,
  getCaregiverLogs,
  getCaregiverCheckins,
  getMemberHealthSummary,
};
