-- 055: Script Reuse Tracking
-- Phase 6 #15: Theo dõi việc reuse cached scripts khi user inactive quay lại
-- Mục đích: tiết kiệm AI calls + đo lường hiệu quả cache

ALTER TABLE triage_scripts
  ADD COLUMN IF NOT EXISTS reuse_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reused_at TIMESTAMPTZ;

-- Index để query fast script đã reuse nhiều
CREATE INDEX IF NOT EXISTS idx_triage_scripts_reuse_count
  ON triage_scripts(reuse_count DESC) WHERE is_active = TRUE;

-- ─── Add columns to rnd_cycle_logs for priority compute metrics ────────────
ALTER TABLE rnd_cycle_logs
  ADD COLUMN IF NOT EXISTS active_processed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS semi_active_processed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS semi_active_skipped_timeout INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scripts_reused INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS elapsed_ms INTEGER DEFAULT 0;
