/**
 * Health Controller
 * HTTP handlers for health alert endpoints
 */

const { t, getLang } = require('../i18n');
const { getActiveConnections, getUserName, insertAlertNotifications } = require('../services/health/health-alert.service');

/**
 * POST /api/health/alert-care-circle
 * Send health alert to all care-circle members
 */
async function alertCareCircle(pool, req, res) {
  const userId = req.user.id; // lấy từ token, không tin body
  const { alertData } = req.body;

  try {
    const connections = await getActiveConnections(pool, userId);

    if (connections.length === 0) {
      return res.status(200).json({
        ok: true,
        message: t('careCircle.no_care_circle', getLang(req)),
        notified: 0
      });
    }

    const userName = await getUserName(pool, userId);

    const notificationTemplate = {
      type: 'health_alert',
      title: t('health.alert_from_user', getLang(req), { name: userName }),
      message: alertData.message,
      data: {
        type: 'health_alert',
        alertType: alertData.alertType,
        severity: alertData.severity,
        icon: alertData.icon || (alertData.severity === 'critical' ? 'alert-circle' : 'warning'),
        sourceUserId: userId,
        sourceUserName: userName,
        ...alertData
      },
    };

    await insertAlertNotifications(pool, connections, notificationTemplate);

    return res.status(200).json({
      ok: true,
      message: t('health.alert_sent_count', getLang(req), { count: connections.length }),
      notified: connections.length,
      alertType: alertData.alertType,
      severity: alertData.severity
    });

  } catch (error) {

    return res.status(500).json({
      ok: false,
      error: t('health.alert_send_error', getLang(req))
    });
  }
}

/**
 * POST /api/health/monitor/daily
 * Chạy daily health monitoring cho tất cả users (cronjob)
 */
async function runDailyMonitor(pool, req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
  }
  try {
    const { runDailyHealthMonitoring } = require('../services/health/health.monitoring.service');
    const result = await runDailyHealthMonitoring(pool);
    return res.status(200).json({ ok: true, message: t('health.daily_check_complete', getLang(req)), ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: t('health.daily_check_error', getLang(req)) });
  }
}

/**
 * POST /api/health/monitor/user/:userId
 * Chạy health monitoring cho user cụ thể
 */
async function runUserMonitor(pool, req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
  }
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ ok: false, error: t('error.invalid_user_id', getLang(req)) });
    }
    const { runHealthMonitoringForUser } = require('../services/health/health.monitoring.service');
    await runHealthMonitoringForUser(pool, userId);
    return res.status(200).json({ ok: true, message: t('health.user_check_complete', getLang(req), { userId }) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: t('health.user_check_error', getLang(req)) });
  }
}

module.exports = { alertCareCircle, runDailyMonitor, runUserMonitor };
