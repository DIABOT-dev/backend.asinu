-- Optimize query indexes for frequently accessed patterns

-- Notifications: user unread sorted by created_at (used on every app load)
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created
  ON notifications (user_id, is_read, created_at DESC);

-- Health checkins: user + session_date composite (daily checkin lookups)
CREATE INDEX IF NOT EXISTS idx_health_checkins_user_session_date
  ON health_checkins (user_id, session_date DESC);

-- Subscriptions: user + status composite (subscription status checks)
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions (user_id, status);

-- Caregiver alerts: user + status and caregiver + status composites
CREATE INDEX IF NOT EXISTS idx_caregiver_alerts_user_status
  ON caregiver_alerts (user_id, alert_status);
CREATE INDEX IF NOT EXISTS idx_caregiver_alerts_caregiver_status
  ON caregiver_alerts (caregiver_user_id, alert_status);

-- Chat feedback: user + type + created_at for note pagination queries
CREATE INDEX IF NOT EXISTS idx_chat_feedback_user_type_created
  ON chat_feedback (user_id, feedback_type, created_at DESC);

-- User connections: status + pair for care circle lookups
CREATE INDEX IF NOT EXISTS idx_user_connections_status
  ON user_connections (status) WHERE status = 'accepted';

-- User missions: user_id for daily mission fetch
CREATE INDEX IF NOT EXISTS idx_user_missions_user
  ON user_missions (user_id);

-- Users: subscription tier lookup for premium checks
CREATE INDEX IF NOT EXISTS idx_users_subscription
  ON users (id, subscription_tier, subscription_expires_at);

-- Wellness state: user_id primary lookup
CREATE INDEX IF NOT EXISTS idx_user_wellness_state_user
  ON user_wellness_state (user_id);

-- Prompt history: daily count check
CREATE INDEX IF NOT EXISTS idx_prompt_history_user_date
  ON prompt_history (user_id, prompted_at);
