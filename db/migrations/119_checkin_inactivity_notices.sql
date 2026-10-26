-- A receipt survives inbox deletion, so an uninterrupted absence produces
-- only one notice per connected recipient. A new check-in starts a new span.
CREATE TABLE IF NOT EXISTS checkin_inactivity_notices (
  subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inactive_since_date DATE NOT NULL,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subject_user_id, recipient_user_id, inactive_since_date)
);
