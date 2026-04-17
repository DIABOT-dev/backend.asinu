/**
 * Notification Controller
 * HTTP handlers for notification endpoints
 */

const { NOTIF_MAP } = require('../constants');
const notificationService = require('../services/notification/notification.service');
const { runEngagementNotifications, previewEngagementNotification } = require('../services/notification/engagement.notification.service');
const { runBasicNotifications } = require('../services/notification/basic.notification.service');
const { getPreferences, updatePreferences } = require('../services/notification/smart.schedule.service');
const { t, getLang } = require('../i18n');

/**
 * POST /api/mobile/test-notification
 * DEV — Send a test push notification
 */
async function testNotificationHandler(pool, req, res) {
  const { sendPushNotification } = require('../services/notification/push.notification.service');
  const { type } = req.body;
  if (!type) return res.status(400).json({ ok: false, error: 'type required' });

  try {
    const token = await notificationService.getUserPushToken(pool, req.user.id);
    if (!token) return res.json({ ok: false, error: 'No push_token saved for this user' });

    const notif = NOTIF_MAP[type];
    if (!notif) return res.status(400).json({ ok: false, error: `Unknown type: ${type}` });

    const result = await sendPushNotification(
      [token], notif.title, notif.body, { type }
    );

    // Also save to in-app notifications
    await notificationService.saveInAppNotification(pool, req.user.id, type, notif.title, notif.body, { type, test: true });

    return res.json({ ok: true, type, title: notif.title, body: notif.body, pushResult: result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/notifications
 * Get notifications for user
 */
async function getNotifications(pool, req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const result = await notificationService.getNotifications(pool, req.user.id, { page, limit });

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

/**
 * PUT /api/notifications/:id/read
 * Mark notification as read
 */
async function markAsRead(pool, req, res) {
  const notificationId = parseInt(req.params.id);

  if (isNaN(notificationId)) {
    return res.status(400).json({
      ok: false,
      error: t('error.invalid_notification_id', getLang(req))
    });
  }

  const result = await notificationService.markAsRead(pool, notificationId, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 500;
    return res.status(statusCode).json(result);
  }

  return res.status(200).json(result);
}

/**
 * PUT /api/notifications/mark-all-read
 * Mark all notifications as read
 */
async function markAllAsRead(pool, req, res) {
  const result = await notificationService.markAllAsRead(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

/**
 * GET /api/notifications/preferences
 * Get user notification preferences
 */
async function getNotificationPreferences(pool, req, res) {
  try {
    const prefs = await getPreferences(pool, req.user.id);
    return res.status(200).json({ ok: true, ...prefs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * PUT /api/notifications/preferences
 * Update notification preferences
 */
async function updateNotificationPreferences(pool, req, res) {
  const { morning_hour, evening_hour, water_hour, reminders_enabled,
          morning_time, afternoon_time, evening_time } = req.body;

  const inRange = (v, min, max) => v === null || v === undefined || (Number.isInteger(v) && v >= min && v <= max);
  const validTime = (v) => v === null || v === undefined || /^\d{2}:\d{2}$/.test(v);
  if (!inRange(morning_hour, 5, 11) || !inRange(evening_hour, 17, 23) || !inRange(water_hour, 10, 18)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  if (!validTime(morning_time) || !validTime(afternoon_time) || !validTime(evening_time)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }

  try {
    await updatePreferences(pool, req.user.id, {
      morning_hour: morning_hour ?? null,
      evening_hour: evening_hour ?? null,
      water_hour:   water_hour   ?? null,
      morning_time, afternoon_time, evening_time,
      reminders_enabled: reminders_enabled !== undefined ? Boolean(reminders_enabled) : undefined,
    });
    const prefs = await getPreferences(pool, req.user.id);
    return res.status(200).json({ ok: true, ...prefs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /api/notifications/engagement/preview
 * Preview engagement notification for current user (no actual push)
 */
async function previewEngagement(pool, req, res) {
  try {
    const result = await previewEngagementNotification(pool, req.user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

let _basicRunning = false;
let _engagementRunning = false;

/**
 * POST /api/notifications/engagement/run
 * Run AI-driven engagement notifications for inactive users (cron)
 */
async function runEngagement(pool, req, res) {
  if (_engagementRunning) return res.status(429).json({ error: 'Engagement cron already running' });
  _engagementRunning = true;
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
    }

    const result = await runEngagementNotifications(pool);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    _engagementRunning = false;
  }
}

/**
 * POST /api/notifications/basic/run
 * Run basic scheduled notifications (cron)
 */
async function runBasic(pool, req, res) {
  if (_basicRunning) return res.status(429).json({ error: 'Basic cron already running' });
  _basicRunning = true;
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
    }

    const forceHour   = req.body?.hour   !== undefined ? Number(req.body.hour)   : null;
    const forceMinute = req.body?.minute !== undefined ? Number(req.body.minute) : null;
    const result = await runBasicNotifications(pool, forceHour, forceMinute);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    _basicRunning = false;
  }
}

async function deleteOne(pool, req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: 'Invalid ID' });
    const result = await notificationService.deleteNotification(pool, id, req.user.id);
    if (!result.deleted) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function deleteAll(pool, req, res) {
  try {
    await notificationService.deleteAllNotifications(pool, req.user.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  testNotificationHandler,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteOne,
  deleteAll,
  getNotificationPreferences,
  updateNotificationPreferences,
  previewEngagement,
  runEngagement,
  runBasic,
};
