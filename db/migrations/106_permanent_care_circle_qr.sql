-- A connection QR is a public invitation address, never an authentication token.
-- Keep legacy, short-lived tokens unchanged. Each account can have only one
-- permanent code, including when several devices request it simultaneously.
ALTER TABLE care_circle_qr_tokens
  ADD COLUMN IF NOT EXISTS token_value TEXT;

ALTER TABLE care_circle_qr_tokens
  ALTER COLUMN expires_at DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_circle_qr_tokens_permanent_owner
  ON care_circle_qr_tokens (owner_user_id)
  WHERE token_value IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'care_circle_qr_tokens'::regclass
      AND conname = 'care_circle_qr_permanent_code_check'
  ) THEN
    ALTER TABLE care_circle_qr_tokens
      ADD CONSTRAINT care_circle_qr_permanent_code_check
      CHECK (token_value IS NULL OR (
        expires_at IS NULL AND token_value ~ '^[A-Za-z0-9_-]{43}$'
      ));
  END IF;
END $$;

COMMENT ON COLUMN care_circle_qr_tokens.token_value IS
  'Stable public connection QR, not a password or session credential';
