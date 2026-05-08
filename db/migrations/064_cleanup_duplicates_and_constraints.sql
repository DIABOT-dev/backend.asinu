-- 064: Clean up data duplicates and prevent recurrence with UNIQUE constraints
--
-- Verified bugs (as of 2026-05-08):
--   notifications:    19 cross-hour dupes (e.g. user 4 got 12x checkin_followup_urgent
--                     across 4 days — orchestrator cooldown bypassed somehow)
--   script_sessions:  438 orphan rows (checkin_id NULL, all dated 2026-04-11..04-13);
--                     last 7 days are clean → bug already fixed, only leftover data
--   logs_common:      28 dupes (same user/log_type/occurred_at)
--   symptom_logs:     7 dupes (same user/symptom/day)
--
-- Strategy: keep oldest record (smallest id), delete the rest. Add partial
-- UNIQUE indexes where the duplicate is unambiguously a bug.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) script_sessions  — drop old orphans (checkin_id NULL, >7 days old)
--    Add partial unique on (checkin_id, session_type) to stop the cron-loop
--    bug from recurring once checkin_id is set.
-- ---------------------------------------------------------------------------
DELETE FROM script_sessions
WHERE checkin_id IS NULL
  AND created_at < NOW() - INTERVAL '7 days';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_script_sessions_checkin_type
  ON script_sessions (checkin_id, session_type)
  WHERE checkin_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) logs_common — same (user_id, log_type, occurred_at) is always a dup.
--    Cascades to glucose_logs / meal_logs / etc. via ON DELETE CASCADE.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, log_type, occurred_at
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM logs_common
  WHERE user_id IS NOT NULL
)
DELETE FROM logs_common
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_logs_common_user_type_occurred
  ON logs_common (user_id, log_type, occurred_at)
  WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) symptom_logs — one (user, symptom, day) row.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, symptom_name, occurred_date
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM symptom_logs
)
DELETE FROM symptom_logs
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_symptom_logs_user_symptom_date
  ON symptom_logs (user_id, symptom_name, occurred_date);

-- ---------------------------------------------------------------------------
-- 4) notifications — clean dupes (same payload across DAY bucket).
--    No UNIQUE constraint added: legitimate notifications can share
--    user_id+type with different titles (e.g. care-circle invites). Re-occurrence
--    prevention belongs in app-level cooldown
--    (notificationOrchestrator.cooldownByPriority).
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, type, title, message,
                        date_trunc('day', created_at)
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM notifications
)
DELETE FROM notifications
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

COMMIT;
