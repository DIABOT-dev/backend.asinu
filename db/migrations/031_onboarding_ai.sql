-- Drop strict CHECK constraints — AI-generated values won't always match fixed enums
ALTER TABLE user_onboarding_profiles
  DROP CONSTRAINT IF EXISTS user_onboarding_profiles_age_check,
  DROP CONSTRAINT IF EXISTS user_onboarding_profiles_gender_check,
  DROP CONSTRAINT IF EXISTS user_onboarding_profiles_goal_check,
  DROP CONSTRAINT IF EXISTS user_onboarding_profiles_body_type_check;

-- Store complete AI-extracted profile for full flexibility
ALTER TABLE user_onboarding_profiles
  ADD COLUMN IF NOT EXISTS raw_profile JSONB NOT NULL DEFAULT '{}';
