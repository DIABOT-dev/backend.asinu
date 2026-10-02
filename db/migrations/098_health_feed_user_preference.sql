-- Keep the Health Feed switch consistent across devices and backend jobs.
-- Content remains stored when disabled; only presentation and notifications
-- are suppressed until the user enables the feature again.

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS health_feed_enabled BOOLEAN NOT NULL DEFAULT TRUE;
