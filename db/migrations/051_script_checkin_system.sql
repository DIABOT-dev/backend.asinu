-- 051_script_checkin_system.sql
-- Script-driven check-in system
-- AI tạo kịch bản → App chạy kịch bản → Backend tính toán → AI chỉ can thiệp khi có gì mới

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. PROBLEM CLUSTERS — nhóm triệu chứng user hay gặp
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS problem_clusters (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  cluster_key   TEXT NOT NULL,           -- 'headache', 'neck_pain', 'dizziness', ...
  display_name  TEXT NOT NULL,           -- 'Đau đầu', 'Đau cổ vai gáy', ...
  source        TEXT NOT NULL DEFAULT 'onboarding', -- 'onboarding' | 'checkin' | 'rnd_cycle' | 'fallback'

  -- Frequency tracking (updated by R&D cycle)
  count_7d      INTEGER NOT NULL DEFAULT 0,
  count_30d     INTEGER NOT NULL DEFAULT 0,
  trend         TEXT NOT NULL DEFAULT 'stable',  -- 'increasing' | 'stable' | 'decreasing'
  priority      INTEGER NOT NULL DEFAULT 0,      -- higher = ask first when multiple clusters

  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_triggered_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, cluster_key)
);

CREATE INDEX IF NOT EXISTS idx_problem_clusters_user
  ON problem_clusters(user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_problem_clusters_priority
  ON problem_clusters(user_id, priority DESC) WHERE is_active = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TRIAGE SCRIPTS — kịch bản hỏi được AI sinh ra, cache sẵn
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS triage_scripts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_id    BIGINT REFERENCES problem_clusters(id) ON DELETE SET NULL,

  cluster_key   TEXT NOT NULL,           -- 'headache', 'neck_pain', 'general_fallback'
  script_type   TEXT NOT NULL DEFAULT 'initial',  -- 'initial' | 'followup' | 'fallback'
  version       INTEGER NOT NULL DEFAULT 1,

  -- The full script JSON (questions, options, scoring rules, templates)
  script_data   JSONB NOT NULL,
  /*
    script_data structure:
    {
      "greeting": "Chào chú Hùng!",
      "questions": [
        {
          "id": "q1",
          "text": "Vai gáy hôm nay đau mức nào?",
          "type": "slider",        -- slider | single_choice | multi_choice | free_text
          "min": 0, "max": 10,
          "cluster": "neck_pain",
          "skip_if": { ... }       -- optional conditional skip
        }
      ],
      "scoring_rules": [
        {
          "conditions": [{"field": "q1", "op": "gte", "value": 7}],
          "combine": "and",
          "severity": "high",
          "follow_up_hours": 1,
          "needs_doctor": true,
          "needs_family_alert": true
        }
      ],
      "condition_modifiers": [
        {
          "user_condition": "tiểu đường",
          "extra_conditions": [{"field": "q1", "op": "gte", "value": 5}],
          "action": "bump_severity",
          "to": "high"
        }
      ],
      "conclusion_templates": {
        "low":    { "summary": "...", "recommendation": "...", "close_message": "..." },
        "medium": { ... },
        "high":   { ... }
      },
      "followup_questions": [...],
      "fallback_questions": [...]
    }
  */

  -- Metadata
  generated_by  TEXT DEFAULT 'system',   -- 'system' | 'medgemma' | 'gpt4o' | 'manual'
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,             -- NULL = never expires, R&D cycle refreshes

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- One active script per user+cluster+type combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_scripts_active
  ON triage_scripts(user_id, cluster_key, script_type)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_triage_scripts_user
  ON triage_scripts(user_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_triage_scripts_cluster
  ON triage_scripts(cluster_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. SCRIPT SESSIONS — tracking mỗi lần user chạy script
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS script_sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id    BIGINT REFERENCES health_checkins(id) ON DELETE SET NULL,
  script_id     BIGINT REFERENCES triage_scripts(id) ON DELETE SET NULL,

  cluster_key   TEXT NOT NULL,
  session_type  TEXT NOT NULL DEFAULT 'initial',  -- 'initial' | 'followup'

  -- Answers: [{ question_id, answer, answered_at }]
  answers       JSONB NOT NULL DEFAULT '[]',
  current_step  INTEGER NOT NULL DEFAULT 0,
  is_completed  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Scoring result (filled when completed)
  severity      TEXT,                    -- 'low' | 'medium' | 'high' | 'critical'
  score_details JSONB,                   -- { matched_rule_index, raw_scores, modifiers_applied }
  needs_doctor  BOOLEAN DEFAULT FALSE,
  needs_family_alert BOOLEAN DEFAULT FALSE,
  follow_up_hours NUMERIC(4,1),

  -- Conclusion (from template, no AI)
  conclusion_summary TEXT,
  conclusion_recommendation TEXT,
  conclusion_close_message TEXT,

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_script_sessions_user
  ON script_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_sessions_checkin
  ON script_sessions(checkin_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. FALLBACK LOGS — triệu chứng lạ, R&D cycle xử lý đêm
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fallback_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id    BIGINT REFERENCES health_checkins(id) ON DELETE SET NULL,

  raw_input     TEXT NOT NULL,           -- nguyên văn user nhập
  fallback_answers JSONB DEFAULT '[]',   -- câu trả lời fallback questions

  -- AI labeling (filled by R&D cycle at night)
  ai_label      TEXT,                    -- 'possible_tmj' | 'ear_infection' | ...
  ai_cluster_key TEXT,                   -- cluster key AI gợi ý
  ai_confidence NUMERIC(3,2),            -- 0.00-1.00

  -- Processing status
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processed' | 'merged'
  processed_at  TIMESTAMPTZ,
  merged_to_cluster_id BIGINT REFERENCES problem_clusters(id),

  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fallback_logs_pending
  ON fallback_logs(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fallback_logs_user
  ON fallback_logs(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RND CYCLE LOGS — log mỗi lần R&D cycle chạy
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rnd_cycle_logs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'

  -- Stats
  users_processed    INTEGER DEFAULT 0,
  fallbacks_processed INTEGER DEFAULT 0,
  clusters_created   INTEGER DEFAULT 0,
  clusters_updated   INTEGER DEFAULT 0,
  scripts_regenerated INTEGER DEFAULT 0,
  ai_calls_made      INTEGER DEFAULT 0,

  error_message TEXT,
  details       JSONB DEFAULT '{}'
);
