-- ============================================================================
-- Migration 058: Restore dropped columns on asinu_brain_sessions
-- Created: 2026-04-16
-- Purpose: Migration 052 dropped columns still used by asinuBrain.service.js
-- ============================================================================

BEGIN;

ALTER TABLE asinu_brain_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE asinu_brain_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE asinu_brain_sessions ADD COLUMN IF NOT EXISTS last_question_id TEXT;
ALTER TABLE asinu_brain_sessions ADD COLUMN IF NOT EXISTS last_answered_at TIMESTAMPTZ;

COMMIT;
