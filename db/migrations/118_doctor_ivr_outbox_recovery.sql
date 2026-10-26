CREATE UNIQUE INDEX IF NOT EXISTS doctor_ivr_state_event_once
 ON doctor_ivr_events(session_id,event_type)
 WHERE event_type IN ('session.sent','session.completed','session.reported','session.replied','session.closed','session.cancelled','session.expired');
CREATE INDEX IF NOT EXISTS doctor_ivr_event_delivery ON doctor_ivr_events(next_attempt_at,created_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS doctor_ivr_stt_jobs ON doctor_ivr_answers(stt_status,stt_started_at) WHERE active AND answer_type='voice';
