-- Migration: Add push_token column for push notifications
-- This allows storing Expo Push Tokens for sending push notifications to users

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS push_token VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_users_push_token ON users(push_token) WHERE push_token IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN users.push_token IS 'Expo Push Token for sending push notifications';
