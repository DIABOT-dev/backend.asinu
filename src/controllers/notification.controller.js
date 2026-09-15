/**
 * Notification Controller
 * HTTP handlers for notification endpoints
 */

const { NOTIF_MAP } = require('../constants');
const notificationService = require('../services/notification/notification.service');
const {
  runEngagementNotifications,
  previewEngagementNotification,
} = require('../services/notification/engagement.notification.service');
const { runBasicNotifications } = require('../services/notification/basic.notification.service');
const {
  getPreferences,
  updatePreferences,
} = require('../services/notification/smart.schedule.service');
const { t, getLang } = require('../i18n');

/**
 * POST /api/mobile/test-notification
 * DEV — Send a test push notification
 */
async function testNotificationHandler(pool, req, res) {
  const { sendPushNotification } = require('../services/notification/push.notification.service');
  const { type } = req.body;
  if (!type) {
    return res.status(400).json({
      ok: false,
      error: t('notification.type_required', getLang(req)),
      code: 'NOTIFICATION_TYPE_REQUIRED',
    });
  }

  try {
    const token = await notificationService.getUserPushToken(pool, req.user.id);
    if (!token) {
      return res.json({
        ok: false,
        error: t('notification.push_token_missing', getLang(req)),
        code: 'PUSH_TOKEN_MISSING',
      });
    }

    const notif = NOTIF_MAP[type];
    if (!notif) {
      return res.status(400).json({
        ok: false,
        error: t('notification.unknown_type', getLang(req), { type }),
        code: 'UNKNOWN_NOTIFICATION_TYPE',
      });
    }

    const result = await sendPushNotification([token], notif.title, notif.body, { type });

    // Also save to in-app notifications
    await notificationService.saveInAppNotification(
      pool,
      req.user.id,
      type,
      notif.title,
      notif.body,
      { type, test: true }
    );

    return res.json({ ok: true, type, title: notif.title, body: notif.body, pushResult: result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
    return res.status(500).json({
      ...result,
      error: t('notification.cannot_get_list', getLang(req)),
      code: 'NOTIFICATIONS_LIST_FAILED',
    });
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
      error: t('error.invalid_notification_id', getLang(req)),
    });
  }

  const result = await notificationService.markAsRead(pool, notificationId, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 500;
    return res.status(statusCode).json({
      ...result,
      error: t(result.statusCode === 404 ? 'notification.not_found' : 'notification.cannot_mark_read', getLang(req)),
      code: result.statusCode === 404 ? 'NOTIFICATION_NOT_FOUND' : 'NOTIFICATION_READ_FAILED',
    });
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
    return res.status(500).json({
      ...result,
      error: t('notification.cannot_mark_all_read', getLang(req)),
      code: 'NOTIFICATIONS_MARK_ALL_READ_FAILED',
    });
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
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

/**
 * PUT /api/notifications/preferences
 * Update notification preferences
 */
async function updateNotificationPreferences(pool, req, res) {
  const {
    morning_hour,
    evening_hour,
    water_hour,
    reminders_enabled,
    morning_time,
    afternoon_time,
    evening_time,
  } = req.body;

  const inRange = (v, min, max) =>
    v === null || v === undefined || (Number.isInteger(v) && v >= min && v <= max);
  const validTime = (v) =>
    v === null ||
    v === undefined ||
    (typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v));
  if (
    !inRange(morning_hour, 5, 11) ||
    !inRange(evening_hour, 17, 23) ||
    !inRange(water_hour, 10, 18)
  ) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  if (!validTime(morning_time) || !validTime(afternoon_time) || !validTime(evening_time)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }
  if (reminders_enabled !== undefined && typeof reminders_enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }

  try {
    await updatePreferences(pool, req.user.id, {
      morning_hour: morning_hour ?? null,
      evening_hour: evening_hour ?? null,
      water_hour: water_hour ?? null,
      morning_time,
      afternoon_time,
      evening_time,
      reminders_enabled: reminders_enabled !== undefined ? Boolean(reminders_enabled) : undefined,
    });
    const prefs = await getPreferences(pool, req.user.id);
    return res.status(200).json({ ok: true, ...prefs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

let _basicRunning = false;
let _engagementRunning = false;

/**
 * POST /api/notifications/engagement/run
 * Run AI-driven engagement notifications for inactive users (cron)
 */
async function runEngagement(pool, req, res) {
  if (_engagementRunning) return res.status(429).json({
    ok: false,
    error: t('notification.cron_busy', getLang(req)),
    code: 'NOTIFICATION_JOB_BUSY',
  });
  _engagementRunning = true;
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
    }

    const result = await runEngagementNotifications(pool);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  } finally {
    _engagementRunning = false;
  }
}

/**
 * POST /api/notifications/basic/run
 * Run basic scheduled notifications (cron)
 */
async function runBasic(pool, req, res) {
  if (_basicRunning) return res.status(429).json({
    ok: false,
    error: t('notification.cron_busy', getLang(req)),
    code: 'NOTIFICATION_JOB_BUSY',
  });
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: t('error.unauthorized', getLang(req)) });
  }

  const parseOptionalPart = (value, max) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
  };
  const forceHour = parseOptionalPart(req.body?.hour, 23);
  const forceMinute = parseOptionalPart(req.body?.minute, 59);
  if (forceHour === undefined || forceMinute === undefined) {
    return res.status(400).json({ ok: false, error: t('error.invalid_params', getLang(req)) });
  }

  _basicRunning = true;
  try {
    const result = await runBasicNotifications(pool, forceHour, forceMinute);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  } finally {
    _basicRunning = false;
  }
}

async function deleteOne(pool, req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({
        ok: false,
        error: t('notification.invalid_id', getLang(req)),
        code: 'INVALID_NOTIFICATION_ID',
      });
    }
    const result = await notificationService.deleteNotification(pool, id, req.user.id);
    if (!result.deleted) {
      return res.status(404).json({
        ok: false,
        error: t('notification.not_found', getLang(req)),
        code: 'NOTIFICATION_NOT_FOUND',
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
  }
}

async function deleteAll(pool, req, res) {
  try {
    await notificationService.deleteAllNotifications(pool, req.user.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: t('error.server', getLang(req)), code: 'INTERNAL_ERROR' });
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
