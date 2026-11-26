ALTER TABLE doctor_task_message_reactions
  DROP CONSTRAINT doctor_task_message_reactions_emoji_check,
  ADD CONSTRAINT doctor_task_message_reactions_emoji_check
    CHECK (emoji IN ('👍', '❤️', '😊', '😂', '😆', '😍', '😮', '😕', '😢', '😡', '🙏', '👏'));
