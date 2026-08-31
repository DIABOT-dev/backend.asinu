CREATE TABLE IF NOT EXISTS doctor_privacy_request_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('withdraw_consent', 'export', 'anonymize', 'delete')),
  source_event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('processing', 'completed', 'failed')),
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS doctor_privacy_receipts_user_idx
  ON doctor_privacy_request_receipts (user_id, created_at DESC);
