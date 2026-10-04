'use strict';

const { cacheDel } = require('../../lib/redis');
const { planDefinition, localizedPlanName } = require('./subscription-catalog');

function isActiveHousehold(row) {
  if (!row || !['active', 'grace_period'].includes(row.status)) return false;
  if (row.plan_code === 'free') return true;
  return Boolean(row.current_period_end && new Date(row.current_period_end) > new Date());
}

async function ensureHousehold(pool, ownerUserId) {
  // A checked-out pg PoolClient still exposes connect(), but calling it again
  // fails with "Client has already been connected". Only acquire/release when
  // we were given the Pool rather than a client inside an existing transaction.
  const ownsClient = typeof pool.connect === 'function' && typeof pool.release !== 'function';
  const client = ownsClient ? await pool.connect() : pool;
  try {
    if (ownsClient) await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO subscription_households (owner_user_id)
       VALUES ($1)
       ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = subscription_households.updated_at
       RETURNING *`,
      [ownerUserId]
    );
    const household = created.rows[0];
    await client.query(
      `INSERT INTO subscription_household_members (household_id, user_id, added_by)
       SELECT $1, $2, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM subscription_household_members
           WHERE user_id = $2 AND status = 'active'
        )
       ON CONFLICT (household_id, user_id) DO NOTHING`,
      [household.id, ownerUserId]
    );
    if (ownsClient) await client.query('COMMIT');
    return household;
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

async function householdOwnedBy(pool, ownerUserId) {
  const result = await pool.query(
    `SELECT h.*,
            COALESCE((SELECT SUM(delta) FROM consultation_credit_ledger l WHERE l.household_id = h.id), 0)::integer AS consultation_credits,
            (SELECT COUNT(*)::integer FROM subscription_household_members m WHERE m.household_id = h.id AND m.status = 'active') AS protected_member_count,
            EXISTS (SELECT 1 FROM subscription_household_members m WHERE m.household_id = h.id AND m.user_id = $1 AND m.status = 'active') AS is_protected_member
       FROM subscription_households h
      WHERE h.owner_user_id = $1`,
    [ownerUserId]
  );
  if (result.rows[0]) return result.rows[0];
  return { ...(await ensureHousehold(pool, ownerUserId)), is_protected_member: true };
}

async function householdProtecting(pool, userId) {
  const result = await pool.query(
    `SELECT h.*, m.added_at, true AS is_protected_member,
            COALESCE((SELECT SUM(delta) FROM consultation_credit_ledger l WHERE l.household_id = h.id), 0)::integer AS consultation_credits,
            (SELECT COUNT(*)::integer FROM subscription_household_members x WHERE x.household_id = h.id AND x.status = 'active') AS protected_member_count
       FROM subscription_household_members m
       JOIN subscription_households h ON h.id = m.household_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (h.owner_user_id = $1) ASC, h.updated_at DESC
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

function toEntitlement(household, userId) {
  const active = isActiveHousehold(household);
  const planCode = active ? household.plan_code : 'free';
  const plan = planDefinition(planCode);
  const isProtectedMember = household?.is_protected_member === true;
  return {
    planCode,
    planName: localizedPlanName(planCode),
    tier: planCode === 'free' ? 'free' : 'antam',
    isAnTam: planCode !== 'free',
    ownerUserId: Number(household?.owner_user_id || userId),
    isOwner: Number(household?.owner_user_id || userId) === Number(userId),
    householdId: household?.id || null,
    protectedMemberLimit: plan.protectedMemberLimit,
    protectedMemberCount: Number(household?.protected_member_count ?? 1),
    isProtectedMember,
    connectionLimit: plan.connectionLimit,
    billingPeriod: planCode === 'free' ? null : household?.billing_period || null,
    expiresAt: planCode === 'free' ? null : household?.current_period_end || null,
    consultationCredits: Number(household?.consultation_credits || 0),
    callCenterEnabled: planCode !== 'free' && isProtectedMember,
    automaticEarlySignals: planCode !== 'free' && isProtectedMember,
  };
}

async function getEntitlement(pool, userId) {
  let household = await householdProtecting(pool, userId);
  if (!household) household = await householdOwnedBy(pool, userId);
  return toEntitlement(household, userId);
}

async function activateHouseholdPlan(
  db,
  ownerUserId,
  { planCode, billingPeriod, platform, productId, originalTransactionId, startsAt, expiresAt }
) {
  const plan = planDefinition(planCode);
  if (plan.code === 'free')
    throw new Error('A paid Store transaction cannot activate the free plan');

  const household = await ensureHousehold(db, ownerUserId);
  const updated = await db.query(
    `UPDATE subscription_households
        SET plan_code = $2,
            status = 'active',
            billing_period = $3,
            protected_member_limit = $4,
            platform = $5,
            product_id = $6,
            original_transaction_id = COALESCE($7, original_transaction_id),
            current_period_start = COALESCE($8, current_period_start, NOW()),
            current_period_end = $9,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      household.id,
      plan.code,
      billingPeriod,
      plan.protectedMemberLimit,
      platform,
      productId,
      originalTransactionId || null,
      startsAt || null,
      expiresAt,
    ]
  );
  return updated.rows[0];
}

async function downgradeHouseholdToFree(db, ownerUserId, status = 'expired') {
  const household = await ensureHousehold(db, ownerUserId);
  const updated = await db.query(
    `UPDATE subscription_households
        SET plan_code = 'free', status = $2, billing_period = NULL,
            protected_member_limit = 1, current_period_end = NULL, updated_at = NOW()
      WHERE owner_user_id = $1
      RETURNING *`,
    [ownerUserId, status]
  );

  const excess = await db.query(
    `UPDATE subscription_household_members m
        SET status = 'removed', removed_at = NOW()
      WHERE m.household_id = $1 AND m.status = 'active' AND m.user_id <> $2
      RETURNING m.user_id`,
    [household.id, ownerUserId]
  );
  for (const row of excess.rows) {
    const own = await ensureHousehold(db, Number(row.user_id));
    await db.query(
      `INSERT INTO subscription_household_members (household_id, user_id, added_by)
       VALUES ($1, $2, $2)
       ON CONFLICT (household_id, user_id) DO UPDATE
         SET status = 'active', added_at = NOW(), removed_at = NULL`,
      [own.id, row.user_id]
    );
  }
  await db.query(
    `INSERT INTO subscription_household_members (household_id, user_id, added_by)
     SELECT $1, $2, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM subscription_household_members
         WHERE user_id = $2 AND status = 'active'
      )
     ON CONFLICT (household_id, user_id) DO UPDATE
       SET status = 'active', added_at = NOW(), removed_at = NULL`,
    [household.id, ownerUserId]
  );
  return {
    ...updated.rows[0],
    affectedUserIds: excess.rows.map((row) => Number(row.user_id)),
  };
}

async function grantAnnualConsultationCredits(
  db,
  householdId,
  credits,
  referenceId,
  metadata = {}
) {
  if (!credits) return false;
  const result = await db.query(
    `INSERT INTO consultation_credit_ledger (household_id, delta, reason, reference_id, metadata)
     VALUES ($1, $2, 'annual_grant', $3, $4::jsonb)
     ON CONFLICT (reason, reference_id) DO NOTHING`,
    [householdId, credits, referenceId, JSON.stringify(metadata)]
  );
  return result.rowCount > 0;
}

async function invalidateEntitlement(userId) {
  await cacheDel(`subscription:${userId}`);
}

async function invalidateHouseholdEntitlements(db, householdId) {
  // Include former members: a refund retry must clear snapshots left behind
  // if cache invalidation failed after their membership was removed.
  const result = await db.query(
    `SELECT owner_user_id AS user_id FROM subscription_households WHERE id = $1
     UNION
     SELECT user_id FROM subscription_household_members
      WHERE household_id = $1`,
    [householdId]
  );
  await Promise.all(result.rows.map((row) => invalidateEntitlement(Number(row.user_id))));
}

module.exports = {
  ensureHousehold,
  householdOwnedBy,
  householdProtecting,
  getEntitlement,
  activateHouseholdPlan,
  downgradeHouseholdToFree,
  grantAnnualConsultationCredits,
  invalidateEntitlement,
  invalidateHouseholdEntitlements,
  _test: { isActiveHousehold, toEntitlement },
};
