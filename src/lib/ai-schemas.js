/**
 * Zod schemas for AI output. Every clinical-decision call MUST validate
 * the JSON it gets back from the LLM against one of these schemas before
 * acting on the result — otherwise a malformed response can trigger a
 * caregiver alert with the wrong severity, no message text, etc.
 *
 * MVP audit (FIX #8): the audit calls this out explicitly because of the
 * Vietnamese medical-advice wording rules — we cannot afford to forward
 * raw model text as a "recommendation" without checking shape.
 */

const { z } = require('zod');

const RiskTierSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

const RiskAssessmentSchema = z.object({
  risk_tier:          RiskTierSchema,
  risk_score:         z.number().min(0).max(100),
  notify_caregiver:   z.boolean(),
  reasoning:          z.string().min(1).max(2000),
  outcome_text:       z.string().min(1).max(2000),
  recommended_action: z.string().min(1).max(1000),
  // emergency-only fields
  alert_title:        z.string().max(120).optional(),
  alert_message:      z.string().max(1000).optional(),
  summary:            z.string().max(1000).optional(),
});

const QuestionOptionSchema = z.object({
  value: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
});

const AiQuestionSchema = z.union([
  z.object({
    text:    z.string().min(1).max(800),
    type:    z.literal('single_choice'),
    options: z.array(QuestionOptionSchema).min(2).max(6),
  }),
  z.object({
    text: z.string().min(1).max(800),
    type: z.literal('open_text'),
  }),
]);

const TriageActionSchema = z.discriminatedUnion('action', [
  z.object({
    action:    z.literal('ask'),
    question:  AiQuestionSchema,
    reasoning: z.string().max(1000).optional(),
  }),
  z.object({
    action:     z.literal('assess'),
    assessment: RiskAssessmentSchema,
    reasoning:  z.string().max(1000).optional(),
  }),
]);

const SymptomAnalysisSchema = z.object({
  detected_symptoms: z.array(z.string().min(1).max(80)).default([]),
  cluster_key:       z.string().min(1).max(80).optional().nullable(),
  needs_script:      z.boolean().default(false),
  confidence:        z.number().min(0).max(1).optional(),
  reasoning:         z.string().max(2000).optional(),
});

/**
 * Try to parse `raw` (string OR object) as JSON, then validate against
 * `schema`. Returns { ok: true, data } on success, otherwise
 * { ok: false, reason, issues }. Never throws.
 */
function safeValidate(schema, raw) {
  let candidate = raw;
  if (typeof raw === 'string') {
    try {
      // Strip code fences if the model wrapped the JSON in ``` blocks.
      const trimmed = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const match = trimmed.match(/\{[\s\S]*\}/);
      candidate = JSON.parse(match ? match[0] : trimmed);
    } catch (err) {
      return { ok: false, reason: 'invalid_json', issues: [{ message: err.message }] };
    }
  }

  const result = schema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, reason: 'schema_mismatch', issues: result.error.issues };
  }
  return { ok: true, data: result.data };
}

module.exports = {
  RiskTierSchema,
  RiskAssessmentSchema,
  AiQuestionSchema,
  TriageActionSchema,
  SymptomAnalysisSchema,
  safeValidate,
};
