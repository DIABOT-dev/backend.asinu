-- DB Snapshot v1.2 (PENDING)
-- Status: NOT RUN (blocked)
-- Reason: No VPS access / DATABASE_URL / SSH credentials available in this environment.

-- Required on VPS:
-- 1) Schema (chat_histories + user_missions)
\d+ chat_histories;
\d+ user_missions;

-- 2) Last 20 rows
SELECT * FROM chat_histories ORDER BY created_at DESC LIMIT 20;
SELECT * FROM user_missions ORDER BY updated_at DESC LIMIT 20;
