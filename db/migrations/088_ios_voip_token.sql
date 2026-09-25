-- Native iOS PushKit token used for CallKit incoming check-in calls.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS voip_push_token TEXT,
  ADD COLUMN IF NOT EXISTS voip_push_environment TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_voip_push_token_unique
  ON users(voip_push_token)
  WHERE voip_push_token IS NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_voip_push_environment_check;

ALTER TABLE users
  ADD CONSTRAINT users_voip_push_environment_check
  CHECK (
    voip_push_environment IS NULL OR
    voip_push_environment IN ('sandbox', 'production')
  );

COMMENT ON COLUMN users.voip_push_token IS
  'Native iOS PushKit VoIP token used for CallKit check-in call delivery';

COMMENT ON COLUMN users.voip_push_environment IS
  'APNs environment that issued voip_push_token: sandbox or production';
