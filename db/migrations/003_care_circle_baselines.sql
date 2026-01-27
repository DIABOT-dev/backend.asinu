CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id INTEGER REFERENCES users(id),
  addressee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER REFERENCES users(id),
  relationship_type TEXT,
  role TEXT,
  permissions JSONB NOT NULL DEFAULT '{"can_view_logs":false,"can_receive_alerts":false,"can_ack_escalation":false}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_connections_pair
  ON user_connections (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE TABLE IF NOT EXISTS user_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER UNIQUE REFERENCES users(id),
  timezone TEXT DEFAULT 'Asia/Bangkok',
  morning_start_hour INT DEFAULT 6,
  morning_end_hour INT DEFAULT 10,
  evening_start_hour INT DEFAULT 19,
  evening_end_hour INT DEFAULT 22,
  tired_interval_minutes INT DEFAULT 240,
  emergency_interval_minutes INT DEFAULT 90,
  escalation_silence_count INT DEFAULT 2,
  escalation_delay_minutes INT DEFAULT 20,
  mu_silence_minutes NUMERIC DEFAULT 10,
  sigma_silence_minutes NUMERIC DEFAULT 5,
  source TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_baselines ADD COLUMN IF NOT EXISTS mu_silence_minutes NUMERIC;
ALTER TABLE user_baselines ADD COLUMN IF NOT EXISTS sigma_silence_minutes NUMERIC;
