CREATE TABLE IF NOT EXISTS ai_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type VARCHAR(30) NOT NULL, -- 'triage', 'chat', 'onboarding'
  model VARCHAR(50),
  prompt_summary TEXT, -- first 500 chars of prompt (don't store full for privacy)
  response_summary TEXT, -- first 1000 chars of response
  tokens_used INTEGER,
  duration_ms INTEGER,
  is_fallback BOOLEAN DEFAULT FALSE,
  safety_filtered BOOLEAN DEFAULT FALSE,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_type ON ai_logs(type, created_at DESC);
