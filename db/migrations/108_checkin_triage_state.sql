-- Keep follow-up context and the completed response across HTTP retries.
ALTER TABLE health_checkins
  ADD COLUMN IF NOT EXISTS triage_state JSONB NOT NULL DEFAULT '{}'::jsonb;
