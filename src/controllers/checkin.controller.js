const checkinService = require('../services/checkin/checkin.service');
const caregiverStatusService = require('../services/care-circle/caregiver-status.service');
const engagementService = require('../services/profile/engagement.service');
const { markActive } = require('../services/profile/lifecycle.service');
const { t, getLang } = require('../i18n');
const {
  BODY_LOCATIONS,
  getLocationOptions,
  getSymptomsForLocation,
} = require('../services/checkin/body-location');

async function startCheckinHandler(pool, req, res) {
  const {
    status,
    body_locations: bodyLocations,
    body_location_other: bodyLocationOther,
  } = req.body;
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
      return res.status(400).json({
        ok: false,
        error: t('error.body_locations_array', getLang(req)),
        code: 'BODY_LOCATIONS_ARRAY_REQUIRED',
      });
    }
    const invalid = locations.find((l) => !BODY_LOCATIONS.includes(l));
    if (invalid) {
      return res.status(400).json({
        ok: false,
        error: t('error.invalid_body_location', getLang(req), { location: invalid }),
        code: 'INVALID_BODY_LOCATION',
      });
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
    // Update lifecycle before responding so a re-engagement cron cannot read
    // the old inactive/999-day state after the user has checked in.
    await markActive(pool, req.user.id).catch((err) =>
      console.warn('[Lifecycle] markActive failed:', err.message)
    );
    return res.json({ ok: true, session });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

/**
 * GET /api/mobile/checkin/locations
 * Trả về list 7 body locations + symptom suggestions cho FE T2 + T3 screen.
 */
async function getLocationsHandler(pool, req, res) {
  const lang = getLang(req);
  const locations = getLocationOptions(lang).map((loc) => ({
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
    if (!session)
      return res.status(404).json({ ok: false, error: t('error.session_not_found', getLang(req)) });
    if (session.flow_state === 'resolved' && session.current_status !== status) {
      // Was already resolved before this call — return it as-is
      return res.json({ ok: true, session, already_resolved: true });
    }
    return res.json({ ok: true, session });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function triageHandler(pool, req, res) {
  const { checkin_id, previous_answers = [] } = req.body;
  if (!checkin_id)
    return res.status(400).json({ ok: false, error: t('error.missing_checkin_id', getLang(req)) });
  const validAnswers =
    Array.isArray(previous_answers) &&
    previous_answers.length <= 8 &&
    previous_answers.every(
      (item) =>
        item &&
        typeof item.question === 'string' &&
        item.question.trim().length > 0 &&
        item.question.length <= 500 &&
        ((typeof item.answer === 'string' && item.answer.length <= 2000) ||
          (Array.isArray(item.answer) &&
            item.answer.length <= 20 &&
            item.answer.every((answer) => typeof answer === 'string' && answer.length <= 500)))
    );
  if (!validAnswers) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const result = await checkinService.processTriageStep(
      pool,
      req.user.id,
      checkin_id,
      previous_answers
    );
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'SESSION_NOT_FOUND') {
      return res
        .status(404)
        .json({ ok: false, code: err.code, error: t('error.session_not_found', getLang(req)) });
    }
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function todayCheckinHandler(pool, req, res) {
  try {
    const { session, continuityMessage } = await checkinService.getTodayCheckin(pool, req.user.id);
    return res.json({ ok: true, session, continuityMessage });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function emergencyHandler(pool, req, res) {
  const { location } = req.body; // { lat, lng, accuracy }
  const validLocation =
    location === undefined ||
    location === null ||
    (typeof location === 'object' &&
      !Array.isArray(location) &&
      Number.isFinite(location.lat) &&
      location.lat >= -90 &&
      location.lat <= 90 &&
      Number.isFinite(location.lng) &&
      location.lng >= -180 &&
      location.lng <= 180 &&
      (location.accuracy === undefined ||
        (Number.isFinite(location.accuracy) && location.accuracy >= 0)));
  if (!validLocation) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const result = await checkinService.triggerEmergency(pool, req.user.id, location);
    // Emergency is always urgent — tell the client whether anyone is on
    // the other end to receive the alert (MVP audit FIX #4).
    const caregiverStatus = await caregiverStatusService.buildCaregiverStatus(pool, req.user.id, {
      riskTier: 'emergency',
    });
    return res.json({ ...result, ...caregiverStatus });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function pendingAlertsHandler(pool, req, res) {
  try {
    const alerts = await checkinService.getPendingCaregiverAlerts(pool, req.user.id);
    return res.json({ ok: true, alerts });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function confirmAlertHandler(pool, req, res) {
  const { alert_id, action } = req.body;
  if (!alert_id || !['seen', 'on_my_way', 'called'].includes(action)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const result = await checkinService.confirmCaregiverAlert(pool, req.user.id, alert_id, action);
    if (!result.ok) {
      return res.status(result.code === 'FORBIDDEN' ? 403 : 404).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

// DEV ONLY — simulate time passing: set next_checkin_at to past so follow-up triggers immediately
async function simulateTimePassHandler(pool, req, res) {
  try {
    const session = await checkinService.simulateTimePassing(pool, req.user.id);
    if (!session) {
      return res.json({
        ok: false,
        error: t('error.no_active_checkin', getLang(req)),
        code: 'NO_ACTIVE_CHECKIN',
      });
    }
    return res.json({ ok: true, session, message: t('error.followup_ready', getLang(req)) });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

// DEV ONLY — reset today's checkin session for testing
async function resetTodayHandler(pool, req, res) {
  try {
    await checkinService.resetTodayCheckin(pool, req.user.id);
    return res.json({ ok: true, message: 'Today session reset' });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function healthReportHandler(pool, req, res) {
  const period = req.query.period || 'week'; // 'week' | 'month'
  if (!['week', 'month'].includes(period)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  const days = period === 'month' ? 30 : 7;
  try {
    const report = await checkinService.getHealthReport(pool, req.user.id, days);
    return res.json({ ok: true, period, ...report });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
    return res
      .status(500)
      .json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
