const crypto = require('crypto');
const logger = require('../../lib/logger');
const { deleteAsset } = require('../media/cloudinary-upload.service');
const {
  buildDoctorTaskEnvelope,
  buildPatientRatingEnvelope,
  buildPrivacyRequestEnvelope,
  normalizeSpecialty,
} = require('./doctor-task.policy');

const DOCTOR_TASKS_URL = process.env.DOCTOR_TASKS_URL || '';
const DOCTOR_INTEGRATION_SECRET = process.env.DOCTOR_ASINU_INTEGRATION_SECRET || '';
const TIMEOUT_MS = Number(process.env.DOCTOR_TASKS_TIMEOUT_MS || 5000);
const ALLOWED_TENANT_IDS = new Set(
  (process.env.DOCTOR_ALLOWED_TENANT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const MAX_ATTEMPTS = 8;
const INSECURE_SECRETS = new Set(['change-me-in-development', 'replace-with-a-dedicated-secret']);

const assertDoctorTaskConfig = () => {
  if (!DOCTOR_TASKS_URL) throw new Error('DOCTOR_TASKS_URL is required to request a Doctor task.');
  if (!DOCTOR_INTEGRATION_SECRET || INSECURE_SECRETS.has(DOCTOR_INTEGRATION_SECRET)) {
    throw new Error('DOCTOR_ASINU_INTEGRATION_SECRET must be a dedicated secret.');
  }
  if (process.env.NODE_ENV === 'production' && ALLOWED_TENANT_IDS.size === 0) {
    throw new Error('DOCTOR_ALLOWED_TENANT_IDS is required in production.');
  }
};

const assertTenantAllowed = (tenantId) => {
  if (process.env.NODE_ENV !== 'production' && ALLOWED_TENANT_IDS.size === 0) return;
  if (!ALLOWED_TENANT_IDS.has(tenantId)) {
    const error = new Error('The selected Doctor tenant is not allowed.');
    error.statusCode = 403;
    error.code = 'DOCTOR_TENANT_NOT_ALLOWED';
    throw error;
  }
};

const stableJson = (value) => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    );
  }
  return value;
};

const comparableTaskEnvelope = (envelope) => {
  const { occurred_at: _occurredAt, ...stableEnvelope } = envelope;
  return stableJson(stableEnvelope);
};

const idempotencyConflict = (message) => {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'DOCTOR_TASK_IDEMPOTENCY_CONFLICT';
  return error;
};

const signPayload = (body, timestamp) =>
  'sha256=' +
  crypto
    .createHmac('sha256', DOCTOR_INTEGRATION_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

const integrationUrl = (resource) => {
  const tasksUrl = new URL(DOCTOR_TASKS_URL);
  tasksUrl.pathname = tasksUrl.pathname.replace(/\/tasks\/?$/, `/${resource}`);
  return tasksUrl.toString();
};

const deliverDoctorRequest = async (resource, payload, idempotencyKey) => {
  assertDoctorTaskConfig();
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(integrationUrl(resource), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asinu-timestamp': timestamp,
        'x-asinu-signature': signPayload(body, timestamp),
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
      },
      body,
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        responseBody?.error?.message || `doctor_integration_${response.status}`
      );
      error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      error.code = responseBody?.error?.code || 'DOCTOR_INTEGRATION_FAILED';
      throw error;
    }
    return { status: response.status, data: responseBody?.data ?? responseBody };
  } finally {
    clearTimeout(timeout);
  }
};

const deliverDoctorTask = async (envelope) => {
  const response = await deliverDoctorRequest('tasks', envelope, envelope.idempotency_key);
  return response.status;
};

const assertPatientOwnsTask = async (pool, tenantId, taskId, userId) => {
  const result = await pool.query(
    `SELECT 1
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->'payload'->>'task_id' = $2
        AND payload->'payload'->>'app_user_id' = $3
      LIMIT 1`,
    [tenantId, taskId, String(userId)]
  );
  if (!result.rows[0]) {
    const error = new Error('The Doctor task was not found for this patient.');
    error.statusCode = 404;
    error.code = 'DOCTOR_TASK_NOT_FOUND';
    throw error;
  }
};

const submitPatientRating = async (pool, { userId, taskId, input }) => {
  assertTenantAllowed(input.tenant_id);
  await assertPatientOwnsTask(pool, input.tenant_id, taskId, userId);
  const envelope = buildPatientRatingEnvelope({ userId, taskId, input });
  const response = await deliverDoctorRequest('ratings', envelope, envelope.idempotency_key);
  return response.data;
};

const submitPrivacyRequest = async (pool, { userId, input }) => {
  assertTenantAllowed(input.tenant_id);
  const envelope = buildPrivacyRequestEnvelope({ userId, input });
  const response = await deliverDoctorRequest('privacy', envelope, envelope.idempotency_key);
  const recordReceipt = async () => {
    await pool.query(
      `INSERT INTO doctor_privacy_request_receipts(
         user_id, tenant_id, action, source_event_id, status, result_summary, completed_at
       ) VALUES ($1,$2,$3,$4,'completed',$5::jsonb,NOW())
       ON CONFLICT (source_event_id) DO UPDATE SET status = 'completed',
         result_summary = EXCLUDED.result_summary, completed_at = NOW()`,
      [
        userId,
        input.tenant_id,
        input.action,
        envelope.event_id,
        JSON.stringify({ request_id: response.data?.request_id || null, action: input.action }),
      ]
    );
  };
  if (input.action === 'export') {
    const [records, messages, files, lifecycle, timeline] = await Promise.all([
      pool.query(
        `SELECT id, record_type, title, diagnosis, summary, treatment, notes,
                doctor_ref, source_task_id, recorded_at, created_at, updated_at
           FROM doctor_patient_medical_records
          WHERE user_id = $1 ORDER BY recorded_at`,
        [userId]
      ),
      pool.query(
        `SELECT task_id, sender_type, sender_ref, message_type, content,
                client_message_id, created_at
           FROM doctor_task_messages
          WHERE user_id = $1 ORDER BY created_at`,
        [userId]
      ),
      pool.query(
        `SELECT id, name, mime_type, size_bytes, source_task_id,
                uploaded_by, created_at
           FROM doctor_patient_files
          WHERE user_id = $1 ORDER BY created_at`,
        [userId]
      ),
      pool.query(
        `SELECT event_id, tenant_id, task_id, event_type, status, doctor_ref,
                medical_record_ref, reason, occurred_at, created_at
           FROM doctor_task_lifecycle_events
          WHERE app_user_id = $1 ORDER BY occurred_at`,
        [userId]
      ),
      pool.query(
        `SELECT file_name, content_markdown, checkin_count, updated_at
           FROM patient_health_timeline_documents
          WHERE user_id = $1`,
        [userId]
      ),
    ]);
    const result = {
      ...response.data,
      asinu_doctor_data: {
        medical_records: records.rows,
        patient_files: files.rows,
        task_messages: messages.rows,
        task_lifecycle_events: lifecycle.rows,
        health_timeline: timeline.rows[0] || null,
      },
    };
    await recordReceipt();
    return result;
  }
  if (
    input.action === 'withdraw_consent' ||
    input.action === 'anonymize' ||
    input.action === 'delete'
  ) {
    await pool.query(
      `UPDATE users
          SET consent_accepted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
  }
  if (input.action === 'anonymize' || input.action === 'delete') {
    const files = await pool.query(
      `SELECT public_id, mime_type, resource_type, delivery_type
         FROM doctor_patient_files WHERE user_id = $1`,
      [userId]
    );
    for (const file of files.rows) {
      if (!file.public_id) continue;
      const resourceType = ['image', 'video', 'raw'].includes(file.resource_type)
        ? file.resource_type
        : String(file.mime_type || '').startsWith('video/')
          ? 'video'
          : String(file.mime_type || '').startsWith('image/')
            ? 'image'
            : 'raw';
      const deliveryType = file.delivery_type === 'authenticated' ? 'authenticated' : 'upload';
      await deleteAsset(file.public_id, resourceType, deliveryType);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM doctor_patient_files WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM doctor_patient_medical_records WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM doctor_task_messages WHERE user_id = $1', [userId]);
      // The Markdown document is a denormalized copy of the records above;
      // remove it too so an anonymize/delete request cannot leave stale
      // profile, check-in or consultation content in the database.
      await client.query('DELETE FROM patient_health_timeline_documents WHERE user_id = $1', [
        userId,
      ]);
      await client.query('DELETE FROM doctor_task_lifecycle_events WHERE app_user_id = $1', [
        userId,
      ]);
      await client.query(
        `UPDATE doctor_task_outbox
            SET event_id = 'anon-event-' || id::text,
                idempotency_key = 'anon-key-' || id::text,
                payload = jsonb_build_object(
                  'event_id', 'anon-event-' || id::text,
                  'idempotency_key', 'anon-key-' || id::text,
                  'event_type', 'doctor.task.requested',
                  'source', 'asinu-backend',
                  'version', 1,
                  'tenant_id', tenant_id,
                  'payload', jsonb_build_object(
                    'task_id', 'anon-task-' || id::text,
                    'app_user_id', 'anonymized',
                    'patient_ref', jsonb_build_object('app_user_id', 'anonymized'),
                    'consent', jsonb_build_object('status', 'withdrawn')
                  )
                ),
                updated_at = NOW()
          WHERE tenant_id = $1
            AND payload->'payload'->>'app_user_id' = $2`,
        [input.tenant_id, String(userId)]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  await recordReceipt();
  return response.data;
};

const listPrivacyReceipts = async (pool, userId) => {
  const result = await pool.query(
    `SELECT id, tenant_id, action, source_event_id, status, result_summary,
            created_at, completed_at
       FROM doctor_privacy_request_receipts
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return { items: result.rows };
};

const requestDoctorRecommendations = async ({ input }) => {
  assertTenantAllowed(input.tenant_id);
  const response = await deliverDoctorRequest('recommendations', {
    ...input,
    specialty: normalizeSpecialty(input.specialty),
  });
  return response.data;
};

const requestDoctorSpecialties = async ({ tenantId }) => {
  assertTenantAllowed(tenantId);
  const response = await deliverDoctorRequest('specialties', { tenant_id: tenantId });
  return response.data;
};

const requestDoctorClinics = async () => {
  const tenantIds = [...ALLOWED_TENANT_IDS];
  if (tenantIds.length === 0) {
    throw new Error('DOCTOR_ALLOWED_TENANT_IDS must contain at least one tenant.');
  }
  const response = await deliverDoctorRequest('clinics', { tenant_ids: tenantIds });
  return response.data;
};

const requestDoctorTaskStatus = async ({ input }) => {
  assertTenantAllowed(input.tenant_id);
  const response = await deliverDoctorRequest('status', input);
  return response.data;
};

const enqueueDoctorTask = async (pool, input) => {
  assertDoctorTaskConfig();
  assertTenantAllowed(input.input.tenant_id);
  const envelope = buildDoctorTaskEnvelope(input);
  const envelopeJson = JSON.stringify(envelope);
  const inserted = await pool.query(
    `INSERT INTO doctor_task_outbox(event_id, idempotency_key, tenant_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING event_id`,
    [envelope.event_id, envelope.idempotency_key, envelope.tenant_id, envelopeJson]
  );
  if (!inserted.rowCount) {
    const existing = await pool.query(
      `SELECT payload
         FROM doctor_task_outbox
        WHERE event_id = $1 OR idempotency_key = $2
        LIMIT 1`,
      [envelope.event_id, envelope.idempotency_key]
    );
    if (
      !existing.rows[0] ||
      JSON.stringify(comparableTaskEnvelope(existing.rows[0].payload)) !==
        JSON.stringify(comparableTaskEnvelope(envelope))
    ) {
      throw idempotencyConflict('The task id was already used with different consultation data.');
    }
  }
  return { queued: true, event_id: envelope.event_id, task_id: envelope.payload.task_id };
};

const retryDelaySeconds = (attempts) =>
  Math.min(3600, 30 * 2 ** Math.min(Math.max(attempts - 1, 0), 7));

const flushDoctorTaskOutbox = async (pool, limit = 20) => {
  if (!DOCTOR_TASKS_URL || !DOCTOR_INTEGRATION_SECRET) return { sent: 0, failed: 0, skipped: true };
  const client = await pool.connect();
  let rows = [];
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, event_id, payload, attempts
         FROM doctor_task_outbox
        WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes'))
          AND attempts < $1
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [MAX_ATTEMPTS, Math.max(1, Math.min(Number(limit) || 20, 100))]
    );
    rows = result.rows;
    for (const row of rows) {
      await client.query(
        `UPDATE doctor_task_outbox
            SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
          WHERE id = $1`,
        [row.id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw error;
  }
  client.release();

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const resource =
        row.payload?.event_type === 'doctor.task.message.received' ? 'messages' : 'tasks';
      const status =
        resource === 'tasks'
          ? await deliverDoctorTask(row.payload)
          : (await deliverDoctorRequest(resource, row.payload, row.payload.idempotency_key)).status;
      sent++;
      await pool.query(
        `UPDATE doctor_task_outbox
            SET status = 'sent', sent_at = NOW(), response_status = $2,
                locked_at = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id, status]
      );
    } catch (error) {
      failed++;
      const attempts = Number(row.attempts || 0) + 1;
      const message = error instanceof Error ? error.message : 'doctor_task_delivery_failed';
      logger.warn('doctor_task_delivery_failed', { event_id: row.event_id, error: message });
      await pool.query(
        `UPDATE doctor_task_outbox
            SET status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'failed' END,
                next_attempt_at = NOW() + ($3 || ' seconds')::interval,
                locked_at = NULL, last_error = LEFT($4, 1000), updated_at = NOW()
          WHERE id = $1`,
        [row.id, MAX_ATTEMPTS, String(retryDelaySeconds(attempts)), message]
      );
    }
  }
  return { sent, failed, skipped: false };
};

module.exports = {
  assertDoctorTaskConfig,
  assertTenantAllowed,
  buildDoctorTaskEnvelope,
  deliverDoctorTask,
  deliverDoctorRequest,
  enqueueDoctorTask,
  flushDoctorTaskOutbox,
  submitPatientRating,
  submitPrivacyRequest,
  requestDoctorRecommendations,
  requestDoctorSpecialties,
  requestDoctorClinics,
  requestDoctorTaskStatus,
  listPrivacyReceipts,
};
