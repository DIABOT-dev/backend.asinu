-- A device flag is not authority to disclose personal data to AI providers.
CREATE TABLE IF NOT EXISTS user_ai_consents (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  providers JSONB NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
