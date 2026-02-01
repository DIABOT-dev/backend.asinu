/**
 * Logs Models
 * Defines schemas for all health logging types
 */

const { z } = require('zod');

// =====================================================
// LOG TYPES ENUM
// =====================================================

const LogType = {
  GLUCOSE: 'glucose',
  BLOOD_PRESSURE: 'bp',
  WEIGHT: 'weight',
  WATER: 'water',
  MEAL: 'meal',
  INSULIN: 'insulin',
  MEDICATION: 'medication',
  CARE_PULSE: 'care_pulse'
};

// =====================================================
// COMMON LOG SCHEMA
// =====================================================

const LogCommonSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  log_type: z.enum(['glucose', 'bp', 'weight', 'water', 'meal', 'insulin', 'medication', 'care_pulse']),
  occurred_at: z.date(),
  source: z.string().default('manual'),
  note: z.string().nullable().optional(),
  metadata: z.record(z.any()).default({}),
  created_at: z.date().optional()
});

// =====================================================
// SPECIFIC LOG SCHEMAS
// =====================================================

// Glucose Log
const GlucoseLogSchema = z.object({
  log_id: z.string().uuid(),
  value: z.number().min(10).max(1000),
  unit: z.string().default('mg/dL'),
  context: z.enum(['fasting', 'pre_meal', 'post_meal', 'before_sleep', 'random']).optional(),
  meal_tag: z.string().optional()
});

const GlucoseLogCreateSchema = z.object({
  value: z.number().min(10).max(1000),
  unit: z.string().optional(),
  context: z.enum(['fasting', 'pre_meal', 'post_meal', 'before_sleep', 'random']).optional(),
  meal_tag: z.string().optional()
});

// Blood Pressure Log
const BloodPressureLogSchema = z.object({
  log_id: z.string().uuid(),
  systolic: z.number().int().min(50).max(250),
  diastolic: z.number().int().min(30).max(150),
  pulse: z.number().int().min(30).max(220).optional(),
  unit: z.string().default('mmHg')
});

const BloodPressureLogCreateSchema = z.object({
  systolic: z.number().int().min(50).max(250),
  diastolic: z.number().int().min(30).max(150),
  pulse: z.number().int().min(30).max(220).optional(),
  unit: z.string().optional()
});

// Weight Log
const WeightLogSchema = z.object({
  log_id: z.string().uuid(),
  weight_kg: z.number().min(10).max(400),
  body_fat_percent: z.number().min(1).max(80).optional(),
  muscle_percent: z.number().min(1).max(80).optional()
});

const WeightLogCreateSchema = z.object({
  weight_kg: z.number().min(10).max(400),
  body_fat_percent: z.number().min(1).max(80).optional(),
  muscle_percent: z.number().min(1).max(80).optional()
});

// Water Log
const WaterLogSchema = z.object({
  log_id: z.string().uuid(),
  volume_ml: z.number().int().min(10).max(5000)
});

const WaterLogCreateSchema = z.object({
  volume_ml: z.number().int().min(10).max(5000)
});

// Meal Log
const MealLogSchema = z.object({
  log_id: z.string().uuid(),
  calories_kcal: z.number().int().min(0).max(5000).optional(),
  carbs_g: z.number().min(0).max(1000).optional(),
  protein_g: z.number().min(0).max(1000).optional(),
  fat_g: z.number().min(0).max(1000).optional(),
  meal_text: z.string().optional(),
  photo_url: z.string().url().optional()
});

const MealLogCreateSchema = z.object({
  calories_kcal: z.number().int().min(0).max(5000).optional(),
  carbs_g: z.number().min(0).max(1000).optional(),
  protein_g: z.number().min(0).max(1000).optional(),
  fat_g: z.number().min(0).max(1000).optional(),
  meal_text: z.string().optional(),
  photo_url: z.string().url().optional()
});

// Insulin Log
const InsulinLogSchema = z.object({
  log_id: z.string().uuid(),
  insulin_type: z.string().optional(),
  dose_units: z.number().min(0.1).max(200),
  unit: z.string().default('U'),
  timing: z.enum(['pre_meal', 'post_meal', 'bedtime', 'correction']).optional(),
  injection_site: z.string().optional()
});

const InsulinLogCreateSchema = z.object({
  insulin_type: z.string().optional(),
  dose_units: z.number().min(0.1).max(200),
  unit: z.string().optional(),
  timing: z.enum(['pre_meal', 'post_meal', 'bedtime', 'correction']).optional(),
  injection_site: z.string().optional()
});

// Medication Log
const MedicationLogSchema = z.object({
  log_id: z.string().uuid(),
  med_name: z.string().min(1),
  dose_text: z.string().min(1),
  dose_value: z.number().min(0).max(10000).optional(),
  dose_unit: z.string().optional(),
  frequency_text: z.string().optional()
});

const MedicationLogCreateSchema = z.object({
  med_name: z.string().min(1),
  dose_text: z.string().min(1),
  dose_value: z.number().min(0).max(10000).optional(),
  dose_unit: z.string().optional(),
  frequency_text: z.string().optional()
});

// Care Pulse Log
const CarePulseLogSchema = z.object({
  log_id: z.string().uuid(),
  status: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']),
  sub_status: z.string().optional(),
  trigger_source: z.enum(['POPUP', 'HOME_WIDGET', 'EMERGENCY_BUTTON']),
  escalation_sent: z.boolean().default(false),
  silence_count: z.number().int().min(0).max(100).default(0)
});

const CarePulseLogCreateSchema = z.object({
  status: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']),
  sub_status: z.string().optional(),
  trigger_source: z.enum(['POPUP', 'HOME_WIDGET', 'EMERGENCY_BUTTON']),
  escalation_sent: z.boolean().optional(),
  silence_count: z.number().int().min(0).max(100).optional()
});

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  LogType,
  
  // Schemas
  LogCommonSchema,
  GlucoseLogSchema,
  GlucoseLogCreateSchema,
  BloodPressureLogSchema,
  BloodPressureLogCreateSchema,
  WeightLogSchema,
  WeightLogCreateSchema,
  WaterLogSchema,
  WaterLogCreateSchema,
  MealLogSchema,
  MealLogCreateSchema,
  InsulinLogSchema,
  InsulinLogCreateSchema,
  MedicationLogSchema,
  MedicationLogCreateSchema,
  CarePulseLogSchema,
  CarePulseLogCreateSchema
};
