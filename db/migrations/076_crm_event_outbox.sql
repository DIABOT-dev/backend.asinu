-- Durable delivery queue for the Asinu -> CRM webhook integration.
-- The payload contains only the already-approved CRM event projection.
CREATE TABLE IF NOT EXISTS crm_event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'asinu-backend',
  version INTEGER NOT NULL DEFAULT 1,
  correlation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_event_outbox_delivery
  ON crm_event_outbox (status, next_attempt_at, locked_at)
  WHERE status <> 'sent';

CREATE INDEX IF NOT EXISTS idx_crm_event_outbox_type_created
  ON crm_event_outbox (event_type, created_at DESC);
