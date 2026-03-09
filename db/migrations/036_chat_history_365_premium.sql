-- Migration 036: Update chat history retention — premium 30 days → 365 days

-- Update cleanup function to keep 365 days for premium users
CREATE OR REPLACE FUNCTION cleanup_chat_histories() RETURNS void AS $$
BEGIN
  -- Delete free-tier messages older than 7 days
  DELETE FROM chat_histories
  WHERE created_at < NOW() - INTERVAL '7 days'
    AND user_id IN (
      SELECT id FROM users
      WHERE subscription_tier IS DISTINCT FROM 'premium'
         OR subscription_expires_at IS NULL
         OR subscription_expires_at < NOW()
    );

  -- Delete premium messages older than 365 days
  DELETE FROM chat_histories
  WHERE created_at < NOW() - INTERVAL '365 days';
END;
$$ LANGUAGE plpgsql;
