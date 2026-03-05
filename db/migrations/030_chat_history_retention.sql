-- Migration 030: Chat history retention index + cleanup
-- Free users: 7 days, Premium users: 30 days

-- Index for efficient retention queries
CREATE INDEX IF NOT EXISTS idx_chat_histories_user_created
  ON chat_histories (user_id, created_at DESC);

-- Cleanup function: delete messages older than retention period
-- Called periodically from application layer
CREATE OR REPLACE FUNCTION cleanup_chat_histories() RETURNS void AS $$
BEGIN
  -- Delete free-tier messages older than 7 days (users without active premium)
  DELETE FROM chat_histories
  WHERE created_at < NOW() - INTERVAL '7 days'
    AND user_id IN (
      SELECT id FROM users
      WHERE subscription_tier IS DISTINCT FROM 'premium'
         OR subscription_expires_at IS NULL
         OR subscription_expires_at < NOW()
    );

  -- Delete premium messages older than 30 days
  DELETE FROM chat_histories
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
