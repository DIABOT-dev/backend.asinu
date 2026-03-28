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
  const cooldownMinutes = COOLDOWN_MINUTES[effectivePriority];

  // Atomic: INSERT only if no recent notification of same type within cooldown window
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data, priority)
     SELECT $1, $2, $3, $4, $5::jsonb, $6
     WHERE NOT EXISTS (
       SELECT 1 FROM notifications
       WHERE user_id = $1 AND type = $2
         AND created_at >= NOW() - make_interval(mins => $7::int)
     )
     RETURNING id`,
    [userId, type, title, body, JSON.stringify(data), effectivePriority, cooldownMinutes || 0]
  );

  if (rows.length === 0) {
    console.log(`[Orchestrator] Skipped ${type} for user ${userId} (cooldown ${cooldownMinutes}min)`);
    return null;
  }

  return { ok: true, notificationId: rows[0].id };
}

module.exports = { dispatch, TYPE_PRIORITY };
