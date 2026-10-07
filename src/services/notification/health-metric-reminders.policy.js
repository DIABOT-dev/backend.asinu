'use strict';

// These scheduled summaries contain health-log/measurement prompts. Pause the
// whole notification family without deleting history or users' saved schedules.
// Medication-only reminders, daily check-ins and safety alerts are independent.
const HEALTH_METRIC_REMINDER_TYPES = Object.freeze([
  'reminder_glucose',
  'reminder_bp',
  'reminder_log_morning',
  'reminder_log_evening',
  'reminder_morning',
  'reminder_morning_summary',
  'reminder_afternoon',
  'reminder_evening_summary',
]);
const metricTypes = new Set(HEALTH_METRIC_REMINDER_TYPES);

function areHealthMetricRemindersEnabled() {
  return (
    String(process.env.HEALTH_METRIC_REMINDERS_ENABLED || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function isHealthMetricReminderSuppressed(type) {
  return metricTypes.has(type) && !areHealthMetricRemindersEnabled();
}

function getHiddenNotificationTypes() {
  return areHealthMetricRemindersEnabled() ? [] : [...HEALTH_METRIC_REMINDER_TYPES];
}

module.exports = {
  HEALTH_METRIC_REMINDER_TYPES,
  areHealthMetricRemindersEnabled,
  getHiddenNotificationTypes,
  isHealthMetricReminderSuppressed,
};
