-- The active Asinu assistant keeps one explicit rating per answer.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, message_id
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS position
  FROM chat_feedback
  WHERE feedback_type IN ('like', 'dislike') AND message_id LIKE 'asinu-assistant:%'
)
DELETE FROM chat_feedback
USING ranked
WHERE chat_feedback.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_feedback_assistant_rating
  ON chat_feedback(user_id, message_id)
  WHERE feedback_type IN ('like', 'dislike') AND message_id LIKE 'asinu-assistant:%';
