-- ============================================================================
-- Migration 060: Fix all column mismatches between asinuBrain.service.js and DB
-- Created: 2026-04-17
-- Purpose: Code queries columns that don't exist in tables restored by 057
-- ============================================================================

BEGIN;

-- ── asinu_brain_outcomes ──
-- Code: INSERT (session_id, user_id, risk_level, notify_caregiver, recommended_action, outcome_text, metadata)
-- Schema: (session_id, user_id, outcome_type, outcome_data)
ALTER TABLE asinu_brain_outcomes ADD COLUMN IF NOT EXISTS risk_level TEXT;
ALTER TABLE asinu_brain_outcomes ADD COLUMN IF NOT EXISTS notify_caregiver BOOLEAN DEFAULT false;
ALTER TABLE asinu_brain_outcomes ADD COLUMN IF NOT EXISTS recommended_action TEXT;
ALTER TABLE asinu_brain_outcomes ADD COLUMN IF NOT EXISTS outcome_text TEXT;
ALTER TABLE asinu_brain_outcomes ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- ── risk_config_versions ──
-- Code: SELECT config_version FROM risk_config_versions WHERE is_active = true
-- Schema: (version_name, description, is_active) — missing config_version column
ALTER TABLE risk_config_versions ADD COLUMN IF NOT EXISTS config_version TEXT;

-- ── risk_config_params ──
-- Code: SELECT key, value FROM risk_config_params WHERE config_version = $1
-- Schema: (version_id, param_key, param_value) — code uses "key"/"value"/"config_version"
ALTER TABLE risk_config_params ADD COLUMN IF NOT EXISTS key TEXT;
ALTER TABLE risk_config_params ADD COLUMN IF NOT EXISTS value JSONB DEFAULT '{}'::jsonb;
ALTER TABLE risk_config_params ADD COLUMN IF NOT EXISTS config_version TEXT;

-- ── alert_decision_audit ──
-- Code: INSERT (user_id, run_at, engine_version, config_version, shadow_mode, input_snapshot, computation, output, explainability_payload, notification_sent, channel)
-- Schema: (user_id, decision, reason, risk_score, config_version_id)
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS config_version TEXT;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS shadow_mode BOOLEAN DEFAULT false;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS input_snapshot JSONB DEFAULT '{}'::jsonb;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS computation JSONB DEFAULT '{}'::jsonb;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS output JSONB DEFAULT '{}'::jsonb;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS explainability_payload JSONB DEFAULT '{}'::jsonb;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN DEFAULT false;
ALTER TABLE alert_decision_audit ADD COLUMN IF NOT EXISTS channel TEXT;

-- Make decision column nullable (code doesn't always set it)
ALTER TABLE alert_decision_audit ALTER COLUMN decision DROP NOT NULL;

COMMIT;
