'use strict';

const { isActiveHousehold } = require('./entitlement.service');
const { invalidateHouseholdEntitlements } = require('./entitlement.service');

const conflict = () =>
  Object.assign(new Error('The consultation id belongs to another request.'), {
    statusCode: 409,
    code: 'DOCTOR_TASK_IDEMPOTENCY_CONFLICT',
  });

async function loadEligibleWallet(db, userId, lock = false) {
  const household = (
    await db.query(
      `SELECT h.* FROM subscription_households h
    JOIN subscription_household_members m ON m.household_id=h.id AND m.status='active'
    WHERE m.user_id=$1 ORDER BY (h.owner_user_id=$1) ASC,h.updated_at DESC LIMIT 1 ${lock ? 'FOR UPDATE OF h' : ''}`,
      [userId]
    )
  ).rows[0];
  if (
    !household ||
    !isActiveHousehold(household) ||
    household.billing_period !== 'yearly' ||
    household.plan_code === 'free'
  )
    return null;
  const grant = (
    await db.query(
      `SELECT reference_id,delta FROM consultation_credit_ledger WHERE household_id=$1
    AND reason='annual_grant' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [household.id]
    )
  ).rows[0];
  if (!grant) return null;
  const balance = (
    await db.query(
      `SELECT
    COALESCE((SELECT SUM(delta) FROM consultation_credit_ledger WHERE household_id=$1),0)::int
      -(SELECT COUNT(*) FROM doctor_consultation_credit_reservations WHERE household_id=$1 AND state='reserved')::int AS available,
    EXISTS(SELECT 1 FROM doctor_consultation_credit_reservations WHERE user_id=$2 AND grant_reference=$3 AND state IN ('reserved','consumed')) AS used,
    (SELECT COUNT(*)::int FROM doctor_consultation_credit_reservations WHERE grant_reference=$3 AND state IN ('reserved','consumed')) AS grant_used`,
      [household.id, userId, grant.reference_id]
    )
  ).rows[0];
  return {
    householdId: household.id,
    grantReference: grant.reference_id,
    available: Math.max(0, Number(balance.available)),
    personalAvailable:
      !balance.used &&
      Number(balance.available) > 0 &&
      Number(balance.grant_used) < Number(grant.delta),
  };
}

// Called inside the same transaction as task/outbox creation. Holding the
// household row serializes simultaneous requests from protected members.
async function reserveConsultationCredit(db, userId, tenantId, taskId) {
  let existing = (
    await db.query(
      'SELECT * FROM doctor_consultation_credit_reservations WHERE task_id=$1 FOR UPDATE',
      [taskId]
    )
  ).rows[0];
  if (existing) {
    if (Number(existing.user_id) !== Number(userId) || existing.tenant_id !== tenantId)
      throw conflict();
    return { state: existing.state, householdId: existing.household_id };
  }
  // Requests queued before the credit policy keep their original financial path
  // on retry, even when the patient now has an unused annual gift.
  const legacy = (
    await db.query(
      `SELECT 1 AS legacy FROM doctor_task_outbox WHERE tenant_id=$1
    AND payload->'payload'->>'task_id'=$2 AND payload->'payload'->>'app_user_id'=$3
    AND NOT ((payload->'payload') ? 'credit_state') LIMIT 1`,
      [tenantId, taskId, String(userId)]
    )
  ).rows[0];
  const wallet = legacy ? null : await loadEligibleWallet(db, userId, true);
  // A second transaction may have inserted this task while the wallet lock was pending.
  existing = (
    await db.query(
      'SELECT * FROM doctor_consultation_credit_reservations WHERE task_id=$1 FOR UPDATE',
      [taskId]
    )
  ).rows[0];
  if (existing) {
    if (Number(existing.user_id) !== Number(userId) || existing.tenant_id !== tenantId)
      throw conflict();
    return { state: existing.state, householdId: existing.household_id };
  }
  const reserved = wallet?.personalAvailable === true;
  const result = await db.query(
    `INSERT INTO doctor_consultation_credit_reservations(task_id,tenant_id,user_id,household_id,grant_reference,state)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO NOTHING RETURNING state`,
    [
      taskId,
      tenantId,
      userId,
      reserved ? wallet.householdId : null,
      reserved ? wallet.grantReference : null,
      reserved ? 'reserved' : 'none',
    ]
  );
  if (!result.rows[0]) {
    const same = (
      await db.query('SELECT * FROM doctor_consultation_credit_reservations WHERE task_id=$1', [
        taskId,
      ])
    ).rows[0];
    if (!same || Number(same.user_id) !== Number(userId) || same.tenant_id !== tenantId)
      throw conflict();
    return { state: same.state, householdId: same.household_id };
  }
  return { state: result.rows[0].state, householdId: reserved ? wallet.householdId : null };
}

async function settleConsultationCredit(pool, userId, tenantId, taskId, status) {
  if (
    !['completed', 'cancelled', 'expired', 'failed', 'emergency_referred', 'forwarded'].includes(
      status
    )
  )
    return { state: null };
  const db = await pool.connect();
  let householdId = null;
  let outcome = { state: null };
  try {
    await db.query('BEGIN');
    const initial = (
      await db.query(
        'SELECT household_id FROM doctor_consultation_credit_reservations WHERE task_id=$1 AND user_id=$2 AND tenant_id=$3',
        [taskId, userId, tenantId]
      )
    ).rows[0];
    if (initial?.household_id)
      await db.query('SELECT id FROM subscription_households WHERE id=$1 FOR UPDATE', [
        initial.household_id,
      ]);
    const row = (
      await db.query(
        'SELECT * FROM doctor_consultation_credit_reservations WHERE task_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',
        [taskId, userId, tenantId]
      )
    ).rows[0];
    if (row) {
      outcome = { state: row.state };
      if (row.state === 'reserved') {
        householdId = row.household_id;
        const state = status === 'completed' ? 'consumed' : 'released';
        if (state === 'consumed')
          await db.query(
            `INSERT INTO consultation_credit_ledger(household_id,delta,reason,reference_id,metadata)
          VALUES($1,-1,'consultation_used',$2,$3::jsonb) ON CONFLICT(reason,reference_id) DO NOTHING`,
            [
              row.household_id,
              `doctor:${tenantId}:${taskId}`,
              JSON.stringify({
                user_id: Number(userId),
                task_id: taskId,
                grant_reference: row.grant_reference,
              }),
            ]
          );
        await db.query(
          'UPDATE doctor_consultation_credit_reservations SET state=$2,reason=$3,settled_at=NOW() WHERE task_id=$1',
          [taskId, state, status]
        );
        outcome = { state };
      }
    }
    if (row && ['consumed', 'released'].includes(outcome.state)) {
      await require('../integrations/crm-event.service').enqueueCrmEvent(
        db,
        'service.updated',
        {
          user_id: String(userId),
          app_user_id: String(userId),
          tenant_id: tenantId,
          app_order_id: taskId,
          credit_state: outcome.state,
          dispatch_owner: 'app',
        },
        { event_id: `credit-state:${tenantId}:${taskId}:${outcome.state}`, strict: true }
      );
      if (row.household_id)
        await require('../integrations/crm-domain-events.service').enqueueHouseholdEntitlements(
          db,
          row.household_id
        );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  if (householdId) await invalidateHouseholdEntitlements(pool, householdId);
  return outcome;
}

async function consultationCreditSummary(pool, userId) {
  const wallet = await loadEligibleWallet(pool, userId);
  const held = Number(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM doctor_consultation_credit_reservations WHERE user_id=$1 AND state='reserved'",
        [userId]
      )
    ).rows[0].count
  );
  return {
    available: wallet?.personalAvailable ? 1 : 0,
    held,
    policy: 'reserve_on_request_consume_on_completion',
    legacy_consultation_available: true,
  };
}

module.exports = { reserveConsultationCredit, settleConsultationCredit, consultationCreditSummary };
