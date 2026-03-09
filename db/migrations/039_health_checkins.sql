-- 039_health_checkins.sql
-- Daily health check-in system
-- Supports 5 flows: fine / tired / very_tired / user-initiated / emergency

CREATE TABLE IF NOT EXISTS health_checkins (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date     DATE NOT NULL,

  -- Status: 'fine' | 'tired' | 'very_tired'
  initial_status   TEXT NOT NULL,
  current_status   TEXT NOT NULL,

  -- Flow: 'monitoring' | 'follow_up' | 'high_alert' | 'resolved'
  flow_state       TEXT NOT NULL DEFAULT 'monitoring',

  -- Triage conversation [{question, answer, options, timestamp}]
  triage_messages  JSONB NOT NULL DEFAULT '[]',
  triage_summary   TEXT,
  triage_severity  TEXT,             -- 'low' | 'medium' | 'high'
  triage_completed_at TIMESTAMPTZ,

  -- Follow-up scheduling
  next_checkin_at  TIMESTAMPTZ,
  no_response_count INTEGER NOT NULL DEFAULT 0,
  last_response_at  TIMESTAMPTZ DEFAULT NOW(),

  -- Escalation
  family_alerted        BOOLEAN NOT NULL DEFAULT FALSE,
  family_alerted_at     TIMESTAMPTZ,
  emergency_triggered   BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_location    JSONB,        -- {lat, lng, accuracy}

  -- Resolution
  resolved_at      TIMESTAMPTZ,

  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_health_checkins_user    ON health_checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_health_checkins_followup ON health_checkins(next_checkin_at)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_health_checkins_date    ON health_checkins(session_date DESC);
