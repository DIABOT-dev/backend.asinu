DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_provider') THEN
    CREATE TYPE auth_provider AS ENUM ('EMAIL', 'GOOGLE', 'APPLE', 'PHONE', 'ZALO');
  END IF;
END $$;

ALTER TYPE auth_provider ADD VALUE IF NOT EXISTS 'ZALO';

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS zalo_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider auth_provider DEFAULT 'EMAIL';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
