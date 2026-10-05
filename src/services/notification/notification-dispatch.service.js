'use strict';

const { createHash } = require('node:crypto');
const { canSendNonUrgent, hasReminderOptIn, isOptInType } = require('./notification.policy');
const { sendPushNotification } = require('./push.notification.service');
const logger = require('../../lib/logger');
const { buildNotificationTopics } = require('./notification-topic.service');

// Every writer sharing the daily budget must use the same per-user transaction lock.
async function withNotificationTransaction(pool, userId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `notification-user:${userId}`,
    ]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function notificationEventKey(data) {
  const identity = {};
  for (const key of [
    'eventId',
    'event_id',
    'messageId',
    'message_id',
    'paymentId',
    'payment_id',
    'transactionId',
    'transaction_id',
    'assessmentId',
    'episodeId',
    'alertId',
    'checkinId',
    'task_id',
    'patientId',
    'patient_id',
    'reengage_patient_id',
    'userId',
    'guardianId',
    'connectionId',
    'connection_id',
    'subscriptionId',
    'subscription_id',
    'feedItemId',
    'sourceUserId',
    'action',
    'trigger',
    'inactive_days',
  ]) {
    if (data[key] !== undefined && data[key] !== null) identity[key] = String(data[key]);
  }
  if (!Object.keys(identity).length) return null;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

async function reserveNotification(
  pool,
  {
    userId,
    type,
    title,
    body,
    data = {},
    priority = 'low',
    cooldownMinutes = 5,
    spacingTypes = [],
    push = true,
    pushBody = body,
  }
) {
  return withNotificationTransaction(pool, userId, async (client) => {
    const eventKey = notificationEventKey(data);
    // Different patients/events must not suppress each other's alerts. Retrying
    // a failed push reuses the same inbox row rather than consuming the cap again.
    if (cooldownMinutes > 0 && (type !== 'doctor_message' || eventKey)) {
      const recent = await client.query(
        `SELECT id FROM notifications WHERE user_id = $1 AND type = $2
           AND event_key IS NOT DISTINCT FROM $3
           AND created_at >= NOW() - make_interval(mins => $4)
         ORDER BY created_at DESC LIMIT 1`,
        [userId, type, eventKey, cooldownMinutes]
      );
      if (recent.rows[0]) return { notificationId: recent.rows[0].id, existing: true };
    }
    if (!(await canSendNonUrgent(client, userId, type))) return null;
    if (spacingTypes.length) {
      const recent = await client.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = ANY($2::text[])
           AND created_at >= NOW() - INTERVAL '5 minutes' LIMIT 1`,
        [userId, spacingTypes]
      );
      if (recent.rows.length) return null;
    }
    const inserted = await client.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority, event_key)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [userId, type, title, body, JSON.stringify(data), priority, eventKey]
    );
    const notificationId = inserted.rows[0].id;
    if (push) {
      await client.query(
        `INSERT INTO notification_push_outbox (notification_id, push_body) VALUES ($1,$2)`,
        [notificationId, pushBody]
      );
    }
    return { notificationId, existing: false };
  });
}

async function hasCurrentRecipientPermission(client, notification) {
  const data = notification.data || {};
  if (data.topic?.kind === 'medical_condition') {
    const profile = await client.query(
      'SELECT medical_conditions FROM user_onboarding_profiles WHERE user_id = $1',
      [notification.user_id]
    );
    // A profile edit must invalidate a queued reminder about a removed disease.
    const conditions = profile.rows[0]?.medical_conditions || [];
    const current = Array.isArray(conditions) ? conditions : [];
    const matches = current.some(
      (condition) =>
        buildNotificationTopics({ medicalConditions: [condition] }).topCondition?.code ===
        data.topic.code
    );
    if (!matches) return false;
  }
  if (data.topic?.kind === 'symptom' && data.topic.recordedAt) {
    const age = Date.now() - new Date(data.topic.recordedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) return false;
  }
  if (notification.type === 'health_feed') {
    const preferences = await client.query(
      'SELECT health_feed_enabled FROM user_notification_preferences WHERE user_id = $1',
      [notification.user_id]
    );
    if (preferences.rows[0]?.health_feed_enabled === false) return false;
  }
  const subjectId =
    data.patientId ||
    data.patient_id ||
    data.reengage_patient_id ||
    data.sourceUserId ||
    (notification.type === 'early_signal' ? data.userId : null);
  if (!subjectId || String(subjectId) === String(notification.user_id)) return true;
  if (data.alertId && ['caregiver_alert', 'emergency'].includes(notification.type)) {
    const alert = await client.query(
      'SELECT 1 FROM caregiver_alert_confirmations WHERE id = $1 AND caregiver_id = $2 AND confirmed_at IS NULL',
      [data.alertId, notification.user_id]
    );
    if (!alert.rows.length) return false;
  }
  const result = await client.query(
    `SELECT 1 FROM user_connections c
      JOIN users subject ON subject.id = $2 AND subject.deleted_at IS NULL
     WHERE c.status = 'accepted'
       AND ((c.requester_id = $1 AND c.addressee_id = $2)
         OR (c.requester_id = $2 AND c.addressee_id = $1))
       AND COALESCE((c.permissions->>'can_receive_alerts')::boolean, false) = true
     UNION ALL
     SELECT 1 FROM subscription_household_members m
      JOIN subscription_households h ON h.id = m.household_id
      JOIN users subject ON subject.id = m.user_id AND subject.deleted_at IS NULL
     WHERE $3 = 'early_signal' AND h.owner_user_id = $1 AND m.user_id = $2
       AND m.status = 'active'
     LIMIT 1`,
    [notification.user_id, subjectId, notification.type]
  );
  return result.rows.length > 0;
}

async function deliverNotification(pool, notificationId) {
  const client = await pool.connect();
  let claimed;
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT n.id, n.user_id, n.type, n.title, n.data, o.push_body, o.attempts,
              u.push_token, u.deleted_at, ub.timezone, o.expires_at <= NOW() AS expired
         FROM notification_push_outbox o JOIN notifications n ON n.id = o.notification_id
         JOIN users u ON u.id = n.user_id
         LEFT JOIN user_baselines ub ON ub.user_id = n.user_id
        WHERE o.notification_id = $1
          AND ((o.state IN ('PENDING','RETRY') AND o.next_attempt_at <= NOW())
            OR (o.state = 'INFLIGHT' AND o.lease_until < NOW()))
        FOR UPDATE OF o SKIP LOCKED`,
      [notificationId]
    );
    claimed = selected.rows[0];
    if (!claimed) {
      await client.query('COMMIT');
      return { ok: false, skipped: true };
    }
    const optedIn = !isOptInType(claimed.type) || (await hasReminderOptIn(client, claimed.user_id));
    const permitted = await hasCurrentRecipientPermission(client, claimed);
    if (
      claimed.expired ||
      claimed.attempts >= 5 ||
      claimed.deleted_at ||
      !optedIn ||
      !permitted ||
      !claimed.push_token
    ) {
      await client.query(
        `UPDATE notification_push_outbox SET state = 'CANCELLED', updated_at = NOW()
         WHERE notification_id = $1`,
        [notificationId]
      );
      await client.query('COMMIT');
      return {
        ok: !claimed.push_token && !claimed.deleted_at && optedIn && permitted && !claimed.expired,
        skipped: true,
      };
    }
    if (claimed.type === 'health_feed') {
      const { isWithinPushWindow, resolveTimezone } = require('../health_feed/config');
      if (!isWithinPushWindow(resolveTimezone(claimed.timezone))) {
        await client.query(
          `UPDATE notification_push_outbox SET state = 'RETRY', lease_until = NULL,
          next_attempt_at = NOW() + INTERVAL '30 minutes', updated_at = NOW() WHERE notification_id = $1`,
          [notificationId]
        );
        await client.query('COMMIT');
        return { ok: false, skipped: true };
      }
    }
    await client.query(
      `UPDATE notification_push_outbox SET state = 'INFLIGHT', attempts = attempts + 1,
        lease_until = NOW() + INTERVAL '2 minutes', updated_at = NOW() WHERE notification_id = $1`,
      [notificationId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.warn('notification.claim_failed', { notificationId, error });
    return { ok: false };
  } finally {
    client.release();
  }
  let result;
  try {
    result = await sendPushNotification([claimed.push_token], claimed.title, claimed.push_body, {
      ...claimed.data,
      type: claimed.type,
    });
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const invalid = result?.invalidTokens?.includes(claimed.push_token);
  if (invalid) {
    await pool.query('UPDATE users SET push_token = NULL WHERE id = $1 AND push_token = $2', [
      claimed.user_id,
      claimed.push_token,
    ]);
  }
  const state = result?.ok ? 'SENT' : invalid || claimed.attempts + 1 >= 5 ? 'FAILED' : 'RETRY';
  await pool.query(
    `UPDATE notification_push_outbox SET state = $2, lease_until = NULL,
      next_attempt_at = NOW() + make_interval(secs => $3), updated_at = NOW()
     WHERE notification_id = $1 AND state = 'INFLIGHT' AND attempts = $4`,
    [notificationId, state, 60 * 2 ** claimed.attempts, claimed.attempts + 1]
  );
  return { ok: Boolean(result?.ok) };
}

async function retryPendingNotifications(pool, limit = 50) {
  const { rows } = await pool.query(
    `SELECT notification_id FROM notification_push_outbox
      WHERE (state IN ('PENDING','RETRY') AND next_attempt_at <= NOW())
         OR (state = 'INFLIGHT' AND lease_until < NOW())
      ORDER BY next_attempt_at LIMIT $1`,
    [limit]
  );
  let sent = 0;
  for (const row of rows) {
    const result = await deliverNotification(pool, row.notification_id);
    if (result.ok && !result.skipped) sent++;
  }
  return { scanned: rows.length, sent };
}

module.exports = {
  withNotificationTransaction,
  notificationEventKey,
  reserveNotification,
  deliverNotification,
  retryPendingNotifications,
};
