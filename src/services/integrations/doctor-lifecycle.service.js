const { z } = require('zod');
const { assertTenantAllowed } = require('./doctor-task.service');
const { verifyDoctorSignature } = require('./doctor-profile.service');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');

const consultationSummarySchema = z
  .object({
    problem_summary: z.string().trim().min(1).max(3000),
    assessment: z.string().trim().min(1).max(3000),
    next_steps: z.string().trim().min(1).max(3000),
    warning_signs: z.string().trim().min(1).max(3000),
    follow_up_recommendation: z.string().trim().min(1).max(3000),
  })
  .strict();

const lifecycleSchema = z
  .object({
    event_id: z.string().trim().min(1).max(160),
    event_type: z.enum([
      'service.accepted',
      'service.started',
      'service.completed',
      'service.cancelled',
      'service.expired',
      'service.failed',
    ]),
    source: z.literal('asinu-doctor'),
    version: z.number().int().min(1).max(10),
    occurred_at: z.string().datetime({ offset: true }),
    correlation_id: z.string().trim().min(1).max(160),
    payload: z
      .object({
        tenant_id: z.string().trim().min(1).max(120),
        app_order_id: z.string().trim().min(1).max(160),
        app_user_id: z.union([z.string().trim().min(1).max(80), z.number().int().positive()]),
        service_code: z.string().trim().min(1).max(120),
        source_channel: z.string().trim().min(1).max(40),
        specialty: z.string().trim().min(1).max(120),
        service_flow: z.enum(['clinical', 'wellness']),
        priority: z.enum(['normal', 'high', 'urgent']),
        summary: z.string().trim().min(1).max(5000),
        status: z.enum(['accepted', 'started', 'completed', 'cancelled', 'expired', 'failed']),
        doctor_ref: z.string().trim().max(160).nullable().optional(),
        medical_record_ref: z.string().trim().max(160).nullable().optional(),
        reason: z.string().trim().max(500).nullable().optional(),
        consultation_summary: consultationSummarySchema.nullable().optional(),
        follow_up_until: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .strict(),
  })
  .strict();

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const isPatientDeletionRace = (error) =>
  error?.code === '23503' &&
  ['doctor_task_lifecycle_events_app_user_id_fkey', 'doctor_patient_medical_records_user_id_fkey'].includes(
    error?.constraint
  );

const ignoredDeletedPatientEvent = (event, payload) => ({
  event_id: event.event_id,
  task_id: payload.app_order_id,
  status: 'ignored',
  duplicate: false,
  ignored_reason: 'PATIENT_ACCOUNT_DELETED',
});

const ingestDoctorLifecycle = async (pool, req) => {
  verifyDoctorSignature(req);
  const parsed = lifecycleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw integrationError(400, 'INVALID_DOCTOR_LIFECYCLE', 'Invalid Doctor lifecycle event.');
  }
  const event = parsed.data;
  const payload = event.payload;
  if (payload.status !== event.event_type.replace('service.', '')) {
    throw integrationError(
      400,
      'DOCTOR_LIFECYCLE_STATUS_MISMATCH',
      'Event type and status must match.'
    );
  }
  assertTenantAllowed(payload.tenant_id);
  if (event.correlation_id !== payload.app_order_id) {
    throw integrationError(
      400,
      'DOCTOR_LIFECYCLE_CORRELATION_MISMATCH',
      'Correlation id must match app order id.'
    );
  }

  const appUserId = String(payload.app_user_id);
  // Account deletion can race with a lifecycle webhook already in flight. If
  // the patient no longer exists, acknowledge the event without recreating any
  // clinical record; returning 404 would make the Doctor delivery worker retry
  // an event that can never be applied after a privacy deletion.
  const patient = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [Number(appUserId)]
  );
  if (!patient.rows[0]) {
    return {
      event_id: event.event_id,
      task_id: payload.app_order_id,
      status: 'ignored',
      duplicate: false,
      ignored_reason: 'PATIENT_ACCOUNT_DELETED',
    };
  }
  const task = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->'payload'->>'task_id' = $2
      LIMIT 1`,
    [payload.tenant_id, payload.app_order_id]
  );
  if (!task.rows[0] || task.rows[0].app_user_id !== appUserId) {
    throw integrationError(404, 'DOCTOR_TASK_NOT_FOUND', 'The Doctor task was not found.');
  }

  const persistConsultationOutcome = async () => {
    if (payload.status !== 'completed' || !payload.consultation_summary) return;
    const summary = payload.consultation_summary;
    await pool.query(
      `INSERT INTO doctor_patient_medical_records(
         user_id, record_type, title, diagnosis, summary, treatment, notes,
         doctor_ref, source_task_id, recorded_at
       )
       SELECT $1, 'consultation_summary', 'Tóm tắt tư vấn bác sĩ', $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (
         SELECT 1 FROM doctor_patient_medical_records
          WHERE user_id = $1 AND source_task_id = $7 AND record_type = 'consultation_summary'
       )`,
      [
        Number(appUserId),
        summary.assessment,
        summary.problem_summary,
        summary.next_steps,
        [
          `Dấu hiệu cảnh báo: ${summary.warning_signs}`,
          `Theo dõi/tái tư vấn: ${summary.follow_up_recommendation}`,
          payload.follow_up_until ? `Trao đổi bổ sung đến: ${payload.follow_up_until}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        payload.doctor_ref || null,
        payload.app_order_id,
        event.occurred_at,
      ]
    );
    await rebuildPatientHealthTimeline(pool, Number(appUserId));
  };
  try {
    const existing = await pool.query(
      'SELECT event_id, task_id, status, occurred_at FROM doctor_task_lifecycle_events WHERE event_id = $1',
      [event.event_id]
    );

    if (existing.rows[0]) {
      await persistConsultationOutcome();
      return { ...existing.rows[0], duplicate: true };
    }

    const inserted = await pool.query(
      `INSERT INTO doctor_task_lifecycle_events(
         event_id, tenant_id, task_id, app_user_id, event_type, status,
         doctor_ref, medical_record_ref, reason, occurred_at, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id, task_id, status, occurred_at`,
      [
        event.event_id,
        payload.tenant_id,
        payload.app_order_id,
        Number(appUserId),
        event.event_type,
        payload.status,
        payload.doctor_ref || null,
        payload.medical_record_ref || null,
        payload.reason || null,
        event.occurred_at,
        JSON.stringify({
          ...payload,
          event_version: event.version,
          source_channel: payload.source_channel,
          specialty: payload.specialty,
          service_flow: payload.service_flow,
          priority: payload.priority,
          summary: payload.summary,
        }),
      ]
    );
    await persistConsultationOutcome();
    return {
      ...(inserted.rows[0] || {
        event_id: event.event_id,
        task_id: payload.app_order_id,
        status: payload.status,
      }),
      duplicate: false,
    };
  } catch (error) {
    // A privacy delete may commit after the existence check but before the FK
    // insert. This is an expected terminal race: acknowledge without retrying
    // a webhook that can no longer be attached to a patient.
    if (isPatientDeletionRace(error)) return ignoredDeletedPatientEvent(event, payload);
    throw error;
  }
};

module.exports = { ingestDoctorLifecycle, lifecycleSchema, isPatientDeletionRace };
