CREATE TABLE IF NOT EXISTS patient_health_timeline_documents (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL DEFAULT 'health-timeline.md',
  content_markdown TEXT NOT NULL DEFAULT '',
  checkin_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

