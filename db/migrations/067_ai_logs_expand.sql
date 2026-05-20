-- Expand ai_logs to support per-provider cost tracking.
-- Required by MVP audit (FIX #3) so we can break down AI spend by feature
-- and migrate clinical traffic from OpenAI to MedGemma without losing
-- observability.

ALTER TABLE ai_logs
  ADD COLUMN IF NOT EXISTS feature        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS action         VARCHAR(64),
  ADD COLUMN IF NOT EXISTS provider       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS input_tokens   INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(12, 6),
  ADD COLUMN IF NOT EXISTS success        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS latency_ms     INTEGER;

-- Backfill latency_ms from existing duration_ms so dashboards keep working.
UPDATE ai_logs
   SET latency_ms = duration_ms
 WHERE latency_ms IS NULL AND duration_ms IS NOT NULL;

-- Backfill success = FALSE for historical rows with an error message.
UPDATE ai_logs
   SET success = FALSE
 WHERE error IS NOT NULL AND error <> '';

-- Indexes for monthly cost rollups and per-user feature breakdowns.
CREATE INDEX IF NOT EXISTS idx_ai_logs_feature_month
  ON ai_logs (feature, DATE_TRUNC('month', created_at));
CREATE INDEX IF NOT EXISTS idx_ai_logs_user_feature
  ON ai_logs (user_id, feature, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_logs_provider_month
  ON ai_logs (provider, DATE_TRUNC('month', created_at));
