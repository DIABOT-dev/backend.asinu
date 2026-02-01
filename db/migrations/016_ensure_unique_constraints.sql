-- Migration: Ensure phone and email are unique
-- Date: 2026-01-31

-- Ensure email is unique (already exists but confirm)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_email_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
  END IF;
END $$;

-- Ensure phone is unique (already exists but confirm)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_key UNIQUE (phone);
  END IF;
END $$;

-- Ensure phone_number is unique (already has index)
-- The index idx_users_phone_number already provides uniqueness

-- Add NOT NULL constraints for email and phone when registering via EMAIL provider
-- Note: We can't add NOT NULL to existing columns without data cleanup
-- Instead, we'll enforce this in application logic

-- Add comments for clarity
COMMENT ON COLUMN users.email IS 'Unique email address, required for EMAIL auth provider';
COMMENT ON COLUMN users.phone IS 'Unique phone number (old column, prefer phone_number)';
COMMENT ON COLUMN users.phone_number IS 'Unique phone number, required for PHONE auth provider';
COMMENT ON COLUMN users.password_hash IS 'Hashed password for EMAIL auth, required when auth_provider = EMAIL';
