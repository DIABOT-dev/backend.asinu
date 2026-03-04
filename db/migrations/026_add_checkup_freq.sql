ALTER TABLE user_onboarding_profiles
  ADD COLUMN IF NOT EXISTS checkup_freq TEXT;
