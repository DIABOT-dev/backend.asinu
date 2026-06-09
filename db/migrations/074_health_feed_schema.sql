CREATE TABLE IF NOT EXISTS health_feed_content_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_type TEXT NOT NULL DEFAULT 'article',
  target_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_flow TEXT NOT NULL,
  target_cluster_key TEXT,
  topic_category TEXT,
  flow_step INTEGER,
  severity_level TEXT NOT NULL DEFAULT 'low',
  engagement_score INTEGER NOT NULL DEFAULT 50,
  shareable BOOLEAN NOT NULL DEFAULT TRUE,
  saveable BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active',
  action_label TEXT,
  action_target TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_feed_content_items_flow
  ON health_feed_content_items(target_flow, status);

CREATE INDEX IF NOT EXISTS idx_health_feed_content_items_topic
  ON health_feed_content_items(topic_category, status);

CREATE TABLE IF NOT EXISTS health_feed_user_flow (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_flow TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  flow_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_content_at TIMESTAMPTZ,
  last_content_topic TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_feed_feed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES health_feed_content_items(id) ON DELETE CASCADE,
  patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  feed_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  action_label TEXT,
  action_target TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_feed_feed_items_active_user
  ON health_feed_feed_items(user_id, priority DESC, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_health_feed_feed_items_user_expires
  ON health_feed_feed_items(user_id, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_health_feed_feed_items_user_content_self
  ON health_feed_feed_items(user_id, content_id)
  WHERE patient_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_health_feed_feed_items_user_content_patient
  ON health_feed_feed_items(user_id, content_id, patient_id)
  WHERE patient_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS health_feed_notification_templates (
  id TEXT PRIMARY KEY,
  target_flow TEXT NOT NULL,
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_feed_notification_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_item_id UUID NOT NULL REFERENCES health_feed_feed_items(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES health_feed_notification_templates(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_health_feed_notification_jobs_feed_item
  ON health_feed_notification_jobs(feed_item_id);

CREATE INDEX IF NOT EXISTS idx_health_feed_notification_jobs_pending
  ON health_feed_notification_jobs(status, scheduled_for)
  WHERE dispatched_at IS NULL;

CREATE TABLE IF NOT EXISTS health_feed_saved_content (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES health_feed_content_items(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, content_id)
);

CREATE TABLE IF NOT EXISTS health_feed_content_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES health_feed_content_items(id) ON DELETE CASCADE,
  feed_item_id UUID REFERENCES health_feed_feed_items(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_feed_content_events_user_created
  ON health_feed_content_events(user_id, created_at DESC);
