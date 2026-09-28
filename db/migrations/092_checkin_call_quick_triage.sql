ALTER TABLE checkin_call_episodes
  ADD COLUMN IF NOT EXISTS issue_category TEXT;

ALTER TABLE checkin_call_episodes
  DROP CONSTRAINT IF EXISTS checkin_call_issue_category_check;

ALTER TABLE checkin_call_episodes
  ADD CONSTRAINT checkin_call_issue_category_check CHECK (
    issue_category IS NULL OR issue_category IN (
      'MILD_FATIGUE',
      'MILD_DIZZY',
      'MILD_PAIN',
      'MILD_UNSPECIFIED',
      'URGENT_RED_FLAG',
      'URGENT_UNSPECIFIED',
      'UNKNOWN'
    )
  );
