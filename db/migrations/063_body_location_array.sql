-- Migration 063: Convert body_location TEXT → body_locations TEXT[]
--
-- T2 Multi-location: 1 user có thể khó chịu nhiều vùng cùng lúc (vd: tăng
-- huyết áp gây đau đầu + đau ngực; cảm cúm gây đau toàn thân + đau họng).
-- Schema cũ TEXT chỉ chứa 1 → mất context → triage AI hẹp.
--
-- Backward compat: giữ column body_location cũ, không drop. App cũ vẫn đọc OK.
-- Phải copy data sang body_locations array khi migrate.

-- 1. Add column mới (plural, array)
ALTER TABLE health_checkins
  ADD COLUMN IF NOT EXISTS body_locations TEXT[] DEFAULT NULL;

-- 2. Backfill: nếu body_location (single) có value → migrate sang body_locations array
UPDATE health_checkins
SET body_locations = ARRAY[body_location]
WHERE body_location IS NOT NULL AND body_locations IS NULL;

-- 3. Add CHECK constraint cho mỗi element của array
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'health_checkins_body_locations_check'
  ) THEN
    ALTER TABLE health_checkins
      ADD CONSTRAINT health_checkins_body_locations_check
      CHECK (
        body_locations IS NULL
        OR body_locations <@ ARRAY['head', 'chest', 'abdomen', 'limbs', 'skin', 'whole_body', 'mental']::TEXT[]
      );
  END IF;
END $$;

-- 4. Free-text "other" location — user gõ tự do nếu không match 7 enum
ALTER TABLE health_checkins
  ADD COLUMN IF NOT EXISTS body_location_other TEXT DEFAULT NULL;

-- 5. Index GIN cho query theo location
CREATE INDEX IF NOT EXISTS idx_health_checkins_body_locations
  ON health_checkins USING GIN (body_locations);

COMMENT ON COLUMN health_checkins.body_locations IS
  'Array các vùng cơ thể user khó chịu (T2 multi-select). Element values: head/chest/abdomen/limbs/skin/whole_body/mental.';
COMMENT ON COLUMN health_checkins.body_location_other IS
  'Free-text user gõ thêm nếu options chưa đủ (vd: "đau lưng dưới", "tê môi"). AI sẽ parse vào triage.';
