-- Optional voice personalization is separate from scheduling and entitlements.
CREATE TABLE IF NOT EXISTS checkin_call_voice_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
