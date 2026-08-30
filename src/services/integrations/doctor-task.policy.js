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

const buildPatientRef = (user) => ({
  app_user_id: String(user.id),
  display_name: user.display_name || user.full_name || null,
  age_group: user.age_group || null,
  gender: user.gender || null,
  profile_version: user.profile_version ? new Date(user.profile_version).toISOString() : null,
});

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
      specialty: input.specialty,
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
  buildPatientRef,
  buildDoctorTaskEnvelope,
  buildPatientRatingEnvelope,
  buildPrivacyRequestEnvelope,
};
