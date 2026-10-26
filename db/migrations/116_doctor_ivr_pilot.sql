-- Additive pilot. Disabling DOCTOR_IVR_ENABLED restores the existing chat UI.
CREATE TABLE IF NOT EXISTS doctor_ivr_question_sets (
 id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','approved','archived')),
 source TEXT NOT NULL CHECK(source IN ('ai','manual','template')),
 content_enc TEXT NOT NULL, created_by TEXT NOT NULL, approved_by TEXT,
 approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(tenant_id,task_id,version)
);
CREATE TABLE IF NOT EXISTS doctor_ivr_sessions (
 id UUID PRIMARY KEY, question_set_id UUID NOT NULL REFERENCES doctor_ivr_question_sets(id),
 tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 doctor_id TEXT NOT NULL, doctor_name TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'app' CHECK(channel IN ('app','call','both')),
 status TEXT NOT NULL CHECK(status IN ('draft','sent','in_progress','completed','reported','replied','closed','cancelled','unreachable','expired')),
 current_question_id TEXT, path JSONB NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
 is_supplement BOOLEAN NOT NULL DEFAULT FALSE,
 sent_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
 remind_at TIMESTAMPTZ, reminder_count INTEGER NOT NULL DEFAULT 0,
 preparation_attempts INTEGER NOT NULL DEFAULT 0, processing_at TIMESTAMPTZ,
 reply_enc TEXT, replied_at TIMESTAMPTZ, patient_ack_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS doctor_ivr_one_active ON doctor_ivr_sessions(tenant_id,task_id)
 WHERE status IN ('draft','sent','in_progress','completed');
CREATE TABLE IF NOT EXISTS doctor_ivr_answers (
 id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES doctor_ivr_sessions(id) ON DELETE CASCADE,
 question_id TEXT NOT NULL, option_id TEXT, answer_type TEXT NOT NULL CHECK(answer_type IN ('option','voice','skip')),
 client_request_id UUID NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
 audio_enc TEXT, mime_type TEXT, audio_duration_s NUMERIC,
 transcript_enc TEXT, stt_confidence NUMERIC, stt_status TEXT NOT NULL DEFAULT 'none',
 stt_attempts INTEGER NOT NULL DEFAULT 0, stt_started_at TIMESTAMPTZ, skip_reason TEXT,
 is_red_flag BOOLEAN NOT NULL DEFAULT FALSE,
 answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(session_id,question_id), UNIQUE(session_id,client_request_id)
);
CREATE TABLE IF NOT EXISTS doctor_ivr_reports (
 session_id UUID PRIMARY KEY REFERENCES doctor_ivr_sessions(id) ON DELETE CASCADE,
 report_enc TEXT NOT NULL, ai_status TEXT NOT NULL DEFAULT 'pending', ai_attempts INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS doctor_ivr_audio_cache (
 question_set_id UUID NOT NULL REFERENCES doctor_ivr_question_sets(id) ON DELETE CASCADE,
 question_id TEXT NOT NULL, audio_enc TEXT NOT NULL, mime_type TEXT NOT NULL, content_hash TEXT,
 PRIMARY KEY(question_set_id,question_id)
);
CREATE TABLE IF NOT EXISTS doctor_ivr_events (
 id UUID PRIMARY KEY, session_id UUID REFERENCES doctor_ivr_sessions(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor TEXT NOT NULL, event_type TEXT NOT NULL, detail_enc TEXT NOT NULL,
 delivery_attempts INTEGER NOT NULL DEFAULT 0, delivered_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doctor_ivr_jobs ON doctor_ivr_sessions(status,remind_at,expires_at);
CREATE TABLE IF NOT EXISTS doctor_ivr_templates (
 id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 name TEXT NOT NULL, specialty TEXT, content_enc TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
