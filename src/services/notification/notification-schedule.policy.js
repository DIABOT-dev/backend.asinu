'use strict';

const { ROUTINE_SPACING_MINUTES } = require('./notification.policy');

const SCHEDULED_REMINDER_TYPES = new Set([
  'morning_checkin',
  'evening_checkin',
  'reminder_morning_summary',
  'reminder_afternoon',
  'reminder_evening_summary',
  'reminder_log_morning',
  'reminder_log_evening',
  'reminder_glucose',
  'reminder_bp',
  'reminder_medication',
  'reminder_medication_morning',
  'reminder_medication_evening',
  'reminder_morning',
  'reminder_water',
]);

function isScheduledReminder(type) {
  return (
    typeof type === 'string' && (SCHEDULED_REMINDER_TYPES.has(type) || type.startsWith('reminder_'))
  );
}

function minuteOfDay(times, hour, fallback) {
  for (const time of times) {
    if (typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time.trim())) {
      const [h, m] = time.trim().split(':').map(Number);
      return h * 60 + m;
    }
  }
  return (Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback) * 60;
}

function scheduledHoldUntil(preferences, reference = new Date()) {
  if (preferences.reminders_enabled !== true) return null;
  const now = new Date(reference).getTime();
  if (!Number.isFinite(now)) return null;
  // The notification scheduler runs in Asia/Ho_Chi_Minh (UTC+7), not the
  // device's timezone. Match its exact HH:MM -> hour -> default precedence.
  const vnOffset = 7 * 60 * 60 * 1000;
  const day = new Date(now + vnOffset);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - vnOffset;
  const slots = [
    7 * 60, // The existing system morning check-in.
    minuteOfDay(
      [preferences.morning_time],
      preferences.morning_hour ?? preferences.inferred_morning_hour,
      8
    ),
    minuteOfDay([preferences.afternoon_time, preferences.inferred_afternoon_time], null, 14),
    minuteOfDay(
      [preferences.evening_time],
      preferences.evening_hour ?? preferences.inferred_evening_hour,
      21
    ),
  ];
  let holdUntil = null;
  for (const minute of slots) {
    if (minute < 5 * 60 || minute >= 22 * 60) continue; // Same quiet hours as cron.
    const scheduled = midnight + minute * 60000;
    if (now >= scheduled - ROUTINE_SPACING_MINUTES * 60000 && now < scheduled + 60000) {
      // Leave a complete cron minute to create the fixed-time reminder.
      holdUntil = Math.max(holdUntil || 0, scheduled + ROUTINE_SPACING_MINUTES * 60000);
    }
  }
  return holdUntil ? new Date(holdUntil) : null;
}

async function getScheduledReminderHoldUntil(pool, userId) {
  const { rows } = await pool.query(
    `SELECT np.reminders_enabled, np.morning_time, np.afternoon_time, np.evening_time,
            np.morning_hour, np.evening_hour, np.inferred_morning_hour,
            np.inferred_evening_hour, np.inferred_afternoon_time, NOW() AS reference_time
       FROM user_notification_preferences np
       JOIN user_onboarding_profiles uop ON uop.user_id = np.user_id
      WHERE np.user_id = $1 AND uop.onboarding_completed_at IS NOT NULL`,
    [userId]
  );
  return rows[0] ? scheduledHoldUntil(rows[0], rows[0].reference_time) : null;
}

module.exports = {
  SCHEDULED_REMINDER_TYPES,
  getScheduledReminderHoldUntil,
  isScheduledReminder,
  scheduledHoldUntil,
};
