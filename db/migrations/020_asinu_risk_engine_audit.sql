-- Asinu Risk Engine config + audit trail

CREATE TABLE IF NOT EXISTS risk_config_versions (
  config_version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_config_params (
  id BIGSERIAL PRIMARY KEY,
  config_version TEXT NOT NULL REFERENCES risk_config_versions(config_version) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (config_version, key)
);

CREATE TABLE IF NOT EXISTS alert_decision_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ DEFAULT NOW(),
  engine_version TEXT NOT NULL,
  config_version TEXT REFERENCES risk_config_versions(config_version),
  shadow_mode BOOLEAN NOT NULL DEFAULT false,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  computation JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  explainability_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_sent BOOLEAN NOT NULL DEFAULT false,
  channel TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_config_versions_active
  ON risk_config_versions(is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_config_params_version
  ON risk_config_params(config_version, key);

CREATE INDEX IF NOT EXISTS idx_alert_decision_audit_user
  ON alert_decision_audit(user_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_decision_audit_config
  ON alert_decision_audit(config_version, run_at DESC);

INSERT INTO risk_config_versions (config_version, name, description, is_active, created_by)
VALUES ('v1', 'P/S V1', 'Default weights and thresholds for risk engine B', true, 'seed')
ON CONFLICT (config_version) DO NOTHING;

UPDATE risk_config_versions
SET is_active = CASE WHEN config_version = 'v1' THEN true ELSE false END;

INSERT INTO risk_config_params (config_version, key, value)
VALUES
  ('v1', 'w1', to_jsonb(0.6::numeric)),
  ('v1', 'w2', to_jsonb(1::numeric)),
  ('v1', 'w3', to_jsonb(1::numeric)),
  ('v1', 'w4', to_jsonb(1::numeric)),
  ('v1', 'trend_points_map', '{"-1": -10, "0": 0, "1": 10}'::jsonb),
  ('v1', 'acute_points_map', '{"0": 0, "1": 20, "2": 60}'::jsonb),
  ('v1', 'missing_points_map', '{"0": 0, "1": 15}'::jsonb),
  ('v1', 'base_by_age', '{"U60": 30, "60_69": 40, "70_79": 50, "80P": 60}'::jsonb),
  ('v1', 'add_by_comorbidity', '{"0": 0, "1": 10, "2": 20, "3": 30}'::jsonb),
  ('v1', 'add_by_frailty', '{"0": 0, "1": 10, "2": 20}'::jsonb),
  ('v1', 'missing_severity_threshold', to_jsonb(60::numeric)),
  ('v1', 'threshold_check_in', to_jsonb(20::numeric)),
  ('v1', 'threshold_notify', to_jsonb(45::numeric)),
  ('v1', 'threshold_emergency', to_jsonb(70::numeric)),
  ('v1', 'shadow_mode', 'false'::jsonb)
ON CONFLICT (config_version, key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();

CREATE OR REPLACE VIEW asinu_risk_top_alerts_7d AS
SELECT
  id,
  user_id,
  run_at,
  (computation->>'alert_score')::numeric AS alert_score,
  output->>'decision_label' AS decision_label,
  output,
  explainability_payload
FROM alert_decision_audit
WHERE run_at >= NOW() - INTERVAL '7 days'
ORDER BY (computation->>'alert_score')::numeric DESC NULLS LAST
LIMIT 50;

CREATE OR REPLACE VIEW asinu_risk_missed_events_top_50 AS
SELECT
  id,
  user_id,
  run_at,
  output,
  explainability_payload
FROM alert_decision_audit
WHERE (output->>'missed_event')::boolean IS TRUE
ORDER BY run_at DESC
LIMIT 50;

CREATE OR REPLACE VIEW asinu_risk_suspected_spam_top_50 AS
SELECT
  user_id,
  COUNT(*) AS check_in_count,
  MAX(run_at) AS last_run_at
FROM alert_decision_audit
WHERE run_at >= NOW() - INTERVAL '7 days'
  AND output->>'decision_label' = 'check_in'
GROUP BY user_id
ORDER BY check_in_count DESC, last_run_at DESC
LIMIT 50;

COMMENT ON TABLE risk_config_versions IS 'Risk engine B config versions';
COMMENT ON TABLE risk_config_params IS 'Risk engine B config parameters';
COMMENT ON TABLE alert_decision_audit IS 'Audit trail for risk engine B decisions';
