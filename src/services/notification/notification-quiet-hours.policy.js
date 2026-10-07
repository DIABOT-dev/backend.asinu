'use strict';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 6;
const REMINDER_SLOTS = {
  morning_checkin: ['morning'],
  reminder_morning: ['morning'],
  reminder_morning_summary: ['morning'],
  reminder_log_morning: ['morning'],
  reminder_medication_morning: ['morning'],
  reminder_afternoon: ['afternoon'],
  evening_checkin: ['evening'],
  reminder_evening_summary: ['evening'],
  reminder_log_evening: ['evening'],
  reminder_medication_evening: ['evening'],
  reminder_glucose: ['morning', 'afternoon', 'evening'],
  reminder_bp: ['morning', 'afternoon', 'evening'],
  reminder_medication: ['morning', 'afternoon', 'evening'],
};

function resolveNotificationTimezone(timezone) {
  const value =
    typeof timezone === 'string' && timezone.trim() ? timezone.trim() : DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function timeParts(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
}

function isQuietHour(hour) {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function explicitReminderMinute(preferences, slot) {
  const time = preferences?.[`${slot}_time`];
  if (typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time.trim())) {
    const [hour, minute] = time.trim().split(':').map(Number);
    return hour * 60 + minute;
  }
  const hour = slot === 'afternoon' ? null : preferences?.[`${slot}_hour`];
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour * 60 : null;
}

function isTimeCriticalNotification(notification) {
  const data = notification.data || {};
  // A routine "inactive for several days" nudge uses the caregiver_alert
  // type too; it must not inherit the emergency exception.
  if (data.reengage_patient_id || data.templateId === 'reengage_care_circle') return false;
  if (
    notification.priority === 'critical' ||
    data.requiresImmediate === true ||
    data.alertType === 'emergency'
  )
    return true;
  if (
    ['emergency', 'alert', 'health_alert', 'caregiver_alert', 'checkin_followup_urgent'].includes(
      notification.type
    )
  )
    return true;
  if (notification.type === 'early_signal' && String(data.severity).toLowerCase() === 'urgent')
    return true;
  return (
    notification.type === 'checkin_call' && ['INCOMING_CALL', 'URGENT_REPEAT'].includes(data.kind)
  );
}

function isExplicitNightReminder(notification, preferences, reference) {
  if (preferences?.reminders_enabled !== true) return false;
  const slots = REMINDER_SLOTS[notification.type] || [];
  if (!slots.length || !notification.created_at) return false;
  const created = new Date(notification.created_at);
  if (!Number.isFinite(created.getTime()) || created > reference || reference - created >= 86400000)
    return false;
  // Fixed-time reminders are scheduled in Vietnam time, independently of the
  // user's baseline timezone. Only the matching configured slot is exempt.
  const parts = timeParts(DEFAULT_TIMEZONE, created);
  const minute = parts.hour * 60 + parts.minute;
  return slots.some((slot) => explicitReminderMinute(preferences, slot) === minute);
}

function getQuietHoursHoldUntil(notification, preferences, timezone, reference = new Date()) {
  if (isTimeCriticalNotification(notification)) return null;
  const now = new Date(reference);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid notification reference time');
  const zone = resolveNotificationTimezone(timezone);
  const local = timeParts(zone, now);
  if (!isQuietHour(local.hour) || isExplicitNightReminder(notification, preferences, now))
    return null;
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day + (local.hour >= QUIET_START_HOUR ? 1 : 0),
    QUIET_END_HOUR
  );
  let candidate = target;
  // Resolve the wall-clock 06:00 to UTC, including a DST transition overnight.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = timeParts(zone, new Date(candidate));
    const wall = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const delta = target - wall;
    if (!delta) return new Date(candidate);
    candidate += delta;
  }
  throw new Error('Cannot resolve notification quiet-hours boundary');
}

module.exports = {
  DEFAULT_TIMEZONE,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  explicitReminderMinute,
  getQuietHoursHoldUntil,
  isQuietHour,
  resolveNotificationTimezone,
};
