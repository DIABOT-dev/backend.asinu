/**
 * Wellness Models
 * Defines schemas for wellness monitoring, health scores, and alerts
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const WellnessLevel = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  CRITICAL: 'critical'
};

const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

const AlertStatus = {
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed'
};

// =====================================================
// SCHEMAS
// =====================================================

// User Activity Log
const UserActivityLogSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  activity_type: z.string(),
  activity_data: z.record(z.any()).default({}),
  occurred_at: z.date(),
  created_at: z.date().optional()
});

// User Health Score
const UserHealthScoreSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  date: z.date(),
  consistency_score: z.number().min(0).max(100),
  mood_score: z.number().min(0).max(100).optional(),
  engagement_score: z.number().min(0).max(100),
  health_data_score: z.number().min(0).max(100),
  overall_score: z.number().min(0).max(100),
  calculation_metadata: z.record(z.any()).default({}),
  created_at: z.date().optional()
});

// User Wellness State
const UserWellnessStateSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  wellness_level: z.enum(['excellent', 'good', 'fair', 'poor', 'critical']),
  last_check_in: z.date().nullable().optional(),
  consecutive_days_without_log: z.number().int().min(0).default(0),
  consecutive_missed_check_ins: z.number().int().min(0).default(0),
  alert_sent: z.boolean().default(false),
  last_alert_sent_at: z.date().nullable().optional(),
  state_metadata: z.record(z.any()).default({}),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

// Caregiver Alert
const CaregiverAlertSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  caregiver_id: z.number().int().positive(),
  alert_type: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  alert_data: z.record(z.any()).default({}),
  status: z.enum(['pending', 'acknowledged', 'resolved', 'dismissed']).default('pending'),
  acknowledged_at: z.date().nullable().optional(),
  resolved_at: z.date().nullable().optional(),
  created_at: z.date().optional()
});

const CaregiverAlertCreateSchema = z.object({
  user_id: z.number().int().positive(),
  caregiver_id: z.number().int().positive(),
  alert_type: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  alert_data: z.record(z.any()).optional()
});

// Wellness Monitoring Config
const WellnessMonitoringConfigSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  max_days_without_log: z.number().int().min(1).default(3),
  max_missed_check_ins: z.number().int().min(1).default(2),
  alert_enabled: z.boolean().default(true),
  alert_channels: z.array(z.string()).default(['push', 'email']),
  quiet_hours_start: z.string().nullable().optional(),
  quiet_hours_end: z.string().nullable().optional(),
  config_metadata: z.record(z.any()).default({}),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

// Daily Wellness Summary
const DailyWellnessSummarySchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  summary_date: z.date(),
  total_logs: z.number().int().min(0).default(0),
  log_types_count: z.record(z.number()).default({}),
  missions_completed: z.number().int().min(0).default(0),
  health_score: z.number().min(0).max(100).optional(),
  wellness_level: z.enum(['excellent', 'good', 'fair', 'poor', 'critical']).optional(),
  summary_metadata: z.record(z.any()).default({}),
  created_at: z.date().optional()
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Calculate overall wellness score
 */
function calculateOverallScore(consistency, mood, engagement, healthData) {
  const weights = {
    consistency: 0.25,
    mood: 0.30,
    engagement: 0.20,
    healthData: 0.25
  };
  
  return (
    consistency * weights.consistency +
    (mood || 50) * weights.mood +
    engagement * weights.engagement +
    healthData * weights.healthData
  );
}

/**
 * Determine wellness level from score
 */
function getWellnessLevel(score) {
  if (score >= 80) return WellnessLevel.EXCELLENT;
  if (score >= 60) return WellnessLevel.GOOD;
  if (score >= 40) return WellnessLevel.FAIR;
  if (score >= 20) return WellnessLevel.POOR;
  return WellnessLevel.CRITICAL;
}

/**
 * Check if alert should be sent
 */
function shouldSendAlert(state, config) {
  if (!config.alert_enabled) return false;
  if (state.alert_sent) return false;
  
  return (
    state.consecutive_days_without_log >= config.max_days_without_log ||
    state.consecutive_missed_check_ins >= config.max_missed_check_ins
  );
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  WellnessLevel,
  AlertSeverity,
  AlertStatus,
  
  // Schemas
  UserActivityLogSchema,
  UserHealthScoreSchema,
  UserWellnessStateSchema,
  CaregiverAlertSchema,
  CaregiverAlertCreateSchema,
  WellnessMonitoringConfigSchema,
  DailyWellnessSummarySchema,
  
  // Helper Functions
  calculateOverallScore,
  getWellnessLevel,
  shouldSendAlert
};
