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
  critical: 1,      // 1 min cooldown — prevents panic multi-tap but still urgent
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

  // Use advisory lock per user+type to prevent race conditions
  // hashtext gives a stable int for the string, ensuring same user+type always gets same lock
  const client = await pool.connect();
  try {
    // Advisory lock scoped to this user+type (released on client.release)
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [`notif:${userId}:${type}`]);

    // Check cooldown
    if (cooldownMinutes > 0) {
      const { rows: recent } = await client.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2
           AND created_at >= NOW() - make_interval(mins => $3) LIMIT 1`,
        [userId, type, cooldownMinutes]
      );
      if (recent.length > 0) {
        console.log(`[Orchestrator] Skipped ${type} for user ${userId} (cooldown ${cooldownMinutes}min)`);
        return null;
      }
    }

    // Insert
    const { rows } = await client.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [userId, type, title, body, JSON.stringify(data), effectivePriority]
    );

    return { ok: true, notificationId: rows[0].id };
  } catch (err) {
    console.error(`[Orchestrator] dispatch failed for ${type} user=${userId}:`, err.message);
    return null;
  } finally {
    // Advisory lock released when client returns to pool
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`notif:${userId}:${type}`]).catch(() => {});
    client.release();
  }
}

module.exports = { dispatch, TYPE_PRIORITY };
