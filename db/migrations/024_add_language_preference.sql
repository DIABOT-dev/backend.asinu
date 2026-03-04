ALTER TABLE users
ADD COLUMN IF NOT EXISTS language_preference VARCHAR(2) DEFAULT 'vi'
  CHECK (language_preference IN ('vi', 'en'));

COMMENT ON COLUMN users.language_preference IS 'User preferred language for push notifications';
