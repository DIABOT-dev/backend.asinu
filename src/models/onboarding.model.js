/**
 * Onboarding Models
 * Defines schemas for user onboarding profiles
 */

const { z } = require('zod');

// =====================================================
// ENUMS
// =====================================================

const AgeRange = {
  '30-39': '30-39',
  '40-49': '40-49',
  '50-59': '50-59',
  '60+': '60+'
};

const Gender = {
  MALE: 'Nam',
  FEMALE: 'Nữ'
};

const Goal = {
  REDUCE_PAIN: 'Giảm đau',
  INCREASE_FLEXIBILITY: 'Tăng linh hoạt',
  INCREASE_STRENGTH: 'Tăng sức mạnh',
  IMPROVE_MOBILITY: 'Cải thiện vận động'
};

const BodyType = {
  THIN: 'Gầy',
  BALANCED: 'Cân đối',
  OVERWEIGHT: 'Thừa cân'
};

// =====================================================
// SCHEMAS
// =====================================================

const OnboardingIssueItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  other_text: z.string().optional().nullable()
}).refine((data) => {
  if (data.key === 'other' && !data.other_text) {
    return false;
  }
  return true;
}, {
  message: 'Missing other_text for key=other'
});

const OnboardingIssueListSchema = z.array(
  z.union([z.string(), OnboardingIssueItemSchema])
);

const OnboardingProfileSchema = z.object({
  age: z.enum(['30-39', '40-49', '50-59', '60+']),
  gender: z.enum(['Nam', 'Nữ']),
  goal: z.enum(['Giảm đau', 'Tăng linh hoạt', 'Tăng sức mạnh', 'Cải thiện vận động']),
  body_type: z.enum(['Gầy', 'Cân đối', 'Thừa cân']),
  medical_conditions: OnboardingIssueListSchema,
  chronic_symptoms: OnboardingIssueListSchema,
  joint_issues: z.array(OnboardingIssueItemSchema),
  flexibility: z.string().min(1),
  stairs_performance: z.string().min(1),
  exercise_freq: z.string().min(1),
  walking_habit: z.string().min(1),
  water_intake: z.string().min(1),
  sleep_duration: z.string().min(1)
});

const UserOnboardingProfileSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number().int().positive(),
  display_name: z.string().optional(),
  age: z.enum(['30-39', '40-49', '50-59', '60+']),
  gender: z.enum(['Nam', 'Nữ']),
  goal: z.enum(['Giảm đau', 'Tăng linh hoạt', 'Tăng sức mạnh', 'Cải thiện vận động']),
  body_type: z.enum(['Gầy', 'Cân đối', 'Thừa cân']),
  medical_conditions: z.array(z.any()).default([]),
  chronic_symptoms: z.array(z.any()).default([]),
  joint_issues: z.array(z.any()).default([]),
  flexibility: z.string().optional(),
  stairs_performance: z.string().optional(),
  exercise_freq: z.string().optional(),
  walking_habit: z.string().optional(),
  water_intake: z.string().optional(),
  sleep_duration: z.string().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

const OnboardingRequestSchema = z.object({
  user_id: z.number().int().positive().optional(),
  profile: OnboardingProfileSchema
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Calculate health risk score from onboarding data
 */
function calculateRiskScore(profile) {
  let score = 0;
  
  // Age factor
  if (profile.age === '60+') score += 20;
  else if (profile.age === '50-59') score += 15;
  else if (profile.age === '40-49') score += 10;
  else score += 5;
  
  // Medical conditions
  score += profile.medical_conditions.length * 5;
  
  // Chronic symptoms
  score += profile.chronic_symptoms.length * 3;
  
  // Joint issues
  score += profile.joint_issues.length * 4;
  
  // Body type
  if (profile.body_type === 'Thừa cân') score += 10;
  else if (profile.body_type === 'Gầy') score += 5;
  
  return Math.min(score, 100);
}

/**
 * Get recommended missions based on profile
 */
function getRecommendedMissions(profile) {
  const missions = ['log_glucose', 'log_blood_pressure', 'log_water'];
  
  if (profile.body_type === 'Thừa cân') {
    missions.push('log_weight', 'log_meal', 'exercise');
  }
  
  if (profile.goal === 'Giảm đau' || profile.joint_issues.length > 0) {
    missions.push('exercise');
  }
  
  if (profile.medical_conditions.length > 0) {
    missions.push('log_medication');
  }
  
  return missions;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Enums
  AgeRange,
  Gender,
  Goal,
  BodyType,
  
  // Schemas
  OnboardingIssueItemSchema,
  OnboardingIssueListSchema,
  OnboardingProfileSchema,
  UserOnboardingProfileSchema,
  OnboardingRequestSchema,
  
  // Helper Functions
  calculateRiskScore,
  getRecommendedMissions
};
