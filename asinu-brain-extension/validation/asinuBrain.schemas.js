const { z } = require('zod');

const symptomOptionSchema = z.enum([
  'none',
  'chest_pain',
  'shortness_of_breath',
  'dizziness',
  'fever',
  'headache',
  'nausea',
  'other'
]);

const moodAnswerSchema = z.object({
  option_id: z.enum(['OK', 'TIRED', 'NOT_OK']),
  value: z.string().optional(),
  free_text: z.string().optional()
});

const symptomAnswerSchema = z.object({
  option_id: z.array(symptomOptionSchema).min(1),
  value: z.enum(['mild', 'moderate', 'severe']),
  free_text: z.string().optional()
});

// Dynamic answer schema cho AI-generated questions
const dynamicAnswerSchema = z.object({
  option_id: z.string(),
  value: z.string().optional(),
  label: z.string().optional(),
  free_text: z.string().optional()
});

const answerSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    question_id: z.string().min(1), // Cho phép bất kỳ question_id nào (q_1, q_2, mood, symptom_severity...)
    answer: z.unknown()
  })
  .strict()
  .superRefine((data, ctx) => {
    // Legacy mood question
    if (data.question_id === 'mood') {
      const parsed = moodAnswerSchema.safeParse(data.answer);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid mood answer' });
      }
      return;
    }

    // Legacy symptom question
    if (data.question_id === 'symptom_severity') {
      const parsed = symptomAnswerSchema.safeParse(data.answer);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid symptom answer' });
      }
      return;
    }
    
    // Dynamic AI questions (q_1, q_2, etc.)
    const parsed = dynamicAnswerSchema.safeParse(data.answer);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid dynamic answer' });
    }
  });

const emergencySchema = z
  .object({
    type: z.enum(['SUDDEN_TIRED', 'VERY_UNWELL', 'ALERT_CAREGIVER']),
    free_text: z.string().optional()
  })
  .strict();

module.exports = {
  answerSchema,
  moodAnswerSchema,
  symptomAnswerSchema,
  dynamicAnswerSchema,
  emergencySchema
};
