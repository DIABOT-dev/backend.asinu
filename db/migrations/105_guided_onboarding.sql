-- Onboarding progress belongs to the account, not a device. Epochs prevent
-- offline acknowledgements from undoing an explicit replay on another device.
CREATE TABLE IF NOT EXISTS user_guidance_progress (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('self', 'caregiver')),
  welcome_seen BOOLEAN NOT NULL DEFAULT FALSE,
  read_aloud BOOLEAN NOT NULL DEFAULT TRUE,
  first_checkin BOOLEAN NOT NULL DEFAULT FALSE,
  completed JSONB NOT NULL DEFAULT '{}'::jsonb,
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
