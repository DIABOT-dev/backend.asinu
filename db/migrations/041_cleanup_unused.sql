-- Cleanup: drop only views that are never referenced in any code
-- Tables (risk_config_*, alert_decision_audit, asinu_trackers, risk_persistence)
-- are actively used by asinu-brain-extension — DO NOT drop them.

DROP VIEW IF EXISTS asinu_risk_top_alerts_7d;
DROP VIEW IF EXISTS asinu_risk_missed_events_top_50;
DROP VIEW IF EXISTS asinu_risk_suspected_spam_top_50;
