-- Asinu Brain extension tables

CREATE TABLE IF NOT EXISTS asinu_brain_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_question_id TEXT,
  last_answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asinu_brain_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES asinu_brain_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL,
  question_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asinu_brain_outcomes (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES asinu_brain_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  risk_level VARCHAR(30) NOT NULL,
  notify_caregiver BOOLEAN NOT NULL DEFAULT false,
  recommended_action TEXT,
  outcome_text TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asinu_brain_sessions_user_status
  ON asinu_brain_sessions(user_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_asinu_brain_events_session_time
  ON asinu_brain_events(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_asinu_brain_events_user_time
  ON asinu_brain_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_asinu_brain_outcomes_user_time
  ON asinu_brain_outcomes(user_id, created_at DESC);

COMMENT ON TABLE asinu_brain_sessions IS 'Asinu Brain sessions (plugin extension)';
COMMENT ON TABLE asinu_brain_events IS 'Asinu Brain question/answer events (plugin extension)';
COMMENT ON TABLE asinu_brain_outcomes IS 'Asinu Brain outcomes and risk decisions (plugin extension)';
