const crypto = require('crypto');
const { z } = require('zod');

const doctorTaskRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(120),
    specialty: z.string().trim().min(1).max(120),
    service_flow: z.enum(['clinical', 'wellness']),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    preferred_doctor_id: z.string().uuid().nullable().optional(),
    summary: z.string().trim().min(1).max(5000),
    consent_version: z.string().trim().min(1).max(80),
    task_id: z.string().trim().min(1).max(160).optional(),
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
      summary: input.summary,
      patient_ref: buildPatientRef(user),
      consent: {
        status: 'accepted',
        version: input.consent_version,
      },
    },
  };
};

module.exports = { doctorTaskRequestSchema, buildPatientRef, buildDoctorTaskEnvelope };
