const checkinService = require('../services/checkin/checkin.service');
const engagementService = require('../services/profile/engagement.service');
const { markActive } = require('../services/profile/lifecycle.service');
const { t, getLang } = require('../i18n');
const { BODY_LOCATIONS, getLocationOptions, getSymptomsForLocation, getSymptomsForLocations } = require('../services/checkin/body-location');

async function startCheckinHandler(pool, req, res) {
  const { status, body_locations: bodyLocations, body_location_other: bodyLocationOther } = req.body;
  // Backward compat: nếu FE cũ gửi body_location single → wrap vào array
  let locations = bodyLocations;
  if (!locations && req.body.body_location) {
    locations = [req.body.body_location];
  }

  if (!['fine', 'tired', 'very_tired', 'specific_concern'].includes(status)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_status', getLang(req)) });
  }
  // Validate locations array (mỗi element phải nằm trong enum)
  if (locations !== undefined && locations !== null) {
    if (!Array.isArray(locations)) {
      return res.status(400).json({ ok: false, error: 'body_locations must be an array' });
    }
    const invalid = locations.find(l => !BODY_LOCATIONS.includes(l));
    if (invalid) {
      return res.status(400).json({ ok: false, error: `invalid body_location: ${invalid}` });
    }
    // Dedupe + giới hạn cứng max 7 (toàn bộ enum) để tránh array bloated
    locations = [...new Set(locations)].slice(0, 7);
  }
  // body_location_other: optional free-text, sanitize length
  let other = null;
  if (bodyLocationOther && typeof bodyLocationOther === 'string') {
    other = bodyLocationOther.trim().slice(0, 200);
    if (!other) other = null;
  }

  try {
    const session = await checkinService.startCheckin(pool, req.user.id, status, locations, other);
    // Update lifecycle → active khi user check-in
    markActive(pool, req.user.id).catch(err =>
      console.warn('[Lifecycle] markActive failed:', err.message)
    );
    return res.json({ ok: true, session });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/mobile/checkin/locations
 * Trả về list 7 body locations + symptom suggestions cho FE T2 + T3 screen.
 */
async function getLocationsHandler(pool, req, res) {
  const lang = getLang(req);
  const locations = getLocationOptions(lang).map(loc => ({
    ...loc,
    symptoms: getSymptomsForLocation(loc.key, lang),
  }));
  return res.json({ ok: true, locations });
}

async function followUpHandler(pool, req, res) {
  const { checkin_id, status } = req.body;
  if (!checkin_id || !['fine', 'tired', 'very_tired'].includes(status)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const session = await checkinService.recordFollowUp(pool, req.user.id, checkin_id, status);
    if (!session) return res.status(404).json({ ok: false, error: t('error.session_not_found', getLang(req)) });
    if (session.flow_state === 'resolved' && session.current_status !== status) {
      // Was already resolved before this call — return it as-is
      return res.json({ ok: true, session, already_resolved: true });
    }
    return res.json({ ok: true, session });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function triageHandler(pool, req, res) {
  const { checkin_id, previous_answers = [] } = req.body;
  if (!checkin_id) return res.status(400).json({ ok: false, error: t('error.missing_checkin_id', getLang(req)) });
  try {
    const result = await checkinService.processTriageStep(
      pool, req.user.id, checkin_id, previous_answers
    );
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function todayCheckinHandler(pool, req, res) {
  try {
    const { session, continuityMessage } = await checkinService.getTodayCheckin(pool, req.user.id);
    return res.json({ ok: true, session, continuityMessage });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function emergencyHandler(pool, req, res) {
  const { location } = req.body; // { lat, lng, accuracy }
  try {
    const result = await checkinService.triggerEmergency(pool, req.user.id, location);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function pendingAlertsHandler(pool, req, res) {
  try {
    const alerts = await checkinService.getPendingCaregiverAlerts(pool, req.user.id);
    return res.json({ ok: true, alerts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function confirmAlertHandler(pool, req, res) {
  const { alert_id, action } = req.body;
  if (!alert_id || !['seen', 'on_my_way', 'called'].includes(action)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const result = await checkinService.confirmCaregiverAlert(pool, req.user.id, alert_id, action);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// DEV ONLY — simulate time passing: set next_checkin_at to past so follow-up triggers immediately
async function simulateTimePassHandler(pool, req, res) {
  try {
    const session = await checkinService.simulateTimePassing(pool, req.user.id);
    if (!session) {
      return res.json({ ok: false, error: 'No active session today' });
    }
    return res.json({ ok: true, session, message: 'Time simulated — follow-up ready' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// DEV ONLY — reset today's checkin session for testing
async function resetTodayHandler(pool, req, res) {
  try {
    await checkinService.resetTodayCheckin(pool, req.user.id);
    return res.json({ ok: true, message: 'Today session reset' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function healthReportHandler(pool, req, res) {
  const period = req.query.period || 'week'; // 'week' | 'month'
  const days = period === 'month' ? 30 : 7;
  try {
    const report = await checkinService.getHealthReport(pool, req.user.id, days);
    return res.json({ ok: true, period, ...report });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/mobile/health-score
 * Get user's health score
 */
async function healthScoreHandler(pool, req, res) {
  try {
    const result = await checkinService.getHealthScore(pool, req.user.id);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/mobile/engagement/pattern
 * Get user's engagement pattern
 */
async function engagementPatternHandler(pool, req, res) {
  try {
    const pattern = await engagementService.getUserPattern(pool, req.user.id);
    return res.json({ ok: true, ...pattern });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/mobile/engagement/optimal-time
 * Get user's optimal notification time
 */
async function engagementOptimalTimeHandler(pool, req, res) {
  try {
    const times = await engagementService.getOptimalNotificationTime(pool, req.user.id);
    return res.json({ ok: true, ...times });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  startCheckinHandler,
  getLocationsHandler,
  followUpHandler,
  triageHandler,
  todayCheckinHandler,
  emergencyHandler,
  pendingAlertsHandler,
  confirmAlertHandler,
  healthReportHandler,
  resetTodayHandler,
  simulateTimePassHandler,
  healthScoreHandler,
  engagementPatternHandler,
  engagementOptimalTimeHandler,
};
