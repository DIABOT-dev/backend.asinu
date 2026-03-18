-- Migration: Switch from hour-only to HH:MM time strings + add afternoon, remove water
-- Store as TEXT "HH:MM" format for precise scheduling

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS morning_time TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS afternoon_time TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS evening_time TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS inferred_morning_time TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS inferred_afternoon_time TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS inferred_evening_time TEXT DEFAULT NULL;

-- Migrate existing hour values to HH:MM format
UPDATE user_notification_preferences
SET morning_time = LPAD(morning_hour::text, 2, '0') || ':00'
WHERE morning_hour IS NOT NULL AND morning_time IS NULL;

UPDATE user_notification_preferences
SET evening_time = LPAD(evening_hour::text, 2, '0') || ':00'
WHERE evening_hour IS NOT NULL AND evening_time IS NULL;

-- Migrate inferred values
UPDATE user_notification_preferences
SET inferred_morning_time = LPAD(inferred_morning_hour::text, 2, '0') || ':00'
WHERE inferred_morning_hour IS NOT NULL AND inferred_morning_time IS NULL;

UPDATE user_notification_preferences
SET inferred_evening_time = LPAD(inferred_evening_hour::text, 2, '0') || ':00'
WHERE inferred_evening_hour IS NOT NULL AND inferred_evening_time IS NULL;
