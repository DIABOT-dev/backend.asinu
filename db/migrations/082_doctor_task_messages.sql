-- Canonical patient/doctor conversation history. Message content remains in
-- ASINU; Doctor only accesses a thread after proving ownership of its task.
CREATE TABLE IF NOT EXISTS doctor_task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('patient', 'doctor')),
  sender_ref TEXT,
  message_type TEXT NOT NULL DEFAULT 'reply'
    CHECK (message_type IN ('question', 'consultation', 'reply', 'follow_up')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 5000),
  client_message_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, task_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS doctor_task_messages_thread_idx
  ON doctor_task_messages(tenant_id, task_id, created_at, id);

CREATE INDEX IF NOT EXISTS doctor_task_messages_user_idx
  ON doctor_task_messages(user_id, created_at DESC);
