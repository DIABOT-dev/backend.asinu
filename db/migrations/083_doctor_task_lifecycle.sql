-- Authoritative Doctor task lifecycle events returned to ASINU.
-- The outbox stores the initial request; this table stores each operational
-- state transition so patient consultation history is complete and queryable.
CREATE TABLE IF NOT EXISTS doctor_task_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  app_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'started', 'completed', 'cancelled', 'expired', 'failed')),
  doctor_ref TEXT,
  medical_record_ref TEXT,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS doctor_task_lifecycle_user_date_idx
  ON doctor_task_lifecycle_events(tenant_id, app_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS doctor_task_lifecycle_task_date_idx
  ON doctor_task_lifecycle_events(tenant_id, task_id, occurred_at ASC);
