CREATE TABLE IF NOT EXISTS user_engagement (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL, -- 'checkin_response', 'app_open', 'log_entry', 'chat_message'
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_user_engagement_user_date ON user_engagement(user_id, occurred_at DESC);
