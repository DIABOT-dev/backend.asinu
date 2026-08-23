const crypto = require('crypto');
const logger = require('../../lib/logger');
const { buildDoctorTaskEnvelope } = require('./doctor-task.policy');

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

const signPayload = (body, timestamp) =>
  'sha256=' +
  crypto
    .createHmac('sha256', DOCTOR_INTEGRATION_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

const deliverDoctorTask = async (envelope) => {
  assertDoctorTaskConfig();
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(DOCTOR_TASKS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asinu-timestamp': timestamp,
        'x-asinu-signature': signPayload(body, timestamp),
        'x-idempotency-key': envelope.idempotency_key,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`doctor_task_${response.status}`);
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
};

const enqueueDoctorTask = async (pool, input) => {
  assertDoctorTaskConfig();
  assertTenantAllowed(input.input.tenant_id);
  const envelope = buildDoctorTaskEnvelope(input);
  await pool.query(
    `INSERT INTO doctor_task_outbox(event_id, idempotency_key, tenant_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [envelope.event_id, envelope.idempotency_key, envelope.tenant_id, JSON.stringify(envelope)]
  );
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
      const status = await deliverDoctorTask(row.payload);
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
  enqueueDoctorTask,
  flushDoctorTaskOutbox,
};
