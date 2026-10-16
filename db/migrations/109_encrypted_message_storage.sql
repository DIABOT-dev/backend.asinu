-- Public API limits remain 5,000 characters. UTF-8 + AES-GCM + base64url needs
-- additional storage space; preserve the original bound for legacy plaintext.
ALTER TABLE doctor_task_messages DROP CONSTRAINT IF EXISTS doctor_task_messages_content_check;
ALTER TABLE doctor_task_messages ADD CONSTRAINT doctor_task_messages_content_check
  CHECK (
    (content LIKE 'asinu:enc:v1:%' AND char_length(content) BETWEEN 51 AND 32768)
    OR (content NOT LIKE 'asinu:enc:v1:%' AND char_length(content) BETWEEN 1 AND 5000)
  );
