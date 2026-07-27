-- Keep the users profile schema compatible with profile updates and avatar uploads.
-- This migration is intentionally idempotent for databases created from older schemas.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE users
SET updated_at = COALESCE(created_at, NOW())
WHERE updated_at IS NULL;
