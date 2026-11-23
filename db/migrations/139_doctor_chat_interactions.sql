ALTER TABLE doctor_task_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID
    REFERENCES doctor_task_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS doctor_task_messages_reply_to_idx
  ON doctor_task_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS doctor_task_message_reactions (
  message_id UUID NOT NULL REFERENCES doctor_task_messages(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('patient', 'doctor')),
  actor_ref TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK (emoji IN ('👍', '❤️', '😊', '😮', '😢', '🙏')),
  PRIMARY KEY (message_id, actor_type, actor_ref)
);
