-- 054: User Lifecycle Segmentation
-- Phân nhóm user theo mức độ hoạt động để tối ưu tài nguyên

CREATE TABLE IF NOT EXISTS user_lifecycle (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  segment       VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (segment IN ('active', 'semi_active', 'inactive', 'churned')),
  last_checkin_at   TIMESTAMPTZ,
  last_app_open_at  TIMESTAMPTZ,
  inactive_days     INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index cho query theo segment (dùng trong R&D cycle filter)
CREATE INDEX IF NOT EXISTS idx_user_lifecycle_segment ON user_lifecycle(segment);

-- Seed: populate từ health_checkins hiện có
INSERT INTO user_lifecycle (user_id, last_checkin_at, inactive_days, segment)
SELECT
  u.id,
  MAX(hc.session_date)::timestamptz AS last_checkin_at,
  COALESCE(
    EXTRACT(DAY FROM NOW() - MAX(hc.session_date)::timestamptz)::int,
    999
  ) AS inactive_days,
  CASE
    WHEN MAX(hc.session_date) IS NULL THEN 'inactive'
    WHEN NOW() - MAX(hc.session_date)::timestamptz <= INTERVAL '1 day' THEN 'active'
    WHEN NOW() - MAX(hc.session_date)::timestamptz <= INTERVAL '3 days' THEN 'semi_active'
    WHEN NOW() - MAX(hc.session_date)::timestamptz <= INTERVAL '7 days' THEN 'inactive'
    ELSE 'churned'
  END AS segment
FROM users u
LEFT JOIN health_checkins hc ON hc.user_id = u.id
GROUP BY u.id
ON CONFLICT (user_id) DO NOTHING;
