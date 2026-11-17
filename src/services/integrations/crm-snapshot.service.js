'use strict';
const { buildCrmEnvelope } = require('./crm-event.service');

async function snapshot(pool, { cursor = 0, limit = 25 } = {}) {
  const users = (
    await pool.query(
      'SELECT id FROM users WHERE id>$1 AND deleted_at IS NULL ORDER BY id LIMIT $2',
      [cursor, limit]
    )
  ).rows;
  const ids = users.map((x) => Number(x.id)),
    events = [];
  if (!ids.length) return { events, next_cursor: null };
  const { getCrmUserPayload } = require('../auth/auth.service');
  for (const id of ids) {
    const payload = await getCrmUserPayload(pool, id);
    if (payload)
      events.push(buildCrmEnvelope('user.updated', payload, { correlation_id: 'crm-snapshot' }));
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const before = (await db.query('SELECT COALESCE(MAX(id),0) id FROM crm_event_outbox')).rows[0]
      .id;
    await require('./crm-domain-events.service').enqueueUserEntitlements(db, ids, {
      projectionOnly: true,
    });
    const entitlements = await db.query(
      `SELECT event_id,event_type,source,version,occurred_at,correlation_id,payload
      FROM crm_event_outbox WHERE id>$1 AND event_type='entitlement.updated' AND payload->>'user_id'=ANY($2::text[])`,
      [before, ids.map(String)]
    );
    events.push(
      ...entitlements.rows.map((r) => ({
        ...r,
        occurred_at: new Date(r.occurred_at).toISOString(),
      }))
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  const emit = (type, resourceId, userId, state, at, metadata = {}) =>
    events.push(
      buildCrmEnvelope(
        type,
        { ...metadata, user_id: String(userId), resource_id: String(resourceId), state },
        {
          correlation_id: 'crm-snapshot',
          event_id: `snapshot:${type}:${resourceId}:${new Date(at).toISOString()}`,
          occurred_at: new Date(at).toISOString(),
        }
      )
    );
  const medications = await pool.query(
    `SELECT DISTINCT ON(patient_user_id) id,patient_user_id,state,scheduled_at,updated_at
    FROM med_dose_events WHERE patient_user_id=ANY($1::integer[]) ORDER BY patient_user_id,updated_at DESC,id DESC`,
    [ids]
  );
  for (const row of medications.rows)
    emit('medication.updated', row.id, row.patient_user_id, row.state, row.updated_at, {
      scheduled_at: new Date(row.scheduled_at).toISOString(),
    });
  const rewards = await pool.query(
    `SELECT id,user_id,status,catalog_code,cost,created_at FROM reward_redemptions
    WHERE user_id=ANY($1::integer[]) ORDER BY created_at DESC LIMIT 100`,
    [ids]
  );
  for (const row of rewards.rows)
    emit('reward.updated', row.id, row.user_id, row.status, row.created_at, {
      kind: 'redemption',
      reward_code: row.catalog_code,
      delta: -Number(row.cost || 0),
    });
  const balances = await pool.query(
    'SELECT user_id,balance,updated_at FROM coin_balances WHERE user_id=ANY($1::integer[])',
    [ids]
  );
  for (const row of balances.rows)
    emit('reward.updated', 'balance:' + row.user_id, row.user_id, 'ACTIVE', row.updated_at, {
      kind: 'balance',
      balance: Number(row.balance),
    });
  const alerts = await pool.query(
    `SELECT DISTINCT ON(user_id) id,user_id,severity,created_at FROM early_signal_assessments
    WHERE user_id=ANY($1::integer[]) ORDER BY user_id,created_at DESC,id DESC`,
    [ids]
  );
  for (const row of alerts.rows)
    emit('early_signal.updated', row.id, row.user_id, row.severity.toUpperCase(), row.created_at);
  const notifications = await pool.query(
    `SELECT n.id,n.user_id,o.state,o.updated_at,n.type FROM notification_push_outbox o
    JOIN notifications n ON n.id=o.notification_id WHERE n.user_id=ANY($1::integer[]) ORDER BY o.updated_at DESC LIMIT 100`,
    [ids]
  );
  for (const row of notifications.rows)
    emit('notification.delivery_updated', row.id, row.user_id, row.state, row.updated_at, {
      channel: 'push',
      kind: row.type,
    });
  const onboarding = await pool.query(
    'SELECT user_id,onboarding_completed_at,updated_at FROM user_onboarding_profiles WHERE user_id=ANY($1::integer[])',
    [ids]
  );
  for (const row of onboarding.rows)
    emit(
      'onboarding.updated',
      row.user_id,
      row.user_id,
      row.onboarding_completed_at ? 'COMPLETED' : 'PENDING',
      row.updated_at
    );
  const links = await pool.query(
    `SELECT id,requester_id,addressee_id,status,relationship_type,role,permissions,updated_at
    FROM user_connections WHERE requester_id=ANY($1::integer[]) OR addressee_id=ANY($1::integer[]) ORDER BY updated_at DESC LIMIT 500`,
    [ids]
  );
  for (const row of links.rows)
    events.push(
      buildCrmEnvelope(
        'care_circle.updated',
        {
          user_id: String(row.requester_id),
          patient_user_id: String(row.requester_id),
          caregiver_user_id: String(row.addressee_id),
          connection_id: String(row.id),
          status:
            row.status === 'accepted'
              ? 'active'
              : row.status === 'pending'
                ? 'pending'
                : 'inactive',
          relationship_type: row.relationship_type,
          role: row.role,
          can_receive_alerts: row.permissions?.can_receive_alerts === true,
          can_view_logs: row.permissions?.can_view_logs === true,
          can_ack_escalation: row.permissions?.can_ack_escalation === true,
        },
        {
          correlation_id: 'crm-snapshot',
          event_id: `snapshot:care:${row.id}:${new Date(row.updated_at).toISOString()}`,
          occurred_at: new Date(row.updated_at).toISOString(),
        }
      )
    );
  return { events, next_cursor: users.length === limit ? ids.at(-1) : null };
}
module.exports = { snapshot };
