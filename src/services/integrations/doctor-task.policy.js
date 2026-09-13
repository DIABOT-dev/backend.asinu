const crypto = require('crypto');
const { z } = require('zod');

const doctorTaskRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    specialty: z.string().trim().min(1).max(120),
    service_flow: z.enum(['clinical', 'wellness']),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    preferred_doctor_id: z.string().uuid().nullable().optional(),
    source_channel: z.string().trim().min(1).max(40).default('asinu-mobile'),
    service_code: z.string().trim().min(1).max(120).default('doctor-consultation'),
    medical_record_ref: z.string().trim().max(160).nullable().optional(),
    summary: z.string().trim().min(1).max(5000),
    clinical_intake: z
      .object({
        symptom_onset: z.enum(['today', 'two_to_seven_days', 'over_one_week', 'ongoing']),
        progression: z.enum(['improving', 'stable', 'worsening']),
        severity: z.enum(['mild', 'moderate', 'severe']),
        emergency_confirmation: z.literal(true),
      })
      .strict(),
    consent_version: z.string().trim().min(1).max(80),
    task_id: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const patientRatingRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    score: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).optional(),
    request_id: z.string().uuid().optional(),
  })
  .strict();

const privacyRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    action: z.enum(['withdraw_consent', 'export', 'anonymize', 'delete']),
    reason: z.string().trim().max(1000).optional(),
    request_id: z.string().uuid().optional(),
    confirmation: z.literal('CONFIRM_DOCTOR_DATA_REQUEST'),
  })
  .strict();

const doctorRecommendationRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    specialty: z.string().trim().min(1).max(120),
    service_flow: z.enum(['clinical', 'wellness']),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    preferred_doctor_id: z.string().uuid().nullable().optional(),
    limit: z.number().int().min(1).max(10).default(3),
  })
  .strict();

const patientMessageRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(5000),
    message_type: z.enum(['reply', 'follow_up']).default('reply'),
    client_message_id: z.string().uuid(),
  })
  .strict();

const doctorMessageQuerySchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    task_id: z.string().trim().min(1).max(160),
    app_user_id: z.string().trim().min(1).max(80),
  })
  .strict();

const doctorMessageSendSchema = doctorMessageQuerySchema
  .extend({
    content: z.string().trim().min(1).max(5000),
    message_type: z.enum(['question', 'consultation', 'follow_up']),
    client_message_id: z.string().uuid(),
    sender_ref: z.string().trim().min(1).max(160),
  })
  .strict();

const doctorAiAssistSchema = doctorMessageQuerySchema
  .extend({
    touchpoint: z.enum([
      'patient_summary',
      'suggested_questions',
      'consultation_draft',
      'auto_triage',
    ]),
    task_summary: z.string().trim().min(1).max(5000),
    locale: z.enum(['vi', 'en']).default('vi'),
  })
  .strict();

const normalizeSpecialty = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đ]/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const aliases = {
    general: ['general', 'general_practice', 'tong_quat', 'bac_si_tu_van'],
    internal_medicine: ['internal_medicine', 'noi_khoa'],
    cardiology: ['cardiology', 'tim_mach'],
    endocrinology: ['endocrinology', 'noi_tiet', 'dai_thao_duong'],
    dermatology: ['dermatology', 'da_lieu'],
    pediatrics: ['pediatrics', 'nhi_khoa', 'nhi'],
    nutrition: ['nutrition', 'dinh_duong'],
    psychology: ['psychology', 'tam_ly'],
    other: ['other', 'wellness', 'khac'],
  };
  return Object.entries(aliases).find(([, values]) => values.includes(normalized))?.[0] || 'other';
};

const buildPatientRef = (user) => ({
  app_user_id: String(user.id),
  display_name: user.display_name || user.full_name || null,
  age_group: user.age_group || null,
  gender: user.gender || null,
  profile_version: user.profile_version ? new Date(user.profile_version).toISOString() : null,
});

const EMERGENCY_PATTERNS = [
  /\b(đau ngực dữ dội|khó thở dữ dội|ngất|co giật|liệt nửa người|chảy máu không cầm|tự tử|cấp cứu|chấn thương nặng)\b/i,
  /\b(severe chest pain|severe shortness of breath|unconscious|seizure|stroke|suicid|emergency|major trauma)\b/i,
];

const removeNegatedEmergencyStatements = (summary) =>
  summary
    .replace(
      /\b(không|chưa)\s+(?:có\s+)?(?:bất kỳ\s+)?(?:dấu hiệu\s+)?(đau ngực dữ dội|khó thở dữ dội|ngất|co giật|liệt nửa người|chảy máu không cầm|tự tử|cấp cứu|chấn thương nặng)\b/gi,
      ''
    )
    .replace(
      /\b(no|without)\s+(?:signs?\s+of\s+)?(severe chest pain|severe shortness of breath|unconsciousness|seizure|stroke|suicidal ideation|emergency|major trauma)\b/gi,
      ''
    );

const screenRemoteCareSuitability = (input) => {
  const summary = removeNegatedEmergencyStatements(input.summary);
  const emergency =
    input.clinical_intake?.emergency_confirmation !== true ||
    EMERGENCY_PATTERNS.some((pattern) => pattern.test(summary));
  return {
    emergency,
    suitable_for_remote_care: !emergency,
    reason: emergency ? 'emergency_red_flag' : 'screened_no_emergency_red_flag',
    screened_at: new Date().toISOString(),
    screening_version: 'remote-care-v1',
  };
};

const buildDoctorTaskEnvelope = ({ user, input }) => {
  const taskId = input.task_id || `doctor-task:${user.id}:${crypto.randomUUID()}`;
  const eventId = `doctor.task.requested:${taskId}`;
  return {
    event_id: eventId,
    idempotency_key: eventId,
    event_type: 'doctor.task.requested',
    occurred_at: new Date().toISOString(),
    source: 'asinu-backend',
    version: 1,
    tenant_id: input.tenant_id,
    payload: {
      task_id: taskId,
      app_user_id: String(user.id),
      specialty: normalizeSpecialty(input.specialty),
      service_flow: input.service_flow,
      priority: input.priority,
      preferred_doctor_id: input.preferred_doctor_id || null,
      source_channel: input.source_channel,
      service_code: input.service_code,
      medical_record_ref: input.medical_record_ref || null,
      summary: input.summary,
      patient_ref: buildPatientRef(user),
      consent: {
        status: 'accepted',
        version: input.consent_version,
      },
      legal_screening: screenRemoteCareSuitability(input),
      clinical_intake: input.clinical_intake,
    },
  };
};

const buildPatientRatingEnvelope = ({ userId, taskId, input }) => {
  const eventId = `doctor.task.rating.submitted:${input.request_id || crypto.randomUUID()}`;
  return {
    event_id: eventId,
    idempotency_key: eventId,
    event_type: 'doctor.task.rating.submitted',
    occurred_at: new Date().toISOString(),
    source: 'asinu-backend',
    version: 1,
    tenant_id: input.tenant_id,
    payload: {
      task_id: taskId,
      app_user_id: String(userId),
      score: input.score,
      ...(input.comment ? { comment: input.comment } : {}),
    },
  };
};

const buildPrivacyRequestEnvelope = ({ userId, input }) => {
  const eventId = `doctor.privacy.requested:${input.request_id || crypto.randomUUID()}`;
  return {
    event_id: eventId,
    idempotency_key: eventId,
    event_type: 'doctor.privacy.requested',
    occurred_at: new Date().toISOString(),
    source: 'asinu-backend',
    version: 1,
    tenant_id: input.tenant_id,
    payload: {
      app_user_id: String(userId),
      action: input.action,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
};

module.exports = {
  doctorTaskRequestSchema,
  patientRatingRequestSchema,
  privacyRequestSchema,
  doctorRecommendationRequestSchema,
  patientMessageRequestSchema,
  doctorMessageQuerySchema,
  doctorMessageSendSchema,
  doctorAiAssistSchema,
  buildPatientRef,
  buildDoctorTaskEnvelope,
  buildPatientRatingEnvelope,
  buildPrivacyRequestEnvelope,
  screenRemoteCareSuitability,
  normalizeSpecialty,
};
