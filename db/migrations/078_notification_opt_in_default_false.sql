-- Notification reminders are opt-in. The old schema used DEFAULT TRUE, so an
-- existing TRUE value cannot be proven to be an explicit user consent. Reset
-- legacy values and require users to opt in again from Settings.

ALTER TABLE user_notification_preferences
  ALTER COLUMN reminders_enabled SET DEFAULT FALSE;

UPDATE user_notification_preferences
   SET reminders_enabled = FALSE
 WHERE reminders_enabled IS DISTINCT FROM FALSE;
