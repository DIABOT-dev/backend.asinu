CREATE TABLE IF NOT EXISTS care_circle_qr_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT care_circle_qr_token_hash_length CHECK (char_length(token_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_care_circle_qr_tokens_owner_created
  ON care_circle_qr_tokens (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_care_circle_qr_tokens_active
  ON care_circle_qr_tokens (token_hash, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
