-- ============================================================
-- Seed test data for AI context system
-- User: id=1 (Dương Anh Đức)
-- Bệnh nền: Tiểu đường, Cao huyết áp
-- ============================================================

-- ─── 1. Symptom Logs (7 ngày gần nhất) ──────────────────────
-- Giả lập user bị chóng mặt + mệt mỏi nhiều lần trong tuần

INSERT INTO symptom_logs (user_id, checkin_id, symptom_name, severity, occurred_date) VALUES
-- Hôm nay
(1, 1, 'mệt mỏi', 'trung bình', CURRENT_DATE),
(1, 1, 'chóng mặt', 'trung bình', CURRENT_DATE),
(1, 1, 'ăn không ngon', NULL, CURRENT_DATE),
-- Hôm qua
(1, NULL, 'mệt mỏi', 'nhẹ', CURRENT_DATE - 1),
(1, NULL, 'chóng mặt', 'nhẹ', CURRENT_DATE - 1),
-- 2 ngày trước
(1, NULL, 'đau đầu', 'khá nặng', CURRENT_DATE - 2),
(1, NULL, 'mệt mỏi', 'khá nặng', CURRENT_DATE - 2),
-- 3 ngày trước
(1, NULL, 'mệt mỏi', 'trung bình', CURRENT_DATE - 3),
(1, NULL, 'khát nước', NULL, CURRENT_DATE - 3),
-- 4 ngày trước
(1, NULL, 'chóng mặt', 'nhẹ', CURRENT_DATE - 4),
-- 5 ngày trước
(1, NULL, 'mệt mỏi', 'nhẹ', CURRENT_DATE - 5),
(1, NULL, 'buồn nôn', 'nhẹ', CURRENT_DATE - 5),
-- 6 ngày trước — ổn, không có triệu chứng
-- 1 tuần trước
(1, NULL, 'mệt mỏi', 'trung bình', CURRENT_DATE - 7),
(1, NULL, 'đau đầu', 'trung bình', CURRENT_DATE - 7),
-- 10 ngày trước
(1, NULL, 'chóng mặt', 'nhẹ', CURRENT_DATE - 10),
-- 14 ngày trước
(1, NULL, 'mệt mỏi', 'nhẹ', CURRENT_DATE - 14),
(1, NULL, 'khát nước', NULL, CURRENT_DATE - 14),
-- 20 ngày trước
(1, NULL, 'đau đầu', 'trung bình', CURRENT_DATE - 20),
-- 25 ngày trước
(1, NULL, 'mệt mỏi', 'nhẹ', CURRENT_DATE - 25)
ON CONFLICT DO NOTHING;

-- ─── 2. Symptom Frequency (tổng hợp) ─────────────────────────

INSERT INTO symptom_frequency (user_id, symptom_name, count_7d, count_30d, trend, last_occurred) VALUES
(1, 'mệt mỏi',    5, 8, 'increasing', CURRENT_DATE),
(1, 'chóng mặt',  3, 5, 'increasing', CURRENT_DATE),
(1, 'đau đầu',    1, 3, 'stable',     CURRENT_DATE - 2),
(1, 'ăn không ngon', 1, 1, 'stable',  CURRENT_DATE),
(1, 'khát nước',   1, 2, 'stable',    CURRENT_DATE - 3),
(1, 'buồn nôn',   1, 1, 'decreasing', CURRENT_DATE - 5)
ON CONFLICT (user_id, symptom_name) DO UPDATE SET
  count_7d = EXCLUDED.count_7d,
  count_30d = EXCLUDED.count_30d,
  trend = EXCLUDED.trend,
  last_occurred = EXCLUDED.last_occurred,
  updated_at = NOW();

-- ─── 3. Medication Adherence (7 ngày) ────────────────────────
-- User có bệnh nền tiểu đường + huyết áp → cần uống thuốc hàng ngày
-- Pattern: bỏ 2 ngày trong tuần

INSERT INTO medication_adherence (user_id, medication_date, status, taken_at, notes) VALUES
(1, CURRENT_DATE,     'taken',   NOW(),                              NULL),
(1, CURRENT_DATE - 1, 'taken',   CURRENT_DATE - 1 + TIME '08:30',   NULL),
(1, CURRENT_DATE - 2, 'skipped', NULL,                               'Quên'),
(1, CURRENT_DATE - 3, 'taken',   CURRENT_DATE - 3 + TIME '09:00',   NULL),
(1, CURRENT_DATE - 4, 'taken',   CURRENT_DATE - 4 + TIME '08:15',   NULL),
(1, CURRENT_DATE - 5, 'skipped', NULL,                               'Hết thuốc'),
(1, CURRENT_DATE - 6, 'taken',   CURRENT_DATE - 6 + TIME '08:45',   NULL)
ON CONFLICT (user_id, medication_date) DO UPDATE SET
  status = EXCLUDED.status,
  taken_at = EXCLUDED.taken_at,
  notes = EXCLUDED.notes;

-- ─── 4. Triage Outcomes (lịch sử đánh giá trước) ─────────────
-- Giả lập: lần trước AI đánh giá medium nhưng user nói vẫn mệt

INSERT INTO triage_outcomes (checkin_id, user_id, ai_severity, ai_recommendation, actual_outcome, recommendation_helpful, user_note, outcome_date) VALUES
(1, 1, 'medium', 'Hãy nghỉ ngơi và theo dõi thêm', 'same', false, 'Vẫn mệt như cũ', CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- ─── 5. Thêm health_checkins lịch sử (giả lập nhiều ngày) ────
-- Để AI thấy pattern "user hay mệt liên tục"

INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state, triage_summary, triage_severity, triage_completed_at, created_at) VALUES
(1, CURRENT_DATE - 1, 'tired', 'tired', 'resolved',
 'mệt mỏi, chóng mặt từ sáng, đang đỡ dần', 'low',
 CURRENT_DATE - 1 + TIME '09:00', CURRENT_DATE - 1 + TIME '08:30'),

(1, CURRENT_DATE - 2, 'very_tired', 'very_tired', 'resolved',
 'đau đầu khá nặng, mệt mỏi, khát nước, từ hôm qua, nặng hơn', 'medium',
 CURRENT_DATE - 2 + TIME '10:00', CURRENT_DATE - 2 + TIME '09:00'),

(1, CURRENT_DATE - 3, 'tired', 'tired', 'resolved',
 'mệt mỏi trung bình, khát nước, ngủ ít', 'low',
 CURRENT_DATE - 3 + TIME '08:45', CURRENT_DATE - 3 + TIME '08:00'),

(1, CURRENT_DATE - 5, 'tired', 'tired', 'resolved',
 'mệt mỏi nhẹ, buồn nôn, bỏ bữa sáng', 'low',
 CURRENT_DATE - 5 + TIME '09:30', CURRENT_DATE - 5 + TIME '09:00'),

(1, CURRENT_DATE - 7, 'very_tired', 'very_tired', 'resolved',
 'mệt mỏi, đau đầu, chóng mặt, quên uống thuốc', 'medium',
 CURRENT_DATE - 7 + TIME '11:00', CURRENT_DATE - 7 + TIME '10:00')

ON CONFLICT (user_id, session_date) DO NOTHING;

-- ─── 6. Glucose logs (giả lập 7 ngày cho context) ────────────
-- User tiểu đường → glucose dao động cao

-- Cần logs_common entries trước
INSERT INTO logs_common (id, user_id, log_type, occurred_at) VALUES
(gen_random_uuid(), 1, 'glucose', NOW() - INTERVAL '1 hour'),
(gen_random_uuid(), 1, 'glucose', CURRENT_DATE - 1 + TIME '07:30'),
(gen_random_uuid(), 1, 'glucose', CURRENT_DATE - 2 + TIME '08:00'),
(gen_random_uuid(), 1, 'glucose', CURRENT_DATE - 3 + TIME '07:45'),
(gen_random_uuid(), 1, 'glucose', CURRENT_DATE - 5 + TIME '08:15')
ON CONFLICT DO NOTHING;

-- Insert glucose values
INSERT INTO glucose_logs (log_id, value, unit, context)
SELECT id, v.value, 'mg/dL', v.context
FROM logs_common lc
CROSS JOIN LATERAL (
  VALUES
    (CASE
      WHEN lc.occurred_at::date = CURRENT_DATE THEN 185
      WHEN lc.occurred_at::date = CURRENT_DATE - 1 THEN 165
      WHEN lc.occurred_at::date = CURRENT_DATE - 2 THEN 210
      WHEN lc.occurred_at::date = CURRENT_DATE - 3 THEN 155
      ELSE 170
    END,
    CASE
      WHEN lc.occurred_at::date = CURRENT_DATE THEN 'trước ăn'
      WHEN lc.occurred_at::date = CURRENT_DATE - 2 THEN 'sau ăn'
      ELSE 'trước ăn'
    END)
) AS v(value, context)
WHERE lc.user_id = 1 AND lc.log_type = 'glucose'
ON CONFLICT DO NOTHING;

-- ─── 7. Blood pressure logs (giả lập) ────────────────────────

INSERT INTO logs_common (id, user_id, log_type, occurred_at) VALUES
(gen_random_uuid(), 1, 'blood_pressure', NOW() - INTERVAL '2 hours'),
(gen_random_uuid(), 1, 'blood_pressure', CURRENT_DATE - 1 + TIME '08:00'),
(gen_random_uuid(), 1, 'blood_pressure', CURRENT_DATE - 3 + TIME '07:30')
ON CONFLICT DO NOTHING;

INSERT INTO blood_pressure_logs (log_id, systolic, diastolic, pulse)
SELECT id,
  CASE
    WHEN lc.occurred_at::date = CURRENT_DATE THEN 145
    WHEN lc.occurred_at::date = CURRENT_DATE - 1 THEN 138
    ELSE 142
  END,
  CASE
    WHEN lc.occurred_at::date = CURRENT_DATE THEN 92
    WHEN lc.occurred_at::date = CURRENT_DATE - 1 THEN 88
    ELSE 90
  END,
  CASE
    WHEN lc.occurred_at::date = CURRENT_DATE THEN 78
    WHEN lc.occurred_at::date = CURRENT_DATE - 1 THEN 75
    ELSE 80
  END
FROM logs_common lc
WHERE lc.user_id = 1 AND lc.log_type = 'blood_pressure'
ON CONFLICT DO NOTHING;

-- ─── Done ─────────────────────────────────────────────────────
-- Verify data:
SELECT 'symptom_logs' as tbl, count(*) FROM symptom_logs WHERE user_id = 1
UNION ALL
SELECT 'symptom_frequency', count(*) FROM symptom_frequency WHERE user_id = 1
UNION ALL
SELECT 'medication_adherence', count(*) FROM medication_adherence WHERE user_id = 1
UNION ALL
SELECT 'triage_outcomes', count(*) FROM triage_outcomes WHERE user_id = 1
UNION ALL
SELECT 'health_checkins', count(*) FROM health_checkins WHERE user_id = 1
UNION ALL
SELECT 'glucose_logs', count(*) FROM glucose_logs gl JOIN logs_common lc ON lc.id = gl.log_id WHERE lc.user_id = 1
UNION ALL
SELECT 'bp_logs', count(*) FROM blood_pressure_logs bp JOIN logs_common lc ON lc.id = bp.log_id WHERE lc.user_id = 1;
