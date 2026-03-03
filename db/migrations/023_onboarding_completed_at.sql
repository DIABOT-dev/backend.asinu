-- Migration 023: Add onboarding_completed_at to track completion
ALTER TABLE user_onboarding_profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
