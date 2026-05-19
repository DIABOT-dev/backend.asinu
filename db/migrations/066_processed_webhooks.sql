-- Idempotency table for payment webhooks.
-- Prevents replay/duplicate processing of SePay webhook events.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  webhook_id    VARCHAR(128) PRIMARY KEY,
  provider      VARCHAR(32)  NOT NULL DEFAULT 'sepay',
  payload_hash  VARCHAR(64),
  processed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_processed_at
  ON processed_webhooks (processed_at);
