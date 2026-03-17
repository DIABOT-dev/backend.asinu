const checkinService = require('../services/checkin.service');
const { t, getLang } = require('../i18n');

async function startCheckinHandler(pool, req, res) {
  const { status } = req.body;
  if (!['fine', 'tired', 'very_tired', 'specific_concern'].includes(status)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_status', getLang(req)) });
  }
  try {
    const session = await checkinService.startCheckin(pool, req.user.id, status);
    return res.json({ ok: true, session });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function followUpHandler(pool, req, res) {
  const { checkin_id, status } = req.body;
  if (!checkin_id || !['fine', 'tired', 'very_tired'].includes(status)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  try {
    const session = await checkinService.recordFollowUp(pool, req.user.id, checkin_id, status);
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

// DEV ONLY — reset today's checkin session for testing
async function resetTodayHandler(pool, req, res) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await pool.query(
      `DELETE FROM health_checkins WHERE user_id = $1 AND session_date = $2`,
      [req.user.id, today]
    );
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

module.exports = {
  startCheckinHandler,
  followUpHandler,
  triageHandler,
  todayCheckinHandler,
  emergencyHandler,
  pendingAlertsHandler,
  confirmAlertHandler,
  healthReportHandler,
  resetTodayHandler,
};
