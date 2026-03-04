ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_engagement_notif_at TIMESTAMPTZ;

COMMENT ON COLUMN users.last_engagement_notif_at IS 'Last time an AI-generated re-engagement push notification was sent to this user';
