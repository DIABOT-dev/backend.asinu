-- Chat feedback: like, dislike, note per AI message
CREATE TABLE IF NOT EXISTS chat_feedback (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id       VARCHAR(255) NOT NULL,
  message_text     TEXT NOT NULL,
  feedback_type    VARCHAR(20) NOT NULL CHECK (feedback_type IN ('like', 'dislike', 'note')),
  note_text        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_feedback_user_type  ON chat_feedback(user_id, feedback_type);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_message    ON chat_feedback(user_id, message_id);
