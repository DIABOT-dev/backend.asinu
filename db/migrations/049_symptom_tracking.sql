-- 049: Symptom tracking tables for AI context
-- Giúp AI nhớ triệu chứng user qua nhiều ngày, phát hiện pattern

-- 1. Lưu từng triệu chứng từ mỗi lần triage (extract từ triage_messages)
CREATE TABLE IF NOT EXISTS symptom_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_id BIGINT REFERENCES health_checkins(id) ON DELETE SET NULL,
  symptom_name TEXT NOT NULL,          -- 'chóng mặt', 'đau đầu', 'mệt mỏi'
  severity TEXT,                        -- 'nhẹ', 'trung bình', 'khá nặng', 'rất nặng'
  occurred_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symptom_logs_user_date ON symptom_logs(user_id, occurred_date DESC);
CREATE INDEX IF NOT EXISTS idx_symptom_logs_user_symptom ON symptom_logs(user_id, symptom_name, occurred_date DESC);

-- 2. Tần suất triệu chứng tổng hợp (cập nhật bởi cron hoặc sau mỗi triage)
CREATE TABLE IF NOT EXISTS symptom_frequency (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symptom_name TEXT NOT NULL,
  count_7d INT DEFAULT 0,               -- số lần xuất hiện trong 7 ngày
  count_30d INT DEFAULT 0,              -- số lần xuất hiện trong 30 ngày
  trend TEXT DEFAULT 'stable',           -- 'increasing' | 'stable' | 'decreasing'
  last_occurred DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, symptom_name)
);

-- 3. Theo dõi kết quả triage (user feedback sau đó)
CREATE TABLE IF NOT EXISTS triage_outcomes (
  id BIGSERIAL PRIMARY KEY,
  checkin_id BIGINT NOT NULL REFERENCES health_checkins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_severity TEXT,                      -- severity AI đánh giá
  ai_recommendation TEXT,                -- recommendation AI đưa ra
  actual_outcome TEXT,                   -- 'improved' | 'same' | 'worsened' | 'saw_doctor'
  recommendation_helpful BOOLEAN,
  user_note TEXT,
  outcome_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triage_outcomes_user ON triage_outcomes(user_id, created_at DESC);

-- 4. Lịch sử uống thuốc chi tiết (thay vì binary hôm nay)
CREATE TABLE IF NOT EXISTS medication_adherence (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown', -- 'taken' | 'skipped' | 'late' | 'unknown'
  taken_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, medication_date)
);

CREATE INDEX IF NOT EXISTS idx_med_adherence_user_date ON medication_adherence(user_id, medication_date DESC);
