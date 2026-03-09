-- Migration 037: Onboarding V2 columns
-- Adds new fields for the fixed 5-page wizard onboarding flow

ALTER TABLE user_onboarding_profiles
  ADD COLUMN IF NOT EXISTS birth_year INTEGER,
  ADD COLUMN IF NOT EXISTS daily_medication TEXT,
  ADD COLUMN IF NOT EXISTS sleep_hours TEXT,
  ADD COLUMN IF NOT EXISTS meals_per_day TEXT,
  ADD COLUMN IF NOT EXISTS post_meal_drowsy TEXT,
  ADD COLUMN IF NOT EXISTS dinner_time TEXT,
  ADD COLUMN IF NOT EXISTS sweet_intake TEXT,
  ADD COLUMN IF NOT EXISTS user_goal JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS user_group TEXT NOT NULL DEFAULT 'wellness';

-- Remove old restrictive CHECK constraints on gender/goal/body_type since they conflict
ALTER TABLE user_onboarding_profiles DROP CONSTRAINT IF EXISTS user_onboarding_profiles_gender_check;
ALTER TABLE user_onboarding_profiles DROP CONSTRAINT IF EXISTS user_onboarding_profiles_goal_check;
ALTER TABLE user_onboarding_profiles DROP CONSTRAINT IF EXISTS user_onboarding_profiles_body_type_check;
ALTER TABLE user_onboarding_profiles DROP CONSTRAINT IF EXISTS user_onboarding_profiles_age_check;
