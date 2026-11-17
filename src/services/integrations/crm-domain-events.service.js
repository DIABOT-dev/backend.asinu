'use strict';

const { enqueueCrmEvent } = require('./crm-event.service');
const enabled = () =>
  Boolean(process.env.CRM_INTEGRATION_URL && process.env.CRM_INTEGRATION_SECRET);

async function enqueueProjection(db, type, resourceId, payload, options = {}) {
  if (!enabled()) return null;
  const clock = (
    await db.query(
      `INSERT INTO crm_projection_revisions(projection,resource_id)
    VALUES($1,$2) ON CONFLICT(projection,resource_id) DO UPDATE SET
    revision=crm_projection_revisions.revision+1,updated_at=clock_timestamp()
    RETURNING revision,updated_at`,
      [type, String(resourceId)]
    )
  ).rows[0];
  const sourceRevision = Number(clock.revision);
  return enqueueCrmEvent(
    db,
    type,
    { ...payload, source_revision: sourceRevision },
    {
      event_id: `${type}:${resourceId}:${sourceRevision}`,
      occurred_at: new Date(clock.updated_at).toISOString(),
      strict: true,
      ...(options.projectionOnly ? { correlation_id: 'crm-snapshot' } : {}),
    }
  );
}

async function enqueueUserEntitlements(db, userIds, options = {}) {
  if (!enabled()) return;
  const unique = [
    ...new Set(userIds.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)),
  ].sort((a, b) => a - b);
  if (!unique.length) return;
  await db.query('SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR NO KEY UPDATE', [
    unique,
  ]);
  const rows = await db.query(
    `SELECT u.id,h.id household_id,h.owner_user_id,h.plan_code,h.status,h.billing_period,
    h.protected_member_limit,h.current_period_end,m.user_id IS NOT NULL AS is_protected_member,
    (SELECT COUNT(*)::int FROM subscription_household_members x WHERE x.household_id=h.id AND x.status='active') protected_member_count,
    COALESCE((SELECT SUM(delta)::int FROM consultation_credit_ledger WHERE household_id=h.id),0) credits,
    (SELECT COUNT(*)::int FROM doctor_consultation_credit_reservations WHERE household_id=h.id AND state='reserved') reserved
    FROM users u LEFT JOIN subscription_household_members m ON m.user_id=u.id AND m.status='active'
    LEFT JOIN subscription_households h ON h.id=m.household_id OR (m.household_id IS NULL AND h.owner_user_id=u.id)
    WHERE u.id=ANY($1::integer[]) AND u.deleted_at IS NULL ORDER BY u.id`,
    [unique]
  );
  for (const row of rows.rows) {
    const active =
      ['active', 'grace_period'].includes(row.status) &&
      row.plan_code !== 'free' &&
      row.current_period_end &&
      new Date(row.current_period_end) > new Date();
    await enqueueProjection(
      db,
      'entitlement.updated',
      String(row.id),
      {
        user_id: String(row.id),
        household_id: row.household_id == null ? null : String(row.household_id),
        owner_user_id: row.owner_user_id == null ? String(row.id) : String(row.owner_user_id),
        plan_code: active ? row.plan_code : 'free',
        status: active ? 'active' : row.status || 'active',
        billing_period: active ? row.billing_period : null,
        is_owner: Number(row.owner_user_id || row.id) === Number(row.id),
        is_protected_member: row.is_protected_member === true,
        protected_member_limit: active ? Number(row.protected_member_limit) : 1,
        protected_member_count: Number(row.protected_member_count || 0),
        credit_available: active ? Math.max(0, Number(row.credits) - Number(row.reserved)) : 0,
        credit_reserved: Number(row.reserved || 0),
        expires_at: active ? new Date(row.current_period_end).toISOString() : null,
      },
      options
    );
  }
}

async function enqueueHouseholdEntitlements(db, householdId, affectedIds = []) {
  if (!enabled()) return;
  const users = await db.query(
    `SELECT owner_user_id user_id FROM subscription_households WHERE id=$1
    UNION SELECT user_id FROM subscription_household_members WHERE household_id=$1 AND status='active'`,
    [householdId]
  );
  await enqueueUserEntitlements(db, [...users.rows.map((x) => Number(x.user_id)), ...affectedIds]);
}

async function enqueueOperation(db, domain, resourceId, userId, state, metadata = {}) {
  const type = {
    medication: 'medication.updated',
    reward: 'reward.updated',
    early_signal: 'early_signal.updated',
    notification: 'notification.delivery_updated',
    onboarding: 'onboarding.updated',
  }[domain];
  if (!type) throw new Error('Unknown CRM operational domain');
  return enqueueProjection(db, type, String(resourceId), {
    ...metadata,
    user_id: String(userId),
    resource_id: String(resourceId),
    state,
  });
}

module.exports = {
  enqueueProjection,
  enqueueUserEntitlements,
  enqueueHouseholdEntitlements,
  enqueueOperation,
};
