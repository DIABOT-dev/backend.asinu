-- =====================================================================
-- Migration 073: Optimize database indexes (Add missing, Drop duplicates)
-- =====================================================================

-- 1. Bổ sung chỉ mục tối ưu hóa cho Care Circle (User Connections)
CREATE INDEX IF NOT EXISTS idx_user_connections_requester_status ON user_connections (requester_id, status);
CREATE INDEX IF NOT EXISTS idx_user_connections_addressee_status ON user_connections (addressee_id, status);

-- 2. Bổ sung chỉ mục tối ưu chatbot AI (Asinu Brain Events, Outcomes & Snapshots)
CREATE INDEX IF NOT EXISTS idx_asinu_brain_events_session_id ON asinu_brain_events (session_id);
CREATE INDEX IF NOT EXISTS idx_asinu_brain_outcomes_session_id ON asinu_brain_outcomes (session_id);
CREATE INDEX IF NOT EXISTS idx_asinu_brain_outcomes_user_id ON asinu_brain_outcomes (user_id);
CREATE INDEX IF NOT EXISTS idx_asinu_brain_context_snapshots_session_id ON asinu_brain_context_snapshots (session_id);
CREATE INDEX IF NOT EXISTS idx_asinu_brain_context_snapshots_user_id ON asinu_brain_context_snapshots (user_id);

-- 3. Bổ sung chỉ mục tối ưu bảng xác nhận cảnh báo người thân (Caregiver Alert Confirmations)
CREATE INDEX IF NOT EXISTS idx_caregiver_alert_confirmations_patient_id ON caregiver_alert_confirmations (patient_id);

-- 4. Xóa bỏ các chỉ mục trùng lặp 100%
DROP INDEX IF EXISTS idx_notifications_user_read_created;
DROP INDEX IF EXISTS user_onboarding_profiles_user_id_idx;
DROP INDEX IF EXISTS idx_logs_user_type_occurred;
DROP INDEX IF EXISTS idx_health_checkins_user;
DROP INDEX IF EXISTS idx_health_checkins_user_session_date;
