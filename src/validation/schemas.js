const { z } = require('zod');

const uuidSchema = z.string().uuid();

const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  client_ts: z.number(),
  context: z.record(z.any()).optional(),
});

const onboardingIssueItemSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    other_text: z.string().min(1).optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.key === 'other' && !data.other_text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing other_text for key=other' });
    }
  });

const onboardingIssueListSchema = z.array(
  z.union([z.string(), onboardingIssueItemSchema])
);

const onboardingProfileSchema = z
  .object({
    age: z.enum(['30-39', '40-49', '50-59', '60+']),
    gender: z.enum(['Nam', 'Nữ']),
    goal: z.enum(['Giảm đau', 'Tăng linh hoạt', 'Tăng sức mạnh', 'Cải thiện vận động']),
    body_type: z.enum(['Gầy', 'Cân đối', 'Thừa cân']),
    medical_conditions: onboardingIssueListSchema,
    chronic_symptoms: onboardingIssueListSchema,
    joint_issues: z.array(onboardingIssueItemSchema),
    flexibility: z.string().min(1),
    stairs_performance: z.string().min(1),
    exercise_freq: z.string().min(1),
    walking_habit: z.string().min(1),
    water_intake: z.string().min(1),
    sleep_duration: z.string().min(1),
  })
  .strict();

const onboardingRequestSchema = z
  .object({
    user_id: z.number().int().positive().optional(),
    profile: onboardingProfileSchema,
  })
  .strict();

const carePulseEventSchema = z
  .object({
    event_type: z.enum(['CHECK_IN', 'POPUP_SHOWN', 'POPUP_DISMISSED', 'APP_OPENED']),
    event_id: uuidSchema,
    client_ts: z.number(),
    client_tz: z.string().min(1),
    ui_session_id: z.string().min(1),
    source: z.enum(['scheduler', 'manual', 'push', 'system']),
    self_report: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.event_type === 'CHECK_IN' && !data.self_report) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing self_report' });
    }
  });

const permissionsSchema = z
  .object({
    can_view_logs: z.boolean().optional(),
    can_receive_alerts: z.boolean().optional(),
    can_ack_escalation: z.boolean().optional(),
  })
  .strict();

const careCircleInvitationSchema = z.object({
  addressee_id: z.number().int().positive(),
  relationship_type: z.string().optional(),
  role: z.string().optional(),
  permissions: permissionsSchema.optional(),
});

const escalationAckSchema = z.object({
  escalation_id: uuidSchema,
});

const logBaseSchema = z.object({
  log_type: z.enum(['glucose', 'bp', 'weight', 'water', 'meal', 'insulin', 'medication', 'care_pulse']),
  occurred_at: z.string().min(1),
  source: z.string().optional(),
  note: z.string().optional().nullable(),
  metadata: z.record(z.any()).optional(),
  data: z.record(z.any()),
});

const numberField = (min, max) =>
  z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return value;
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }, z.number().min(min).max(max));

const numberFieldOptional = (min, max) =>
  z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }, z.number().min(min).max(max).optional());

const glucoseSchema = z.object({
  value: numberField(10, 1000),
  unit: z.string().optional(),
  context: z.enum(['fasting', 'pre_meal', 'post_meal', 'before_sleep', 'random']).optional(),
  meal_tag: z.string().optional(),
});

const bpSchema = z.object({
  systolic: numberField(50, 250),
  diastolic: numberField(30, 150),
  pulse: numberFieldOptional(30, 220),
  unit: z.string().optional(),
});

const weightSchema = z.object({
  weight_kg: numberField(10, 400),
  body_fat_percent: numberFieldOptional(1, 80),
  muscle_percent: numberFieldOptional(1, 80),
});

const waterSchema = z.object({
  volume_ml: numberField(10, 5000),
});

const mealSchema = z.object({
  calories_kcal: numberFieldOptional(0, 5000),
  carbs_g: numberFieldOptional(0, 1000),
  protein_g: numberFieldOptional(0, 1000),
  fat_g: numberFieldOptional(0, 1000),
  meal_text: z.string().optional().nullable(),
  photo_url: z.string().optional().nullable(),
});

const insulinSchema = z.object({
  insulin_type: z.string().optional(),
  dose_units: numberField(0.1, 200),
  unit: z.string().optional(),
  timing: z.enum(['pre_meal', 'post_meal', 'bedtime', 'correction']).optional(),
  injection_site: z.string().optional(),
});

const medicationSchema = z.object({
  med_name: z.string().min(1),
  dose_text: z.string().min(1),
  dose_value: numberFieldOptional(0, 10000),
  dose_unit: z.string().optional(),
  frequency_text: z.string().optional(),
});

const carePulseLogSchema = z.object({
  status: z.enum(['NORMAL', 'TIRED', 'EMERGENCY']),
  sub_status: z.string().optional(),
  trigger_source: z.enum(['POPUP', 'HOME_WIDGET', 'EMERGENCY_BUTTON']),
  escalation_sent: z.boolean().optional(),
  silence_count: numberFieldOptional(0, 100),
});

const logDataSchemas = {
  glucose: glucoseSchema,
  bp: bpSchema,
  weight: weightSchema,
  water: waterSchema,
  meal: mealSchema,
  insulin: insulinSchema,
  medication: medicationSchema,
  care_pulse: carePulseLogSchema,
};

module.exports = {
  chatRequestSchema,
  onboardingRequestSchema,
  carePulseEventSchema,
  careCircleInvitationSchema,
  permissionsSchema,
  escalationAckSchema,
  logBaseSchema,
  logDataSchemas,
};
