-- ============================================================================
-- Migration 052: Cleanup Dead Tables and Dead Fields
-- Created: 2026-04-04
-- Purpose: Remove unused tables and columns that are no longer referenced
--          by any application code. A full backup of all dropped objects
--          is stored in db/backup/dead_tables_and_fields_backup.sql.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: Drop dead tables
-- These tables were part of earlier risk-engine, brain-extension, triage,
-- health-log, and tracker features that have been replaced or removed.
-- ============================================================================

-- Drop child tables first to avoid FK constraint issues

-- Risk engine audit (depends on risk_config_versions)
DROP TABLE IF EXISTS alert_decision_audit CASCADE;

-- Risk engine config params (depends on risk_config_versions)
DROP TABLE IF EXISTS risk_config_params CASCADE;

-- Risk engine config versions (parent of above two)
DROP TABLE IF EXISTS risk_config_versions CASCADE;

-- Risk persistence state
DROP TABLE IF EXISTS risk_persistence CASCADE;

-- Asinu Brain child tables (depend on asinu_brain_sessions)
DROP TABLE IF EXISTS asinu_brain_events CASCADE;
DROP TABLE IF EXISTS asinu_brain_outcomes CASCADE;
DROP TABLE IF EXISTS asinu_brain_context_snapshots CASCADE;

-- Asinu pathway tracker
DROP TABLE IF EXISTS asinu_trackers CASCADE;

-- Triage outcomes
DROP TABLE IF EXISTS triage_outcomes CASCADE;

-- Legacy health logs (replaced by logs_common system)
DROP TABLE IF EXISTS health_logs CASCADE;


-- ============================================================================
-- PART 2: Drop dead columns
-- These columns exist on active tables but are never read or written by
-- application code.
-- ============================================================================

-- user_connections: blocked_at was never used (blocking uses a separate mechanism)
ALTER TABLE user_connections DROP COLUMN IF EXISTS blocked_at;

-- chat_feedback: note_text was superseded by other feedback fields
ALTER TABLE chat_feedback DROP COLUMN IF EXISTS note_text;

-- medication_adherence: taken_at and notes are unused legacy columns
ALTER TABLE medication_adherence DROP COLUMN IF EXISTS taken_at;
ALTER TABLE medication_adherence DROP COLUMN IF EXISTS notes;

-- prompt_history: response_status, response_data, responded_at were part of
-- a response-tracking feature that was never shipped
ALTER TABLE prompt_history DROP COLUMN IF EXISTS response_status;
ALTER TABLE prompt_history DROP COLUMN IF EXISTS response_data;
ALTER TABLE prompt_history DROP COLUMN IF EXISTS responded_at;

-- user_health_scores: valid_until was planned for score expiration but never used
ALTER TABLE user_health_scores DROP COLUMN IF EXISTS valid_until;

-- asinu_brain_sessions: started_at, ended_at, last_question_id, last_answered_at
-- were part of the old brain session tracking replaced by event-based tracking
ALTER TABLE asinu_brain_sessions DROP COLUMN IF EXISTS started_at;
ALTER TABLE asinu_brain_sessions DROP COLUMN IF EXISTS ended_at;
ALTER TABLE asinu_brain_sessions DROP COLUMN IF EXISTS last_question_id;
ALTER TABLE asinu_brain_sessions DROP COLUMN IF EXISTS last_answered_at;

-- triage_scripts: expires_at was planned for script expiration but never used
ALTER TABLE triage_scripts DROP COLUMN IF EXISTS expires_at;

-- rnd_cycle_logs: details column is never read or written
ALTER TABLE rnd_cycle_logs DROP COLUMN IF EXISTS details;

COMMIT;
