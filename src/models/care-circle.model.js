/**
 * Care Circle Models
 * Defines schemas for user connections and care relationships
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const ConnectionStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  BLOCKED: 'blocked'
};

const RelationshipType = {
  SPOUSE: 'Vợ/Chồng',
  CHILD: 'Con',
  PARENT: 'Bố/Mẹ',
  SIBLING: 'Anh/Chị/Em',
  GRANDPARENT: 'Ông/Bà',
  FRIEND: 'Bạn bè',
  PARTNER: 'Người yêu',
  CAREGIVER: 'Người chăm sóc',
  OTHER: 'Khác'
};

const Role = {
  CAREGIVER: 'Người chăm sóc',
  DOCTOR: 'Bác sĩ',
  NURSE: 'Y tá',
  PHARMACIST: 'Dược sĩ',
  NUTRITIONIST: 'Dinh dưỡng',
  TRAINER: 'Huấn luyện viên',
  THERAPIST: 'Tâm lý',
  FAMILY: 'Thân nhân',
  SUPPORT: 'Hỗ trợ',
  OTHER: 'Khác'
};

// =====================================================
// SCHEMAS
// =====================================================

const PermissionsSchema = z.object({
  can_view_logs: z.boolean().default(true),
  can_receive_alerts: z.boolean().default(true),
  can_ack_escalation: z.boolean().default(false)
});

const UserConnectionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  addressee_id: z.number().int().positive(),
  relationship_type: z.string().optional(),
  role: z.string().optional(),
  permissions: z.record(z.any()).default({}),
  status: z.enum(['pending', 'accepted', 'declined', 'blocked']).default('pending'),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

const UserConnectionCreateSchema = z.object({
  addressee_id: z.number().int().positive(),
  relationship_type: z.string().optional(),
  role: z.string().optional(),
  permissions: PermissionsSchema.optional()
});

const UserConnectionUpdateSchema = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'blocked']).optional(),
  relationship_type: z.string().optional(),
  role: z.string().optional(),
  permissions: PermissionsSchema.optional()
});

// User Baselines Schema
const UserBaselinesSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  avg_glucose: z.number().optional(),
  avg_systolic: z.number().optional(),
  avg_diastolic: z.number().optional(),
  avg_weight_kg: z.number().optional(),
  daily_water_ml: z.number().int().optional(),
  baseline_period_start: z.date().optional(),
  baseline_period_end: z.date().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  ConnectionStatus,
  RelationshipType,
  Role,
  
  // Schemas
  PermissionsSchema,
  UserConnectionSchema,
  UserConnectionCreateSchema,
  UserConnectionUpdateSchema,
  UserBaselinesSchema
};
