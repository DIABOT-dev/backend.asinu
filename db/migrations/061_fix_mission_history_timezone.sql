-- ═══════════════════════════════════════════════════════════════════════════
-- 061: Fix mission_history timezone bug (L1)
-- ═══════════════════════════════════════════════════════════════════════════
-- Bug:
--   Trigger save_completed_mission_to_history() ở migration 015 dùng
--   `CURRENT_DATE` (UTC) để ghi `completed_date`. PG server chạy timezone=UTC
--   (default), nên user log mission lúc 0h-7h sáng VN (= 17h-23h UTC hôm
--   trước) bị ghi nhận sang ngày HÔM TRƯỚC theo UTC.
--
--   Hệ quả: streak counting bị off-by-one, notification streak_7/14/30
--   fire sai ngày, tree score giảm oan, báo cáo tuần cho caregiver lệch.
--
-- Fix:
--   Override trigger function dùng `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`
--   để ghi đúng ngày VN bất kể server timezone.
--
--   Cũng update DEFAULT của column completed_date theo cùng pattern (cho
--   trường hợp INSERT manual không qua trigger).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Override trigger function — dùng VN timezone
CREATE OR REPLACE FUNCTION save_completed_mission_to_history()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
    INSERT INTO mission_history (user_id, mission_key, completed_date, progress, goal)
    VALUES (
      NEW.user_id,
      NEW.mission_key,
      (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
      NEW.progress,
      NEW.goal
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Update DEFAULT cho column completed_date (dùng cho manual INSERT)
ALTER TABLE mission_history
  ALTER COLUMN completed_date
  SET DEFAULT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;

-- 3. Verify (tuỳ chọn — comment out trong prod nếu không cần log)
-- SELECT 'Trigger updated. Test:' AS msg,
--        CURRENT_DATE AS pg_current_date_utc,
--        (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date,
--        NOW() AS now_utc;
