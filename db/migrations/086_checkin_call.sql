-- Check-in Call is opt-in. Existing health_checkins remain independent.
CREATE TABLE IF NOT EXISTS checkin_call_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  checkin_time TIME NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  grace_hours INTEGER NOT NULL DEFAULT 6 CHECK (grace_hours BETWEEN 2 AND 12),
  user_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (user_timeout_seconds BETWEEN 30 AND 180),
  family_ring_seconds INTEGER NOT NULL DEFAULT 60 CHECK (family_ring_seconds BETWEEN 30 AND 120),
  family_confirm_minutes INTEGER NOT NULL DEFAULT 10 CHECK (family_confirm_minutes BETWEEN 5 AND 30),
  max_rounds INTEGER NOT NULL DEFAULT 1 CHECK (max_rounds BETWEEN 1 AND 3),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkin_call_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  state TEXT NOT NULL DEFAULT 'SCHEDULED',
  severity TEXT NOT NULL DEFAULT 'NONE',
  scheduled_at TIMESTAMPTZ NOT NULL,
  grace_until TIMESTAMPTZ NOT NULL,
  next_action_at TIMESTAMPTZ,
  config JSONB NOT NULL,
  family_ids INTEGER[] NOT NULL DEFAULT '{}',
  family_index INTEGER NOT NULL DEFAULT 0,
  round_number INTEGER NOT NULL DEFAULT 1,
  urgent_until TIMESTAMPTZ,
  acknowledged_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date)
);
CREATE INDEX IF NOT EXISTS idx_checkin_call_due ON checkin_call_episodes(next_action_at)
  WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkin_call_family ON checkin_call_episodes
  USING gin(family_ids);

CREATE TABLE IF NOT EXISTS checkin_call_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES checkin_call_episodes(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_role TEXT NOT NULL CHECK (target_role IN ('USER', 'FAMILY')),
  round_number INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'RINGING',
  room_name TEXT NOT NULL UNIQUE,
  ring_deadline TIMESTAMPTZ,
  confirm_deadline TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  push_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_call_attempt_episode ON checkin_call_attempts(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkin_call_attempt_target ON checkin_call_attempts(target_user_id, state);

CREATE TABLE IF NOT EXISTS checkin_call_events (
  id BIGSERIAL PRIMARY KEY,
  episode_id UUID NOT NULL REFERENCES checkin_call_episodes(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES checkin_call_attempts(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_call_event_episode ON checkin_call_events(episode_id, id);

CREATE TABLE IF NOT EXISTS checkin_call_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES checkin_call_episodes(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES checkin_call_attempts(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('INCOMING_CALL', 'FALLBACK', 'URGENT_REPEAT')),
  state TEXT NOT NULL DEFAULT 'PENDING',
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_call_delivery_due ON checkin_call_deliveries(due_at)
  WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS checkin_call_audio (
  audio_key TEXT PRIMARY KEY,
  text_version INTEGER NOT NULL DEFAULT 1,
  text_hash TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  audio_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
