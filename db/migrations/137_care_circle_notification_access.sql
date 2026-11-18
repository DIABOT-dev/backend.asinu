ALTER TABLE user_connections
  ADD COLUMN IF NOT EXISTS requester_shares_notifications BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS addressee_shares_notifications BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id_desc ON notifications (user_id, id DESC);
