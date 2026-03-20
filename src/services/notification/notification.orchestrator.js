/**
 * NotificationOrchestrator — Central notification dispatcher
 * All notification sending goes through here.
 * Decides: what to send, when, to whom, at what priority.
 *
 * Note: Does NOT import from basic.notification.service to avoid circular deps.
 * Instead, performs DB insert directly. For push notifications, callers handle
 * push separately or use sendCheckinNotification which wraps both.
 */

// Cooldown tracking (prevent spam)
const recentNotifications = new Map(); // "userId:type" -> lastSentAt timestamp

const COOLDOWN_MINUTES = {
  critical: 0,      // no cooldown for critical
  high: 30,          // 30 min cooldown
  medium: 60,        // 1h cooldown
  low: 120,          // 2h cooldown
};

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

  // Check cooldown
  const userKey = `${userId}:${type}`;
  const now = Date.now();
  const lastSent = recentNotifications.get(userKey);
  const cooldown = COOLDOWN_MINUTES[effectivePriority] * 60 * 1000;

  if (lastSent && (now - lastSent) < cooldown) {
    console.log(`[Orchestrator] Skipped ${type} for user ${userId} (cooldown ${COOLDOWN_MINUTES[effectivePriority]}min)`);
    return null;
  }

  // Save to DB
  const result = await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data, priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, type, title, body, JSON.stringify(data), effectivePriority]
  );

  // Track
  recentNotifications.set(userKey, now);

  // Cleanup old entries when map gets large
  if (recentNotifications.size > 500) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [k, v] of recentNotifications) {
      if (v < cutoff) recentNotifications.delete(k);
    }
  }

  return { ok: true, notificationId: result.rows[0]?.id };
}

module.exports = { dispatch, TYPE_PRIORITY };
