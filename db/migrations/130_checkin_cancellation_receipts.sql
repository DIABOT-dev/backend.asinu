CREATE TABLE IF NOT EXISTS health_checkin_cancellations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id BIGINT NOT NULL,
  phase_id TEXT NOT NULL CHECK (length(phase_id) BETWEEN 1 AND 160),
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, checkin_id, phase_id)
);
-- The receipt deliberately survives deletion of its cancelled interview row.
