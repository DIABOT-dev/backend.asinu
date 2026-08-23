-- Durable ASINU -> Doctor task delivery. Doctor owns the receiving database.
CREATE TABLE IF NOT EXISTS doctor_task_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  response_status INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS doctor_task_outbox_delivery_idx
  ON doctor_task_outbox(status, next_attempt_at, locked_at);

CREATE INDEX IF NOT EXISTS doctor_task_outbox_tenant_idx
  ON doctor_task_outbox(tenant_id, created_at DESC);
