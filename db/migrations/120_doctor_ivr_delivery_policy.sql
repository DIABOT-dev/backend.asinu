-- Additive: the feature remains gated by DOCTOR_IVR_ENABLED / DOCTOR_IVR_CALL_ENABLED.
CREATE TABLE IF NOT EXISTS doctor_ivr_policies (
 tenant_id TEXT PRIMARY KEY, config JSONB NOT NULL,
 updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_ivr_calls BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS doctor_ivr_policy_events (
 id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, actor TEXT NOT NULL,
 before_config JSONB, after_config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE doctor_ivr_templates ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE doctor_ivr_sessions ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{}';
ALTER TABLE doctor_ivr_answers ADD COLUMN IF NOT EXISTS stt_needs_review BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS doctor_ivr_call_attempts (
 id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES doctor_ivr_sessions(id) ON DELETE CASCADE,
 attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
 status TEXT NOT NULL CHECK(status IN ('queued','dispatching','ringing','accepted','declined','missed','failed','cancelled','ended')),
 scheduled_at TIMESTAMPTZ NOT NULL, ring_deadline TIMESTAMPTZ, accepted_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ, delivery_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id,attempt_no)
);
CREATE INDEX IF NOT EXISTS doctor_ivr_call_due ON doctor_ivr_call_attempts(status,scheduled_at,ring_deadline);
CREATE UNIQUE INDEX IF NOT EXISTS doctor_ivr_one_live_call ON doctor_ivr_call_attempts(session_id)
 WHERE status IN ('queued','dispatching','ringing','accepted');
