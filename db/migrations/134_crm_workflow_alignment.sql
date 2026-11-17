CREATE TABLE crm_projection_revisions (
  projection TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(projection,resource_id)
);
CREATE TABLE crm_command_receipts (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE iap_receipts ADD COLUMN amount_minor BIGINT, ADD COLUMN currency TEXT;
CREATE INDEX crm_event_outbox_subject_idx ON crm_event_outbox((payload->>'user_id'),event_type);
