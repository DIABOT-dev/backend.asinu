-- Native Android FCM token used for high-priority/full-screen check-in calls.
-- Keep the existing Expo token for all other notifications and iOS fallback.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_fcm_token_unique
  ON users(fcm_token)
  WHERE fcm_token IS NOT NULL;

COMMENT ON COLUMN users.fcm_token IS
  'Native Android FCM registration token for direct high-priority call delivery';
