-- Persist revocation across backend restarts and across API/WebSocket workers.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_token_version INTEGER NOT NULL DEFAULT 0;
