-- Contextual quick triage for the check-in call.
-- Stores stable keys only; localized display text is generated at read time.
ALTER TABLE checkin_call_episodes
  ADD COLUMN IF NOT EXISTS triage_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS triage_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN checkin_call_episodes.triage_context IS
  'Rule-based quick triage: body_location, symptom and intensity stable keys.';
