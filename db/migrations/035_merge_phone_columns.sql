-- Migration 035: Merge phone + phone_number → phone_number only
-- Strategy: keep phone_number if exists, else copy from phone
-- Idempotent: safe to run even if phone column already dropped

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'phone'
  ) THEN
    -- Step 1: Fill phone_number from phone only where phone_number is missing
    UPDATE users
    SET phone_number = phone
    WHERE phone IS NOT NULL AND phone <> ''
      AND (phone_number IS NULL OR phone_number = '');

    -- Step 2: Drop old phone column
    ALTER TABLE users DROP COLUMN IF EXISTS phone;
  END IF;
END $$;
