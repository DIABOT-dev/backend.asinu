/**
 * Care Pulse Models
 * Defines schemas for care pulse events, engine state, and escalations
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const EventType = {
  CHECK_IN: 'CHECK_IN',
  POPUP_SHOWN: 'POPUP_SHOWN',
  POPUP_DISMISSED: 'POPUP_DISMISSED',
  APP_OPENED: 'APP_OPENED'
};

const SelfReportStatus = {
  NORMAL: 'NORMAL',
  TIRED: 'TIRED',
  EMERGENCY: 'EMERGENCY'
};

const EventSource = {
  SCHEDULER: 'scheduler',
  MANUAL: 'manual',
  PUSH: 'push',
  SYSTEM: 'system'
};

const EngineStatus = {
  HEALTHY: 'healthy',
  CONCERN: 'concern',
  ALERT: 'alert',
  EMERGENCY: 'emergency'
};

const EscalationStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved'
};

// =====================================================
// SCHEMAS
// =====================================================

// Care Pulse Event
const CarePulseEventSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  event_type: z.enum(['CHECK_IN', 'POPUP_SHOWN', 'POPUP_DISMISSED', 'APP_OPENED']),
  event_id: z.string().uuid(),
  client_ts: z.number(),
  client_tz: z.string(),
  ui_session_id: z.string(),
  source: z.enum(['scheduler', 'manual', 'push', 'system']),
  self_report: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']).optional(),
  event_data: z.record(z.any()).default({}),
  created_at: z.date().optional()
});

const CarePulseEventCreateSchema = z.object({
  event_type: z.enum(['CHECK_IN', 'POPUP_SHOWN', 'POPUP_DISMISSED', 'APP_OPENED']),
  event_id: z.string().uuid(),
  client_ts: z.number(),
  client_tz: z.string(),
  ui_session_id: z.string(),
  source: z.enum(['scheduler', 'manual', 'push', 'system']),
  self_report: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']).optional()
}).refine((data) => {
  if (data.event_type === 'CHECK_IN' && !data.self_report) {
    return false;
  }
  return true;
}, {
  message: 'CHECK_IN requires self_report'
});

// Care Pulse Engine State
const CarePulseEngineStateSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  engine_status: z.enum(['healthy', 'concern', 'alert', 'emergency']),
  last_check_in_at: z.date().nullable().optional(),
  missed_check_ins: z.number().int().min(0).default(0),
  silence_until: z.date().nullable().optional(),
  state_metadata: z.record(z.any()).default({}),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

// Care Pulse Escalation
const CarePulseEscalationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  escalation_type: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  recipients: z.array(z.number()).default([]),
  status: z.enum(['pending', 'sent', 'acknowledged', 'resolved']).default('pending'),
  sent_at: z.date().nullable().optional(),
  acknowledged_at: z.date().nullable().optional(),
  acknowledged_by: z.number().nullable().optional(),
  resolved_at: z.date().nullable().optional(),
  escalation_data: z.record(z.any()).default({}),
  created_at: z.date().optional()
});

const CarePulseEscalationCreateSchema = z.object({
  user_id: z.number().int().positive(),
  escalation_type: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  recipients: z.array(z.number()).optional()
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Determine engine status based on missed check-ins
 */
function determineEngineStatus(missedCheckIns, lastReportStatus) {
  if (lastReportStatus === 'EMERGENCY') {
    return EngineStatus.EMERGENCY;
  }
  
  if (missedCheckIns >= 3) {
    return EngineStatus.ALERT;
  }
  
  if (missedCheckIns >= 2 || lastReportStatus === 'TIRED') {
    return EngineStatus.CONCERN;
  }
  
  return EngineStatus.HEALTHY;
}

/**
 * Check if escalation is needed
 */
function shouldEscalate(engineStatus, lastEscalation) {
  if (engineStatus !== EngineStatus.ALERT && engineStatus !== EngineStatus.EMERGENCY) {
    return false;
  }
  
  if (!lastEscalation) {
    return true;
  }
  
  // Don't escalate if already sent within last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return lastEscalation.sent_at < oneHourAgo;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  EventType,
  SelfReportStatus,
  EventSource,
  EngineStatus,
  EscalationStatus,
  
  // Schemas
  CarePulseEventSchema,
  CarePulseEventCreateSchema,
  CarePulseEngineStateSchema,
  CarePulseEscalationSchema,
  CarePulseEscalationCreateSchema,
  
  // Helper Functions
  determineEngineStatus,
  shouldEscalate
};
