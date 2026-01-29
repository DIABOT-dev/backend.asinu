-- 007_wellness_monitoring_system.sql
-- Hệ thống theo dõi sức khỏe và thói quen người dùng
-- Gồm: Activity logs, Health scores, Caregiver alerts

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- 1. BẢNG GHI LẠI HOẠT ĐỘNG NGƯỜI DÙNG (user_activity_logs)
-- Lưu mọi hoạt động: mở app, mood check-in, số đo sức khỏe
-- =====================================================
CREATE TABLE IF NOT EXISTS user_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  activity_type TEXT NOT NULL, -- 'APP_OPEN', 'MOOD_CHECK', 'HEALTH_MEASUREMENT', 'QUESTION_ANSWERED', 'QUESTION_SKIPPED'
  activity_data JSONB DEFAULT '{}'::jsonb, -- Chi tiết: mood, measurement values, question_id, etc.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT, -- Để group các hoạt động trong 1 session
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_date 
  ON user_activity_logs (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_type 
  ON user_activity_logs (user_id, activity_type, occurred_at DESC);

-- =====================================================
-- 2. BẢNG ĐIỂM SỨC KHỎE (user_health_scores)
-- Lưu điểm wellness 0-100 và trạng thái
-- =====================================================
CREATE TYPE wellness_status AS ENUM ('OK', 'MONITOR', 'CONCERN', 'DANGER');

CREATE TABLE IF NOT EXISTS user_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100), -- Điểm 0-100
  status wellness_status NOT NULL, -- OK (80-100), MONITOR (60-79), CONCERN (40-59), DANGER (<40)
  previous_score INTEGER, -- Điểm lần trước để so sánh
  previous_status wellness_status,
  score_breakdown JSONB DEFAULT '{}'::jsonb, -- Chi tiết cách tính: {consistency: 20, mood: 30, engagement: 25, health: 25}
  triggered_by TEXT, -- 'activity', 'scheduled', 'manual'
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ, -- Score hết hạn sau khoảng thời gian
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_health_scores_user_date 
  ON user_health_scores (user_id, calculated_at DESC);

-- Lấy score mới nhất của user
CREATE INDEX IF NOT EXISTS idx_user_health_scores_latest 
  ON user_health_scores (user_id, created_at DESC);

-- =====================================================
-- 3. BẢNG TRẠNG THÁI HIỆN TẠI CỦA USER (user_wellness_state)
-- Lưu trạng thái realtime, dùng để quyết định có hỏi hay không
-- =====================================================
CREATE TABLE IF NOT EXISTS user_wellness_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  current_score INTEGER DEFAULT 80,
  current_status wellness_status DEFAULT 'OK',
  last_score_at TIMESTAMPTZ,
  last_prompt_at TIMESTAMPTZ, -- Lần cuối hỏi user
  last_response_at TIMESTAMPTZ, -- Lần cuối user trả lời
  consecutive_no_response INTEGER DEFAULT 0, -- Số lần liên tiếp không trả lời
  consecutive_negative_mood INTEGER DEFAULT 0, -- Số lần liên tiếp mood xấu
  app_opens_today INTEGER DEFAULT 0, -- Số lần mở app hôm nay
  last_app_open_date DATE, -- Ngày mở app gần nhất (để reset counter)
  streak_days INTEGER DEFAULT 0, -- Số ngày liên tiếp active
  last_active_date DATE, -- Để tính streak
  needs_attention BOOLEAN DEFAULT FALSE, -- Cần người thân chú ý?
  attention_reason TEXT, -- Lý do cần chú ý
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 4. BẢNG THÔNG BÁO NGƯỜI THÂN (caregiver_alerts)
-- Lưu các lần thông báo đến người thân
-- =====================================================
CREATE TYPE alert_type AS ENUM ('INFO', 'WARNING', 'URGENT', 'EMERGENCY');
CREATE TYPE alert_status AS ENUM ('pending', 'sent', 'read', 'acknowledged', 'dismissed');

CREATE TABLE IF NOT EXISTS caregiver_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id), -- User được theo dõi
  caregiver_user_id INTEGER REFERENCES users(id), -- Người thân nhận alert
  connection_id UUID REFERENCES user_connections(id),
  alert_type alert_type NOT NULL,
  alert_status alert_status DEFAULT 'pending',
  title TEXT NOT NULL,
  message TEXT NOT NULL, -- "Mấy hôm nay anh ấy sinh hoạt khác thường."
  context_data JSONB DEFAULT '{}'::jsonb, -- Thêm chi tiết: scores, activities
  triggered_by TEXT, -- 'low_score', 'no_response', 'negative_mood', 'user_request'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_caregiver_alerts_user 
  ON caregiver_alerts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_caregiver_alerts_caregiver 
  ON caregiver_alerts (caregiver_user_id, alert_status, created_at DESC);

-- =====================================================
-- 5. BẢNG CẤU HÌNH THEO DÕI (wellness_monitoring_config)
-- Cấu hình ngưỡng và tần suất cho từng user
-- =====================================================
CREATE TABLE IF NOT EXISTS wellness_monitoring_config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  -- Ngưỡng điểm cho từng status
  ok_threshold INTEGER DEFAULT 80, -- >= 80 = OK
  monitor_threshold INTEGER DEFAULT 60, -- >= 60 = MONITOR
  concern_threshold INTEGER DEFAULT 40, -- >= 40 = CONCERN
  -- < 40 = DANGER
  
  -- Cấu hình prompt
  prompt_cooldown_minutes INTEGER DEFAULT 120, -- Không hỏi lại trong 2 tiếng
  max_prompts_per_day INTEGER DEFAULT 4, -- Tối đa 4 lần/ngày
  
  -- Cấu hình alert người thân
  alert_after_no_response INTEGER DEFAULT 3, -- Alert sau 3 lần không trả lời
  alert_on_danger BOOLEAN DEFAULT TRUE, -- Tự động alert khi DANGER
  alert_cooldown_hours INTEGER DEFAULT 24, -- Không alert lại trong 24h
  
  -- Weights cho tính điểm (tổng = 100)
  weight_consistency INTEGER DEFAULT 25, -- Điểm đều đặn sử dụng
  weight_mood INTEGER DEFAULT 30, -- Điểm mood
  weight_engagement INTEGER DEFAULT 20, -- Điểm tương tác
  weight_health_data INTEGER DEFAULT 25, -- Điểm số đo sức khỏe
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 6. BẢNG LỊCH SỬ PROMPT (prompt_history)
-- Theo dõi các lần hệ thống hỏi user
-- =====================================================
CREATE TABLE IF NOT EXISTS prompt_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  prompt_type TEXT NOT NULL, -- 'mood_check', 'follow_up', 'health_reminder'
  prompt_message TEXT, -- Nội dung câu hỏi
  triggered_reason TEXT, -- Lý do hỏi: 'scheduled', 'status_change', 'no_activity'
  response_status TEXT DEFAULT 'pending', -- 'pending', 'answered', 'dismissed', 'expired'
  response_data JSONB, -- Câu trả lời nếu có
  prompted_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ -- Hết hạn sau 1 tiếng nếu không trả lời
);

CREATE INDEX IF NOT EXISTS idx_prompt_history_user 
  ON prompt_history (user_id, prompted_at DESC);

-- =====================================================
-- 7. BẢNG THỐNG KÊ HÀNG NGÀY (daily_wellness_summary)
-- Tổng hợp hoạt động theo ngày để tính trend
-- =====================================================
CREATE TABLE IF NOT EXISTS daily_wellness_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  summary_date DATE NOT NULL,
  
  -- Thống kê hoạt động
  app_opens INTEGER DEFAULT 0,
  mood_checks INTEGER DEFAULT 0,
  questions_answered INTEGER DEFAULT 0,
  questions_skipped INTEGER DEFAULT 0,
  health_measurements INTEGER DEFAULT 0,
  
  -- Mood data
  mood_positive INTEGER DEFAULT 0, -- Số lần "ổn"
  mood_neutral INTEGER DEFAULT 0, -- Số lần "hơi mệt"
  mood_negative INTEGER DEFAULT 0, -- Số lần "không ổn"
  
  -- Health measurements averages (nếu có)
  avg_glucose NUMERIC(10,2),
  avg_blood_pressure_systolic INTEGER,
  avg_blood_pressure_diastolic INTEGER,
  avg_weight NUMERIC(6,2),
  total_water_ml INTEGER,
  
  -- Score cuối ngày
  end_of_day_score INTEGER,
  end_of_day_status wellness_status,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_wellness_summary_user_date 
  ON daily_wellness_summary (user_id, summary_date DESC);
