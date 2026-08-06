'use strict';

const logger = require('../../lib/logger');

const DEFAULT_DAILY_CAP = 3;
const DAILY_CAP_TYPES = new Set([
  'health_feed',
  'morning_checkin',
  'evening_checkin',
  'checkin_followup',
  'checkin_followup_urgent',
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
  'streak_7',
  'streak_14',
  'streak_30',
  'streak_start',
  'streak_milestone',
  'milestone',
  'weekly_recap',
  'reengagement',
  'engagement',
]);

const OPT_IN_TYPES = new Set([
  ...DAILY_CAP_TYPES,
  'profile_incomplete',
  'weekly_wellness_summary',
]);

function isOptInType(type) {
  return typeof type === 'string' && (OPT_IN_TYPES.has(type) || type.startsWith('reminder_'));
}

function getDailyCap() {
  const raw = process.env.NOTIFICATION_DAILY_CAP;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_CAP;
  const cap = Number(raw);
  return Number.isInteger(cap) && cap >= 0 && cap <= 100 ? cap : DEFAULT_DAILY_CAP;
}

async function hasReminderOptIn(pool, userId) {
  const { rows } = await pool.query(
    `SELECT reminders_enabled
       FROM user_notification_preferences
      WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.reminders_enabled === true;
}

async function hasReachedDailyCap(pool, userId) {
  const cap = getDailyCap();
  if (cap <= 0) return true;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM notifications
      WHERE user_id = $1
        AND type = ANY($2::text[])
        AND DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') =
            DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
    [userId, [...DAILY_CAP_TYPES]]
  );
  return Number(rows[0]?.count || 0) >= cap;
}

/**
 * Fail closed when preference/cap checks cannot be evaluated. A broken
 * preference query must never turn into an unexpected push to a user.
 */
async function canSendNonUrgent(pool, userId, type) {
  if (!isOptInType(type)) return true;

  try {
    if (!(await hasReminderOptIn(pool, userId))) return false;
    return !(await hasReachedDailyCap(pool, userId));
  } catch (err) {
    logger.error('notification.policy_check_failed', {
      userId,
      type,
      err,
    });
    return false;
  }
}

module.exports = {
  DAILY_CAP_TYPES,
  DEFAULT_DAILY_CAP,
  canSendNonUrgent,
  getDailyCap,
  hasReachedDailyCap,
  hasReminderOptIn,
  isOptInType,
};
