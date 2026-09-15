-- Messenger-style consultation metadata. Message bodies remain in ASINU;
-- Doctor receives only the fields allowed by the signed integration contract.
ALTER TABLE doctor_task_messages
  DROP CONSTRAINT IF EXISTS doctor_task_messages_message_type_check;

ALTER TABLE doctor_task_messages
  ADD CONSTRAINT doctor_task_messages_message_type_check
  CHECK (message_type IN ('question', 'consultation', 'reply', 'follow_up', 'voice'));

ALTER TABLE doctor_task_messages
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_by_type TEXT,
  ADD COLUMN IF NOT EXISTS read_by_ref TEXT,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_type TEXT,
  ADD COLUMN IF NOT EXISTS deleted_by_ref TEXT,
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_by_type TEXT,
  ADD COLUMN IF NOT EXISTS pinned_by_ref TEXT;

UPDATE doctor_task_messages
   SET delivered_at = COALESCE(delivered_at, created_at)
 WHERE delivered_at IS NULL;

ALTER TABLE doctor_task_messages
  ALTER COLUMN delivered_at SET DEFAULT NOW(),
  ALTER COLUMN delivered_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS doctor_task_message_deletions (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id UUID NOT NULL REFERENCES doctor_task_messages(id) ON DELETE CASCADE,
  viewer_type TEXT NOT NULL CHECK (viewer_type IN ('patient', 'doctor')),
  viewer_ref TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, task_id, message_id, viewer_type, viewer_ref)
);

CREATE INDEX IF NOT EXISTS doctor_task_message_deletions_viewer_idx
  ON doctor_task_message_deletions(tenant_id, task_id, viewer_type, viewer_ref, deleted_at DESC);

CREATE TABLE IF NOT EXISTS doctor_task_typing_indicators (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('patient', 'doctor')),
  actor_ref TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, task_id, actor_type, actor_ref)
);

CREATE INDEX IF NOT EXISTS doctor_task_typing_expiry_idx
  ON doctor_task_typing_indicators(expires_at);
