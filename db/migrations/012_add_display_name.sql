-- Add display_name column to user_onboarding_profiles table
ALTER TABLE user_onboarding_profiles
ADD COLUMN IF NOT EXISTS display_name TEXT;
