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

const answerSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    question_id: z.enum(['mood', 'symptom_severity']),
    answer: z.unknown()
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.question_id === 'mood') {
      const parsed = moodAnswerSchema.safeParse(data.answer);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid mood answer' });
      }
    }

    if (data.question_id === 'symptom_severity') {
      const parsed = symptomAnswerSchema.safeParse(data.answer);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid symptom answer' });
      }
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
  emergencySchema
};
