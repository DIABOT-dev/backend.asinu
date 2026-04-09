-- 053: Agent check-in memory
-- Cross-session memory for the check-in agent (separate from user_memories which is for chat AI)

CREATE TABLE IF NOT EXISTS agent_checkin_memory (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,  -- 'pattern' | 'preference' | 'insight' | 'warning'
  memory_key TEXT NOT NULL,   -- unique key per user+type
  content JSONB NOT NULL,
  confidence NUMERIC(3,2) DEFAULT 1.0,
  source TEXT DEFAULT 'system',  -- 'system' | 'rnd_cycle' | 'medgemma'
  is_active BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, memory_type, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_user
  ON agent_checkin_memory(user_id) WHERE is_active = TRUE;
