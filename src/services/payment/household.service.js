'use strict';

const entitlementService = require('./entitlement.service');
const { planDefinition } = require('./subscription-catalog');
const { t } = require('../../i18n');

function serviceError(i18nKey, statusCode, code, i18nParams) {
  return Object.assign(new Error(t(i18nKey, 'vi', i18nParams)), {
    statusCode,
    code,
    i18nKey,
    i18nParams,
  });
}

async function listProtectedMembers(pool, ownerUserId, lang = 'vi') {
  const household = await entitlementService.householdOwnedBy(pool, ownerUserId);
  const members = await pool.query(
    `SELECT m.user_id, m.added_at,
            COALESCE(u.display_name, u.full_name, u.email, u.phone_number) AS name,
            u.avatar_url
       FROM subscription_household_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.household_id = $1 AND m.status = 'active' AND u.deleted_at IS NULL
      ORDER BY (m.user_id = $2) DESC, m.added_at ASC`,
    [household.id, ownerUserId]
  );
  const active =
    ['active', 'grace_period'].includes(household.status) &&
    (household.plan_code === 'free' ||
      Boolean(household.current_period_end && new Date(household.current_period_end) > new Date()));
  const planCode = active ? household.plan_code : 'free';
  const plan = planDefinition(planCode);
  return {
    householdId: household.id,
    ownerUserId: Number(ownerUserId),
    planCode,
    planName: plan.code === 'free' ? t('subscription.plan.free', lang) : plan.label,
    protectedMemberLimit: plan.protectedMemberLimit,
    protectedMemberCount: members.rowCount,
    members: members.rows.map((member) => ({
      userId: Number(member.user_id),
      name: member.name || t('careCircle.user_label', lang),
      avatarUrl: member.avatar_url || null,
      addedAt: member.added_at,
    })),
  };
}

async function assertConnected(pool, ownerUserId, memberUserId) {
  if (Number(ownerUserId) === Number(memberUserId)) return;
  const connection = await pool.query(
    `SELECT 1
       FROM user_connections
      WHERE status = 'accepted'
        AND ((requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1))
      LIMIT 1`,
    [ownerUserId, memberUserId]
  );
  if (!connection.rowCount) {
    throw serviceError('error.household_not_connected', 409, 'NOT_CONNECTED');
  }
}

async function addProtectedMember(pool, ownerUserId, memberUserId, lang = 'vi') {
  if (!Number.isInteger(Number(memberUserId)) || Number(memberUserId) <= 0) {
    throw serviceError('error.household_invalid_member', 400, 'INVALID_MEMBER');
  }
  await assertConnected(pool, ownerUserId, Number(memberUserId));

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const household = await entitlementService.householdOwnedBy(db, ownerUserId);
    await db.query('SELECT id FROM subscription_households WHERE id = $1 FOR UPDATE', [
      household.id,
    ]);
    const plan = planDefinition(
      ['active', 'grace_period'].includes(household.status) &&
        (household.plan_code === 'free' ||
          Boolean(
            household.current_period_end && new Date(household.current_period_end) > new Date()
          ))
        ? household.plan_code
        : 'free'
    );
    const current = await db.query(
      `SELECT m.household_id, h.owner_user_id, h.plan_code, h.status
         FROM subscription_household_members m
         JOIN subscription_households h ON h.id = m.household_id
        WHERE m.user_id = $1 AND m.status = 'active'
        FOR UPDATE OF m`,
      [memberUserId]
    );
    const activeMembership = current.rows[0];
    if (activeMembership && Number(activeMembership.household_id) === Number(household.id)) {
      await db.query('COMMIT');
      return listProtectedMembers(pool, ownerUserId, lang);
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::integer AS count
         FROM subscription_household_members
        WHERE household_id = $1 AND status = 'active'`,
      [household.id]
    );
    let memberCount = Number(countResult.rows[0]?.count || 0);
    if (
      memberCount >= plan.protectedMemberLimit &&
      plan.code !== 'free' &&
      Number(memberUserId) !== Number(ownerUserId)
    ) {
      const removedOwner = await db.query(
        `UPDATE subscription_household_members
            SET status = 'removed', removed_at = NOW()
          WHERE household_id = $1 AND user_id = $2 AND status = 'active'
          RETURNING id`,
        [household.id, ownerUserId]
      );
      if (removedOwner.rowCount) memberCount -= 1;
    }
    if (memberCount >= plan.protectedMemberLimit) {
      throw serviceError('error.household_limit', 409, 'PROTECTED_MEMBER_LIMIT', {
        plan: plan.code === 'free' ? t('subscription.plan.free', lang) : plan.label,
        count: plan.protectedMemberLimit,
      });
    }
    if (activeMembership && Number(activeMembership.household_id) !== Number(household.id)) {
      const isOwnFreeHousehold =
        Number(activeMembership.owner_user_id) === Number(memberUserId) &&
        activeMembership.plan_code === 'free';
      if (!isOwnFreeHousehold) {
        throw serviceError('error.household_already_protected', 409, 'MEMBER_ALREADY_PROTECTED');
      }
      await db.query(
        `UPDATE subscription_household_members
            SET status = 'removed', removed_at = NOW()
          WHERE household_id = $1 AND user_id = $2`,
        [activeMembership.household_id, memberUserId]
      );
    }

    await db.query(
      `INSERT INTO subscription_household_members (household_id, user_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (household_id, user_id) DO UPDATE
         SET status = 'active', added_by = EXCLUDED.added_by,
             added_at = NOW(), removed_at = NULL`,
      [household.id, memberUserId, ownerUserId]
    );
    await db.query('COMMIT');
    await Promise.all([
      entitlementService.invalidateEntitlement(memberUserId),
      entitlementService.invalidateEntitlement(ownerUserId),
    ]);
    return listProtectedMembers(pool, ownerUserId, lang);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function removeProtectedMember(pool, ownerUserId, memberUserId, lang = 'vi') {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const household = await entitlementService.householdOwnedBy(db, ownerUserId);
    if (household.plan_code === 'free' && Number(memberUserId) === Number(ownerUserId)) {
      throw serviceError('error.household_free_self', 409, 'FREE_SELF_REQUIRED');
    }
    const removed = await db.query(
      `UPDATE subscription_household_members
          SET status = 'removed', removed_at = NOW()
        WHERE household_id = $1 AND user_id = $2 AND status = 'active'
        RETURNING user_id`,
      [household.id, memberUserId]
    );
    if (!removed.rowCount) {
      throw serviceError('error.household_member_not_found', 404, 'MEMBER_NOT_FOUND');
    }

    const ownHousehold = await entitlementService.ensureHousehold(db, Number(memberUserId));
    await db.query(
      `INSERT INTO subscription_household_members (household_id, user_id, added_by)
       VALUES ($1, $2, $2)
       ON CONFLICT (household_id, user_id) DO UPDATE
         SET status = 'active', added_at = NOW(), removed_at = NULL`,
      [ownHousehold.id, memberUserId]
    );
    await db.query('COMMIT');
    await Promise.all([
      entitlementService.invalidateEntitlement(memberUserId),
      entitlementService.invalidateEntitlement(ownerUserId),
    ]);
    return listProtectedMembers(pool, ownerUserId, lang);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

module.exports = { listProtectedMembers, addProtectedMember, removeProtectedMember };
