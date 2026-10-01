'use strict';

const { cacheGet, cacheSet } = require('../../lib/redis');
const { t } = require('../../i18n');
const { sendAndSave } = require('../notification/basic.notification.service');
const { emitCrmEventAsync } = require('../integrations/crm-event.service');
const entitlementService = require('./entitlement.service');
const { planDefinition, productForId } = require('./subscription-catalog');

function currentYearMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function getStatus(pool, userId) {
  const cacheKey = `subscription:${userId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const status = await entitlementService.getEntitlement(pool, userId);
  await cacheSet(cacheKey, status, 3600);
  return status;
}

async function isAnTam(pool, userId) {
  return (await getStatus(pool, userId)).isAnTam;
}

async function getVoiceUsageThisMonth(pool, userId) {
  const result = await pool.query(
    'SELECT count FROM voice_usage WHERE user_id = $1 AND year_month = $2',
    [userId, currentYearMonth()]
  );
  return Number(result.rows[0]?.count || 0);
}

async function incrementVoiceUsage(pool, userId) {
  await pool.query(
    `INSERT INTO voice_usage (user_id, year_month, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, year_month) DO UPDATE SET count = voice_usage.count + 1`,
    [userId, currentYearMonth()]
  );
}

async function notifyActivated(pool, userId, expiresAt) {
  const result = await pool.query(
    `SELECT push_token, COALESCE(language_preference, 'vi') AS lang
       FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) return;
  const date = new Date(expiresAt).toLocaleDateString(user.lang === 'en' ? 'en-US' : 'vi-VN');
  await sendAndSave(
    pool,
    { id: userId, push_token: user.push_token },
    'subscription_activated',
    t('push.subscription_activated_title', user.lang),
    t('push.subscription_activated_body', user.lang, { date }),
    { expiresAt: new Date(expiresAt).toISOString() }
  );
}

function emitSubscriptionEvent(pool, type, details) {
  emitCrmEventAsync(
    pool,
    type,
    {
      user_id: String(details.userId),
      beneficiary_user_id: String(details.userId),
      plan_code: details.planCode,
      product_code: details.productId,
      status: details.status,
      state: details.status === 'active' ? 'paid' : 'churn',
      expires_at: details.expiresAt ? new Date(details.expiresAt).toISOString() : undefined,
      external_ref: details.transactionId,
      provider: details.platform,
      amount_minor: 0,
      currency: 'VND',
      txn_type: 'subscription',
    },
    { event_id: `${type}:${details.platform}:${details.transactionId || details.userId}` }
  );
}

async function activateFromIap(pool, userId, options) {
  const plan = planDefinition(options.planCode);
  if (plan.code === 'free') {
    return { ok: false, code: 'UNKNOWN_PRODUCT', error: 'Unknown An Tam plan' };
  }
  const periodMonths = options.billingPeriod === 'yearly' ? 12 : 1;
  const fallbackExpiry = new Date();
  fallbackExpiry.setMonth(fallbackExpiry.getMonth() + periodMonths);
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : fallbackExpiry;
  const db = await pool.connect();
  let household;
  try {
    await db.query('BEGIN');
    household = await entitlementService.activateHouseholdPlan(db, userId, {
      planCode: plan.code,
      billingPeriod: options.billingPeriod,
      platform: options.platform,
      productId: options.productId,
      originalTransactionId: options.originalTransactionId,
      startsAt: new Date(),
      expiresAt,
    });
    if (options.billingPeriod === 'yearly') {
      await entitlementService.grantAnnualConsultationCredits(
        db,
        household.id,
        plan.annualConsultationCredits,
        `iap:${options.platform}:${options.transactionId}`,
        {
          productId: options.productId,
          offerId: options.offerId || null,
          basePlanId: options.basePlanId || null,
        }
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    return { ok: false, code: 'ACTIVATION_FAILED', error: error.message };
  } finally {
    db.release();
  }
  await entitlementService.invalidateHouseholdEntitlements(pool, household.id);
  notifyActivated(pool, userId, expiresAt).catch(() => {});
  emitSubscriptionEvent(pool, options.crmEventType || 'subscription.started', {
    userId,
    planCode: plan.code,
    productId: options.productId,
    transactionId: options.transactionId,
    platform: options.platform,
    expiresAt,
    status: 'active',
  });
  return {
    ok: true,
    planCode: plan.code,
    planName: plan.label,
    billingPeriod: options.billingPeriod,
    protectedMemberLimit: plan.protectedMemberLimit,
    consultationCreditsGranted:
      options.billingPeriod === 'yearly' ? plan.annualConsultationCredits : 0,
    expiresAt,
    platform: options.platform,
  };
}

async function applyIapWebhookEvent(pool, event) {
  if (!event.originalTransactionId) {
    return { ok: false, error: 'Missing originalTransactionId' };
  }
  const owner = await pool.query(
    `SELECT user_id FROM iap_receipts
      WHERE original_transaction_id = $1 OR transaction_id = $1
      ORDER BY id ASC LIMIT 1`,
    [event.originalTransactionId]
  );
  const userId = Number(owner.rows[0]?.user_id);
  if (!userId) return { ok: false, error: 'Unknown subscription chain' };

  const product = productForId(event.productId);
  if (event.action === 'renew' && !product) {
    return { ok: false, error: `Unknown Asinu subscription product: ${event.productId}` };
  }
  if (event.transactionId) {
    await pool.query(
      `INSERT INTO iap_receipts (
         user_id, platform, product_id, transaction_id, original_transaction_id, expires_at,
         plan_code, billing_period, raw_payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        userId,
        event.platform,
        event.productId || 'unknown',
        event.transactionId,
        event.originalTransactionId,
        event.expiresAt || null,
        product?.plan_code || null,
        product?.billing_period || null,
        JSON.stringify(event.rawPayload || {}),
      ]
    );
  }

  if (event.action === 'renew' && event.expiresAt) {
    return activateFromIap(pool, userId, {
      productId: event.productId,
      transactionId: event.transactionId,
      originalTransactionId: event.originalTransactionId,
      planCode: product.plan_code,
      billingPeriod: product.billing_period,
      expiresAt: event.expiresAt,
      platform: event.platform,
      crmEventType: 'subscription.renewed',
    });
  }

  if (!['revoke', 'refund', 'expire'].includes(event.action)) {
    return { ok: true, ignored: true };
  }
  const current = await entitlementService.householdOwnedBy(pool, userId);
  const mustDowngrade =
    event.action !== 'expire' ||
    !current.current_period_end ||
    new Date(current.current_period_end) <= new Date();
  if (!mustDowngrade) return { ok: true, ignored: true, reason: 'newer entitlement active' };

  const downgraded = await entitlementService.downgradeHouseholdToFree(
    pool,
    userId,
    event.action === 'refund' ? 'refunded' : event.action === 'revoke' ? 'revoked' : 'expired'
  );
  await entitlementService.invalidateHouseholdEntitlements(pool, downgraded.id);
  await Promise.all(
    (downgraded.affectedUserIds || []).map((affectedUserId) =>
      entitlementService.invalidateEntitlement(affectedUserId)
    )
  );
  if (event.action === 'refund') {
    emitSubscriptionEvent(pool, 'payment.refunded', {
      userId,
      planCode: 'free',
      productId: event.productId,
      transactionId: event.transactionId,
      platform: event.platform,
      expiresAt: event.expiresAt,
      status: 'refunded',
    });
  }
  emitSubscriptionEvent(pool, event.action === 'expire' ? 'subscription.expired' : 'subscription.cancelled', {
    userId,
    planCode: 'free',
    productId: event.productId,
    transactionId: event.transactionId,
    platform: event.platform,
    expiresAt: event.expiresAt,
    status: event.action,
  });
  return { ok: true, userId, planCode: 'free' };
}

async function getHistory(pool, userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT id, platform, product_id, plan_code, billing_period, transaction_id,
              expires_at, created_at
         FROM iap_receipts WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    pool.query('SELECT COUNT(*)::integer AS count FROM iap_receipts WHERE user_id = $1', [userId]),
  ]);
  return { purchases: items.rows, total: count.rows[0]?.count || 0, page, limit };
}

// Migration compatibility for bank transfers created before V2. New clients
// cannot create these orders; a still-pending order is converted to An Tam 2.
function parseSubDescription(content) {
  const user = String(content || '').match(/asinusub(\d+)/);
  const order = String(content || '').match(/order([a-zA-Z0-9]+)/);
  return user && order ? { userId: Number(user[1]), orderCode: order[1] } : null;
}

async function activateSubscription(pool, userId, orderCode) {
  const db = await pool.connect();
  let household;
  let expiresAt;
  try {
    await db.query('BEGIN');
    const pending = await db.query(
      `SELECT * FROM subscriptions
        WHERE order_code = $1 AND user_id = $2 AND status = 'pending'
          AND qr_expires_at > NOW() FOR UPDATE`,
      [orderCode, userId]
    );
    if (!pending.rowCount) {
      await db.query('ROLLBACK');
      return { ok: false, message: 'Không tìm thấy giao dịch còn hiệu lực.' };
    }
    const months = Number(pending.rows[0].plan_months || 1);
    const current = await entitlementService.householdOwnedBy(db, userId);
    const base = current.current_period_end && new Date(current.current_period_end) > new Date()
      ? new Date(current.current_period_end)
      : new Date();
    expiresAt = new Date(base);
    expiresAt.setMonth(expiresAt.getMonth() + months);
    household = await entitlementService.activateHouseholdPlan(db, userId, {
      planCode: 'antam_2',
      billingPeriod: months >= 12 ? 'yearly' : 'monthly',
      platform: 'legacy',
      productId: 'legacy.bank-transfer',
      originalTransactionId: orderCode,
      startsAt: new Date(),
      expiresAt,
    });
    await db.query(
      `UPDATE subscriptions SET status = 'completed', subscription_start = NOW(),
              subscription_end = $2, completed_at = NOW() WHERE order_code = $1`,
      [orderCode, expiresAt]
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    return { ok: false, message: error.message };
  } finally {
    db.release();
  }
  await entitlementService.invalidateHouseholdEntitlements(pool, household.id);
  emitSubscriptionEvent(pool, 'subscription.activated', {
    userId,
    planCode: 'antam_2',
    productId: 'legacy.bank-transfer',
    transactionId: orderCode,
    platform: 'legacy',
    expiresAt,
    status: 'active',
  });
  return { ok: true, planCode: 'antam_2', expiresAt };
}

module.exports = {
  getStatus,
  isAnTam,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
  activateFromIap,
  applyIapWebhookEvent,
  getHistory,
  parseSubDescription,
  activateSubscription,
};
