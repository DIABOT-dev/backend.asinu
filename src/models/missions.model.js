/**
 * Missions Models
 * Defines schemas for user missions and mission history
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const MissionStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  EXPIRED: 'expired'
};

const MissionKey = {
  LOG_GLUCOSE: 'log_glucose',
  LOG_BLOOD_PRESSURE: 'log_blood_pressure',
  LOG_WEIGHT: 'log_weight',
  LOG_WATER: 'log_water',
  LOG_MEAL: 'log_meal',
  COMPLETE_ALL_LOGS: 'complete_all_logs',
  CHECK_IN: 'check_in',
  EXERCISE: 'exercise'
};

// =====================================================
// SCHEMAS
// =====================================================

const UserMissionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  mission_key: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'expired']).default('pending'),
  progress: z.number().int().min(0).default(0),
  goal: z.number().int().min(1).default(1),
  assigned_date: z.date(),
  completed_date: z.date().nullable().optional(),
  last_incremented_date: z.date().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

const UserMissionCreateSchema = z.object({
  user_id: z.number().int().positive(),
  mission_key: z.string(),
  goal: z.number().int().min(1).default(1),
  assigned_date: z.date().optional()
});

const UserMissionUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'expired']).optional(),
  progress: z.number().int().min(0).optional(),
  goal: z.number().int().min(1).optional(),
  completed_date: z.date().nullable().optional()
});

const MissionHistorySchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  mission_key: z.string(),
  completed_date: z.date(),
  progress: z.number().int().min(0).default(0),
  goal: z.number().int().min(1).default(1),
  created_at: z.date().optional()
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Calculate mission progress percentage
 */
function calculateProgress(progress, goal) {
  if (goal === 0) return 0;
  return Math.min((progress / goal) * 100, 100);
}

/**
 * Check if mission is completed
 */
function isMissionCompleted(progress, goal) {
  return progress >= goal;
}

/**
 * Get mission display title
 */
function getMissionTitle(missionKey) {
  const titles = {
    log_glucose: 'Ghi đường huyết',
    log_blood_pressure: 'Ghi huyết áp',
    log_weight: 'Ghi cân nặng',
    log_water: 'Uống đủ nước',
    log_meal: 'Ghi bữa ăn',
    complete_all_logs: 'Hoàn thành tất cả ghi chép',
    check_in: 'Check-in hàng ngày',
    exercise: 'Tập thể dục'
  };
  return titles[missionKey] || missionKey;
}

/**
 * Get mission description
 */
function getMissionDescription(missionKey) {
  const descriptions = {
    log_glucose: 'Ghi đường huyết 2 lần trong ngày',
    log_blood_pressure: 'Đo và ghi huyết áp 1 lần',
    log_weight: 'Cân và ghi cân nặng',
    log_water: 'Uống đủ 2000ml nước mỗi ngày',
    log_meal: 'Ghi 3 bữa ăn trong ngày',
    complete_all_logs: 'Hoàn thành tất cả các ghi chép hàng ngày',
    check_in: 'Báo cáo tình trạng sức khỏe',
    exercise: 'Tập thể dục ít nhất 30 phút'
  };
  return descriptions[missionKey] || '';
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  MissionStatus,
  MissionKey,
  
  // Schemas
  UserMissionSchema,
  UserMissionCreateSchema,
  UserMissionUpdateSchema,
  MissionHistorySchema,
  
  // Helper Functions
  calculateProgress,
  isMissionCompleted,
  getMissionTitle,
  getMissionDescription
};
