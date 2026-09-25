const TZ = 'Asia/Ho_Chi_Minh';

const TYPE_PRIORITY = {
  emergency: 'critical',
  checkin_followup_urgent: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  morning_checkin: 'medium',
  care_circle_invitation: 'medium',
  care_circle_accepted: 'medium',
  reminder_glucose: 'medium',
  reminder_bp: 'medium',
  reminder_medication: 'medium',
  reminder_afternoon: 'low',
  reminder_morning: 'low',
  evening_checkin: 'low',
  caregiver_confirmed: 'low',
  milestone: 'low',
  streak_start: 'low',
  streak_milestone: 'low',
  weekly_recap: 'low',
  engagement: 'low',
};

const SEVERITY_COLORS = {
  low: '#16a34a',
  medium: '#f59e0b',
  high: '#dc2626',
};

// NOTIF_MAP is used by the developer push tester. Values are translation keys
// so the test notification follows the recipient's language just like
// production notifications.
const NOTIF_MAP = {
  reminder_log_morning: ['push.reminder_log_morning_title', 'push.reminder_log_morning_body'],
  reminder_log_evening: ['push.reminder_log_evening_title', 'push.reminder_log_evening_body'],
  reminder_afternoon: ['dev_notification.reminder_afternoon_title', 'dev_notification.reminder_afternoon_body'],
  reminder_morning: ['dev_notification.reminder_morning_title', 'dev_notification.reminder_morning_body'],
  reminder_water: ['push.reminder_water_title', 'push.reminder_water_body'],
  reminder_glucose: ['push.reminder_glucose_title', 'push.reminder_glucose_body'],
  reminder_bp: ['push.reminder_bp_title', 'push.reminder_bp_body'],
  reminder_medication_morning: ['push.reminder_medication_morning_title', 'push.reminder_medication_morning_body'],
  reminder_medication_evening: ['push.reminder_medication_evening_title', 'push.reminder_medication_evening_body'],
  reminder_medication: ['dev_notification.reminder_medication_title', 'dev_notification.reminder_medication_body'],
  morning_checkin: ['dev_notification.morning_checkin_title', 'dev_notification.morning_checkin_body'],
  evening_checkin: ['dev_notification.evening_checkin_title', 'dev_notification.evening_checkin_body'],
  checkin_followup: ['dev_notification.checkin_followup_title', 'dev_notification.checkin_followup_body'],
  checkin_followup_urgent: ['dev_notification.checkin_followup_urgent_title', 'dev_notification.checkin_followup_urgent_body'],
  emergency: ['dev_notification.emergency_title', 'dev_notification.emergency_body'],
  health_alert: ['dev_notification.health_alert_title', 'dev_notification.health_alert_body'],
  caregiver_alert: ['dev_notification.caregiver_alert_title', 'dev_notification.caregiver_alert_body'],
  caregiver_confirmed: ['dev_notification.caregiver_confirmed_title', 'dev_notification.caregiver_confirmed_body'],
  care_circle_invitation: ['push.invitation_title', 'dev_notification.care_circle_invitation_body'],
  care_circle_accepted: ['push.accepted_title', 'dev_notification.care_circle_accepted_body'],
  streak_7: ['push.streak_7_title', 'push.streak_7_body'],
  streak_14: ['push.streak_14_title', 'push.streak_14_body'],
  streak_30: ['push.streak_30_title', 'push.streak_30_body'],
  streak_start: ['dev_notification.streak_start_title', 'dev_notification.streak_start_body'],
  streak_milestone: ['dev_notification.streak_milestone_title', 'dev_notification.streak_milestone_body'],
  milestone: ['dev_notification.milestone_title', 'dev_notification.milestone_body'],
  weekly_recap: ['push.weekly_recap_title', 'dev_notification.weekly_recap_body'],
  engagement: ['dev_notification.engagement_title', 'dev_notification.engagement_body'],
};

module.exports = { TZ, TYPE_PRIORITY, SEVERITY_COLORS, NOTIF_MAP };
