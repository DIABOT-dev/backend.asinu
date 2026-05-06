-- Migration 062: Add body_location to health_checkins + allow severity='emergency'
--
-- Tầng 2 Self Check-in design (T1 status → T2 location → T3 chief complaint):
--   - body_location: vùng cơ thể user khó chịu, dùng để filter T3 dynamic options
--     và inject vào AI prompt context để câu hỏi tập trung
--   - Allow triage_severity='emergency' (level cao nhất, AI/red-flag detect →
--     escalate khác với SOS button trigger qua emergency_triggered=true)
--
-- Backward compat: column nullable, existing rows giữ nguyên.

ALTER TABLE health_checkins
  ADD COLUMN IF NOT EXISTS body_location TEXT
  CHECK (body_location IS NULL OR body_location IN (
    'head', 'chest', 'abdomen', 'limbs', 'skin', 'whole_body', 'mental'
  ));

COMMENT ON COLUMN health_checkins.body_location IS
  'Vùng cơ thể từ T2 Location screen. Dùng để filter triệu chứng T3 + inject vào AI prompt.';

-- triage_severity hiện là TEXT (không enum), không cần ALTER TYPE.
-- Logic backend sẽ update để chấp nhận 'emergency' bên cạnh low/medium/high.
-- Add CHECK để enforce values hợp lệ:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'health_checkins_triage_severity_check'
  ) THEN
    ALTER TABLE health_checkins
      ADD CONSTRAINT health_checkins_triage_severity_check
      CHECK (triage_severity IS NULL OR triage_severity IN (
        'low', 'medium', 'high', 'emergency'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_health_checkins_body_location
  ON health_checkins(body_location)
  WHERE body_location IS NOT NULL;
