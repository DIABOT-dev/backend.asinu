/**
 * NotificationOrchestrator — Central notification dispatcher
 * All notification sending goes through here.
 * Decides: what to send, when, to whom, at what priority.
 *
 * Note: Does NOT import from basic.notification.service to avoid circular deps.
 * Instead, performs DB insert directly. For push notifications, callers handle
 * push separately or use sendCheckinNotification which wraps both.
 */

const COOLDOWN_MINUTES = {
  critical: 1, // 1 min cooldown — prevents panic multi-tap but still urgent
  high: 30, // 30 min cooldown
  medium: 60, // 1h cooldown
  low: 120, // 2h cooldown
};

const {
  reserveNotification,
} = require('../../services/notification/notification-dispatch.service');

const TYPE_PRIORITY = {
  emergency: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  morning_checkin: 'medium',
  reminder_glucose: 'medium',
  reminder_bp: 'medium',
  care_circle_invitation: 'medium',
  evening_checkin: 'low',
  milestone: 'low',
};

/**
 * Dispatch a notification: save to DB with cooldown protection.
 * @param {object} pool - DB pool
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.type
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {object} [opts.data={}]
 * @param {string|null} [opts.priority=null] - override priority
 * @returns {object|null} - null if skipped due to cooldown
 */
async function dispatch(pool, { userId, type, title, body, data = {}, priority = null }) {
  const effectivePriority = priority || TYPE_PRIORITY[type] || 'low';
  try {
    const reserved = await reserveNotification(pool, {
      userId,
      type,
      title,
      body,
      data,
      priority: effectivePriority,
      cooldownMinutes: COOLDOWN_MINUTES[effectivePriority] || 5,
    });
    return reserved ? { ok: true, ...reserved } : null;
  } catch (error) {
    console.error('[Orchestrator] dispatch failed:', error.message);
    return null;
  }
}

module.exports = { dispatch, TYPE_PRIORITY };
