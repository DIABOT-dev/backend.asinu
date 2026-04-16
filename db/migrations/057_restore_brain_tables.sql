-- ============================================================================
-- Migration 057: Restore Asinu Brain tables
-- Created: 2026-04-16
-- Purpose: Migration 052 dropped tables still used by asinuBrain.service.js.
--          This restores them with IF NOT EXISTS to be safe.
-- ============================================================================

BEGIN;

-- asinu_brain_sessions must exist first (parent for events/outcomes/snapshots)
-- It was NOT dropped by 052, but columns were removed. Ensure it exists.

CREATE TABLE IF NOT EXISTS asinu_trackers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_path TEXT NOT NULL DEFAULT 'GREEN',
  phase_in_day TEXT,
  locked_session_id TEXT,
  next_due_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  dismissed_until TIMESTAMPTZ,
  last_prompt_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT asinu_trackers_path_check CHECK (current_path IN ('GREEN', 'YELLOW', 'RED', 'EMERGENCY')),
  CONSTRAINT asinu_trackers_phase_check CHECK (phase_in_day IS NULL OR phase_in_day IN ('MORNING', 'NOON', 'AFTERNOON', 'NIGHT')),
  CONSTRAINT asinu_trackers_status_check CHECK (status IN ('ACTIVE', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS risk_persistence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  risk_score INT NOT NULL DEFAULT 0,
  risk_tier TEXT NOT NULL DEFAULT 'LOW',
  last_updated_at TIMESTAMPTZ,
  streak_ok_days INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT risk_persistence_score_check CHECK (risk_score >= 0 AND risk_score <= 100),
  CONSTRAINT risk_persistence_tier_check CHECK (risk_tier IN ('LOW', 'MEDIUM', 'HIGH'))
);

CREATE TABLE IF NOT EXISTS risk_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_config_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID REFERENCES risk_config_versions(id) ON DELETE CASCADE,
  param_key TEXT NOT NULL,
  param_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_decision_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reason TEXT,
  risk_score INT,
  config_version_id UUID REFERENCES risk_config_versions(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asinu_brain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES asinu_brain_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asinu_brain_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES asinu_brain_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome_type TEXT NOT NULL,
  outcome_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asinu_brain_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES asinu_brain_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_asinu_trackers_user_status ON asinu_trackers(user_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_persistence_user_id ON risk_persistence(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_persistence_user_unique ON risk_persistence(user_id);

COMMIT;
