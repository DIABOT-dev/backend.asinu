-- Migration 013: Add missing profile fields to support full user profile management
-- This migration adds display_name and full_name to support profile editing

-- Add display_name to user_onboarding_profiles (redundant if 012 ran, but safe with IF NOT EXISTS)
ALTER TABLE user_onboarding_profiles
ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Add full_name to users table for direct storage of user's legal name
ALTER TABLE users
ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Add display_name to users table as well for consistency
-- This allows storing name without requiring onboarding profile
ALTER TABLE users
ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Add avatar_url for future profile picture support
ALTER TABLE users
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Update existing users without display_name to use email prefix as default
UPDATE users
SET display_name = COALESCE(
  (SELECT display_name FROM user_onboarding_profiles WHERE user_id = users.id),
  SPLIT_PART(email, '@', 1),
  'User ' || id::TEXT
)
WHERE display_name IS NULL;

-- Comments for documentation
COMMENT ON COLUMN users.display_name IS 'User display name shown in UI (can be nickname)';
COMMENT ON COLUMN users.full_name IS 'User full legal name';
COMMENT ON COLUMN users.avatar_url IS 'URL or key to user avatar image';
COMMENT ON COLUMN user_onboarding_profiles.display_name IS 'User display name from onboarding (deprecated, use users.display_name)';
