const crypto = require('crypto');
const logger = require('../../lib/logger');
const { assertCrmEventType } = require('./crm-event.catalog');
const { projectCrmPayload, stripContactPii } = require('./crm-event.policy');

const CRM_EVENTS_URL = process.env.CRM_INTEGRATION_URL || '';
const CRM_EVENTS_SECRET = process.env.CRM_INTEGRATION_SECRET || '';
const TIMEOUT_MS = Number(process.env.CRM_INTEGRATION_TIMEOUT_MS || 5000);
const INSECURE_SECRETS = new Set(['change-me-in-development', 'change_me_in_production']);

const assertCrmIntegrationConfig = () => {
  if (CRM_EVENTS_URL && !CRM_EVENTS_SECRET) {
    throw new Error('CRM_INTEGRATION_SECRET is required when CRM_INTEGRATION_URL is configured.');
  }
  if (process.env.NODE_ENV === 'production') {
    if (!CRM_EVENTS_URL) throw new Error('CRM_INTEGRATION_URL is required in production.');
    if (INSECURE_SECRETS.has(CRM_EVENTS_SECRET)) {
      throw new Error('CRM_INTEGRATION_SECRET must be replaced before production deployment.');
    }
  }
};

const isDbClient = (value) => value && typeof value.query === 'function';

const buildCrmEnvelope = (eventType, payload, options = {}) => {
  // backend.asinu is CommonJS JavaScript, so validate at runtime before an
  // invalid event can be written to the durable outbox.
  assertCrmEventType(eventType);
  return {
    event_id: options.event_id || `${eventType}:${crypto.randomUUID()}`,
    event_type: eventType,
    occurred_at: options.occurred_at || new Date().toISOString(),
    source: options.source || 'asinu-backend',
    version: Number(options.version || 1),
    ...(options.correlation_id ? { correlation_id: String(options.correlation_id) } : {}),
    payload: projectCrmPayload(eventType, payload),
  };
};

const deliverCrmEnvelope = async (envelope) => {
  if (!CRM_EVENTS_URL || !CRM_EVENTS_SECRET) return { sent: false, skipped: true };

  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', CRM_EVENTS_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(CRM_EVENTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asinu-timestamp': timestamp,
        'x-asinu-signature': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('crm_event_delivery_failed', {
        event_type: envelope.event_type,
        status: response.status,
      });
      return { sent: false, status: response.status };
    }
    return { sent: true };
  } catch (error) {
    logger.warn('crm_event_delivery_error', { event_type: envelope.event_type, err: error });
    return { sent: false, error: error?.message };
  } finally {
    clearTimeout(timeout);
  }
};

const emitCrmEvent = async (eventType, payload, options = {}) =>
  deliverCrmEnvelope(buildCrmEnvelope(eventType, payload, options));

/**
 * Store an event before attempting delivery. This makes the webhook reliable
 * across CRM downtime and backend restarts. The scheduler retries failed rows.
 */
const enqueueCrmEvent = async (pool, eventType, payload, options = {}) => {
  if (!isDbClient(pool)) return emitCrmEvent(eventType, payload, options);
  if (!CRM_EVENTS_URL || !CRM_EVENTS_SECRET) return { queued: false, skipped: true };

  const envelope = buildCrmEnvelope(eventType, payload, options);
  try {
    await pool.query(
      `INSERT INTO crm_event_outbox
         (event_id, event_type, source, version, correlation_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        envelope.event_id,
        envelope.event_type,
        envelope.source,
        envelope.version,
        envelope.correlation_id || null,
        envelope.occurred_at,
        JSON.stringify(envelope.payload),
      ]
    );
    return { queued: true, event_id: envelope.event_id };
  } catch (error) {
    logger.error('crm_event_enqueue_failed', { event_type: eventType, err: error });
    return { queued: false, error: error?.message };
  }
};

const emitCrmEventAsync = (...args) => {
  // New form: (pool, eventType, payload, options)
  // Legacy form is kept for callers that have not yet been migrated.
  if (isDbClient(args[0])) {
    return enqueueCrmEvent(args[0], args[1], args[2], args[3]);
  }
  return emitCrmEvent(args[0], args[1], args[2]);
};

const getRetryDelaySeconds = (attempts) =>
  Math.min(3600, 30 * 2 ** Math.min(Math.max(attempts - 1, 0), 7));

const flushCrmEventOutbox = async (pool, limit = 50) => {
  if (
    !isDbClient(pool) ||
    typeof pool.connect !== 'function' ||
    !CRM_EVENTS_URL ||
    !CRM_EVENTS_SECRET
  ) {
    return { sent: 0, failed: 0 };
  }

  const client = await pool.connect();
  let rows = [];
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT id, event_id, event_type, source, version, correlation_id, occurred_at, payload, attempts
         FROM crm_event_outbox
        WHERE (
          status IN ('pending', 'failed')
          AND next_attempt_at <= NOW()
        ) OR (
          status = 'processing'
          AND locked_at < NOW() - INTERVAL '5 minutes'
        )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [Math.max(1, Math.min(Number(limit) || 50, 200))]
    );
    rows = selected.rows;
    for (const row of rows) {
      await client.query(
        `UPDATE crm_event_outbox
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
    const result = await deliverCrmEnvelope({
      event_id: row.event_id,
      event_type: row.event_type,
      occurred_at: new Date(row.occurred_at).toISOString(),
      source: row.source,
      version: row.version,
      ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
      payload: row.payload || {},
    });
    if (result.sent) {
      sent++;
      await pool.query(
        `UPDATE crm_event_outbox
            SET status = 'sent', sent_at = NOW(), locked_at = NULL, updated_at = NOW(), last_error = NULL,
                payload = $2::jsonb
          WHERE id = $1`,
        [row.id, JSON.stringify(stripContactPii(row.payload || {}))]
      );
    } else {
      failed++;
      const attempts = Number(row.attempts || 0) + 1;
      const errorMessage = result.error || `CRM returned HTTP ${result.status || 'unknown'}`;
      await pool.query(
        `UPDATE crm_event_outbox
            SET status = 'failed', locked_at = NULL,
                next_attempt_at = NOW() + ($2 || ' seconds')::interval,
                last_error = LEFT($3, 1000), updated_at = NOW()
          WHERE id = $1`,
        [row.id, String(getRetryDelaySeconds(attempts)), errorMessage]
      );
    }
  }
  return { sent, failed };
};

module.exports = {
  assertCrmIntegrationConfig,
  buildCrmEnvelope,
  deliverCrmEnvelope,
  emitCrmEvent,
  emitCrmEventAsync,
  enqueueCrmEvent,
  flushCrmEventOutbox,
};
