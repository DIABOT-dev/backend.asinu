-- Persist push delivery separately from inbox history. Never store device tokens here.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_key TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS counts_toward_cap BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_notification_event_dedup
  ON notifications(user_id, type, event_key, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_push_outbox (
  notification_id INTEGER PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  push_body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'INFLIGHT', 'RETRY', 'SENT', 'CANCELLED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_push_pending
  ON notification_push_outbox(next_attempt_at)
  WHERE state IN ('PENDING', 'RETRY', 'INFLIGHT');
