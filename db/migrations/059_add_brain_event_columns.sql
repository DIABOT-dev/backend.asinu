-- ============================================================================
-- Migration 059: Add missing columns to asinu_brain_events
-- Created: 2026-04-17
-- Purpose: Code queries question_id and payload but table only has event_data
-- ============================================================================

BEGIN;

ALTER TABLE asinu_brain_events ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE asinu_brain_events ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_brain_events_question_id ON asinu_brain_events(user_id, question_id);

COMMIT;
