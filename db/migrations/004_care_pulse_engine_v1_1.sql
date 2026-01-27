CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS care_pulse_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  event_type TEXT NOT NULL,
  client_ts TIMESTAMPTZ NOT NULL,
  client_tz TEXT,
  ui_session_id TEXT,
  source TEXT,
  self_report TEXT,
  silence_minutes NUMERIC,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_pulse_events_user_ts
  ON care_pulse_events (user_id, client_ts DESC);

CREATE TABLE IF NOT EXISTS care_pulse_engine_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  current_status TEXT NOT NULL DEFAULT 'NORMAL',
  last_check_in_at TIMESTAMPTZ,
  next_ask_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  silence_count INT DEFAULT 0,
  emergency_armed BOOLEAN DEFAULT FALSE,
  last_ask_at TIMESTAMPTZ,
  last_app_opened_at TIMESTAMPTZ,
  episode_id UUID,
  aps NUMERIC(6,4) DEFAULT 0,
  tier INT DEFAULT 0,
  reasons JSONB DEFAULT '[]'::jsonb,
  last_event_ts TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS care_pulse_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id),
  episode_id UUID NOT NULL UNIQUE,
  sent_to_connection_id UUID REFERENCES user_connections(id),
  status TEXT DEFAULT 'pending',
  reasons JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by INTEGER REFERENCES users(id)
);
