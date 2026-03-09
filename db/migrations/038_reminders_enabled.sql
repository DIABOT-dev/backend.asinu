-- 038_reminders_enabled.sql
-- Add reminders_enabled flag to user notification preferences.
-- When false, basic (task) push reminders are suppressed for that user.

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE;
