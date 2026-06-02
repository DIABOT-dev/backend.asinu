/**
 * Subscription Service — Free vs Premium tier
 *
 * Plans (4 tiers):
 *  1 tháng  → 199,000 VND (không giảm)
 *  3 tháng  → 567,000 VND (-5%)
 *  6 tháng  → 1,075,000 VND (-10%)
 *  12 tháng → 1,910,000 VND (-20%)
 *
 * Premium limits:
 *  - Lịch sử: 365 ngày
 *  - Kết nối: 50 người
 *  - Voice chat: 5,000 lượt/tháng
 */

const crypto = require('crypto');

const SEPAY_ACCOUNT = process.env.SEPAY_ACCOUNT_NUMBER;
const SEPAY_BANK    = process.env.SEPAY_BANK_CODE;

// ─── Plan pricing ─────────────────────────────────────────────────

const BASE_PRICE = 199000; // VND/tháng

const { t } = require('../../i18n');
const { cacheGet, cacheSet, cacheDel } = require('../../lib/redis');
const { sendAndSave } = require('../notification/basic.notification.service');

const WALLET_LOW_BALANCE_THRESHOLD = 50000; // 50.000đ

function formatDisplayDate(dateLike, lang = 'vi') {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  if (lang === 'en') {
    return date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

// Helper: notify Premium activation
async function notifyPremiumActivated(pool, userId, expiresAt) {
  try {
    const { rows } = await pool.query(
      `SELECT push_token, language_preference FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows[0]) return;
    const u = rows[0];
    const lang = u.language_preference || 'vi';
    const dateStr = formatDisplayDate(expiresAt, lang);
    await sendAndSave(pool, { id: userId, push_token: u.push_token }, 'subscription_activated',
      t('push.subscription_activated_title', lang),
      t('push.subscription_activated_body', lang, { date: dateStr }),
      { expiresAt: new Date(expiresAt).toISOString() }
    );
  } catch {}
}

// Helper: warn nếu wallet thấp sau giao dịch
async function notifyWalletLowIfNeeded(pool, userId, balance) {
  if (Number(balance) >= WALLET_LOW_BALANCE_THRESHOLD) return;
  try {
    const { rows } = await pool.query(
      `SELECT push_token, language_preference FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows[0]) return;
    const u = rows[0];
    const lang = u.language_preference || 'vi';
    await sendAndSave(pool, { id: userId, push_token: u.push_token }, 'wallet_low_balance',
      t('push.wallet_low_title', lang),
      t('push.wallet_low_body', lang, { balance: Number(balance).toLocaleString('vi-VN') }),
      { balance: String(balance) }
    );
  } catch {}
}

const PLANS = {
  1:  { months: 1,  labelKey: 'subscription.plan_1',  discount: 0,  price: 199000  },
  3:  { months: 3,  labelKey: 'subscription.plan_3',  discount: 5,  price: 567000  }, // 199000*3*0.95 = 567150 → 567000
  6:  { months: 6,  labelKey: 'subscription.plan_6',  discount: 10, price: 1075000 }, // 199000*6*0.90 = 1074600 → 1075000
  12: { months: 12, labelKey: 'subscription.plan_12', discount: 20, price: 1910000 }, // 199000*12*0.80 = 1910400 → 1910000
};

// ─── Limits ────────────────────────────────────────────────────────
// All limits read from env so product can tune them without a deploy.
// Defaults match the MVP pricing spec: Premium = 3 caregivers, Free = 1.

const VOICE_MONTHLY_LIMIT      = Number(process.env.VOICE_MONTHLY_LIMIT || 5000);
const PREMIUM_CONNECTION_LIMIT = Number(process.env.CARE_CIRCLE_PREMIUM_LIMIT || 3);
const FREE_CONNECTION_LIMIT    = Number(process.env.CARE_CIRCLE_FREE_LIMIT || 1);
const PREMIUM_HISTORY_DAYS     = Number(process.env.CAREGIVER_HISTORY_DAYS_PREMIUM || 365);
const FREE_HISTORY_DAYS        = Number(process.env.CAREGIVER_HISTORY_DAYS_FREE || 30);

// ─── Helpers ────────────────────────────────────────────────────────

function generateOrderCode() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Mô tả giao dịch nhúng vào QR:
 *   asinusub{userId}order{orderCode}
 */
function buildDescription(userId, orderCode) {
  return `asinusub${userId}order${orderCode}`;
}

function parseSubDescription(content) {
  const userMatch  = content.match(/asinusub(\d+)/);
  const orderMatch = content.match(/order([a-zA-Z0-9]+)/);
  if (!userMatch || !orderMatch) return null;
  return { userId: Number(userMatch[1]), orderCode: orderMatch[1] };
}

// ─── getStatus ──────────────────────────────────────────────────────

/**
 * Lấy trạng thái subscription hiện tại của user.
 * @returns {{ tier, isPremium, expiresAt, voiceUsedThisMonth }}
 */
async function getStatus(pool, userId) {
  const cached = await cacheGet(`subscription:${userId}`);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT subscription_tier, subscription_expires_at FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) return { tier: 'free', isPremium: false, expiresAt: null, voiceUsedThisMonth: 0 };

  const tier = user.subscription_tier || 'free';
  const expiresAt = user.subscription_expires_at;
  const isPremiumActive = tier === 'premium' && expiresAt && new Date(expiresAt) > new Date();

  const voiceUsedThisMonth = isPremiumActive ? await getVoiceUsageThisMonth(pool, userId) : 0;

  const result = {
    tier: isPremiumActive ? 'premium' : 'free',
    isPremium: Boolean(isPremiumActive),
    expiresAt,
    voiceUsedThisMonth,
    voiceMonthlyLimit: VOICE_MONTHLY_LIMIT,
    plans: Object.values(PLANS).map(p => ({ ...p, label: t(p.labelKey, 'vi') })),
  };

  await cacheSet(`subscription:${userId}`, result, 3600); // 1 hour
  return result;
}

// ─── isPremium ───────────────────────────────────────────────────────

async function isPremium(pool, userId) {
  const status = await getStatus(pool, userId);
  return status.isPremium;
}

// ─── Voice usage ─────────────────────────────────────────────────────

function currentYearMonth() {
  return new Date().toISOString().slice(0, 7); // '2026-03'
}

async function getVoiceUsageThisMonth(pool, userId) {
  const { rows } = await pool.query(
    `SELECT count FROM voice_usage WHERE user_id = $1 AND year_month = $2`,
    [userId, currentYearMonth()]
  );
  return Number(rows[0]?.count) || 0;
}

async function incrementVoiceUsage(pool, userId) {
  await pool.query(
    `INSERT INTO voice_usage (user_id, year_month, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, year_month) DO UPDATE SET count = voice_usage.count + 1`,
    [userId, currentYearMonth()]
  );
}

// ─── createQR ────────────────────────────────────────────────────────

/**
 * Tạo QR đăng ký Premium theo gói.
 * @param {object} pool
 * @param {number} userId
 * @param {number} months - 1 | 3 | 6 | 12
 * @returns {{ order_code, qr_url, amount, description, expires_at, plan_months, discount }}
 */
async function createQR(pool, userId, months = 1) {
  // Self-purchase — payer === recipient.
  return createQRInternal(pool, { payerId: userId, recipientId: userId, months, isGift: false });
}

/**
 * Buy Premium for someone else in your Care Circle (MVP audit FIX #10).
 * The recipient must be an ACCEPTED connection of the payer; otherwise
 * we refuse so people cannot gift Premium to random user IDs.
 *
 * @throws Error('not_in_care_circle') if recipient is not connected.
 */
async function createQRForRecipient(pool, payerId, recipientId, months = 1) {
  if (Number(payerId) === Number(recipientId)) {
    return createQR(pool, payerId, months);
  }

  const { rows } = await pool.query(
    `SELECT 1
       FROM user_connections
      WHERE status = 'accepted'
        AND (
          (requester_id = $1 AND addressee_id = $2) OR
          (requester_id = $2 AND addressee_id = $1)
        )
      LIMIT 1`,
    [payerId, recipientId]
  );
  if (rows.length === 0) {
    const err = new Error('not_in_care_circle');
    err.code = 'NOT_IN_CARE_CIRCLE';
    throw err;
  }

  return createQRInternal(pool, { payerId, recipientId, months, isGift: true });
}

async function createQRInternal(pool, { payerId, recipientId, months, isGift }) {
  const plan = PLANS[months] || PLANS[1];
  const amount = plan.price;
  const orderCode = generateOrderCode();
  // Description encodes the BENEFICIARY (recipient) so the existing
  // webhook -> activateSubscription path activates the right account.
  const description = buildDescription(recipientId, orderCode);
  const qrUrl = `https://qr.sepay.vn/img?acc=${SEPAY_ACCOUNT}&bank=${SEPAY_BANK}&amount=${amount}&des=${description}`;

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, payer_user_id, is_gift, order_code, amount, qr_url, status, plan_months, qr_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW() + INTERVAL '30 minutes')
     RETURNING qr_expires_at`,
    [recipientId, payerId, isGift, orderCode, amount, qrUrl, plan.months]
  );

  return {
    order_code: orderCode,
    qr_url:     qrUrl,
    amount,
    description,
    expires_at: rows[0].qr_expires_at,
    plan_months: plan.months,
    discount:    plan.discount,
    label:       t(plan.labelKey),
    is_gift:    isGift,
    payer_user_id: payerId,
    recipient_user_id: recipientId,
  };
}

// ─── activateSubscription ─────────────────────────────────────────────

/**
 * Kích hoạt Premium cho user sau khi thanh toán thành công.
 * Được gọi từ payment webhook.
 */
async function activateSubscription(pool, userId, orderCode, months = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: subRows } = await client.query(
      `SELECT * FROM subscriptions WHERE order_code = $1 AND status = 'pending' AND qr_expires_at > NOW()`,
      [orderCode]
    );

    if (!subRows.length) {
      await client.query('ROLLBACK');
      return { ok: false, message: t('error.subscription_not_found') };
    }

    const sub = subRows[0];
    const planMonths = sub.plan_months || months;
    const now = new Date();
    const subEnd = new Date(now);
    subEnd.setMonth(subEnd.getMonth() + planMonths);

    await client.query(
      `UPDATE subscriptions
       SET status = 'completed', subscription_start = $1, subscription_end = $2, completed_at = NOW()
       WHERE order_code = $3`,
      [now, subEnd, orderCode]
    );

    // Extend nếu đang là premium
    const { rows: userRows } = await client.query(
      `SELECT subscription_tier, subscription_expires_at FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRows[0];
    let newExpiry = subEnd;

    if (
      user.subscription_tier === 'premium' &&
      user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > now
    ) {
      const currentExpiry = new Date(user.subscription_expires_at);
      newExpiry = new Date(currentExpiry);
      newExpiry.setMonth(newExpiry.getMonth() + planMonths);
    }

    await client.query(
      `UPDATE users
       SET subscription_tier = 'premium', subscription_expires_at = $1
       WHERE id = $2`,
      [newExpiry, userId]
    );

    await client.query('COMMIT');

    // Invalidate subscription cache
    await cacheDel(`subscription:${userId}`);

    // Notify the recipient (always) and the payer separately if this was
    // a gift purchase (Tùng buys for Đức).
    notifyPremiumActivated(pool, userId, newExpiry).catch(() => {});
    if (sub.is_gift && sub.payer_user_id && sub.payer_user_id !== userId) {
      notifyGiftConfirmed(pool, sub.payer_user_id, userId, newExpiry).catch(() => {});
    }

    return { ok: true, expiresAt: newExpiry, planMonths, isGift: !!sub.is_gift, payerUserId: sub.payer_user_id };
  } catch (err) {
    await client.query('ROLLBACK');

    return { ok: false, message: t('error.server') };
  } finally {
    client.release();
  }
}

// Helper: tell the payer "your gift was activated"
async function notifyGiftConfirmed(pool, payerId, recipientId, expiresAt) {
  try {
    const { rows } = await pool.query(
      `SELECT u.push_token, u.language_preference,
              COALESCE(r.full_name, r.display_name, r.email) AS recipient_name
         FROM users u, users r
        WHERE u.id = $1 AND r.id = $2`,
      [payerId, recipientId]
    );
    if (!rows[0]) return;
    const u = rows[0];
    const lang = u.language_preference || 'vi';
    const dateStr = formatDisplayDate(expiresAt, lang);
    await sendAndSave(
      pool,
      { id: payerId, push_token: u.push_token },
      'subscription_gift_confirmed',
      t('push.gift_confirmed_title', lang) || 'Đã tặng Premium thành công',
      t('push.gift_confirmed_body', lang, { name: u.recipient_name || '', date: dateStr })
        || `Bạn vừa tặng Premium cho ${u.recipient_name || 'người thân'} đến ${dateStr}.`,
      { recipientId: String(recipientId), expiresAt: new Date(expiresAt).toISOString() }
    );
  } catch {}
}

// ─── payWithWallet ───────────────────────────────────────────────────

/**
 * Thanh toán gói Premium bằng số dư ví.
 * Atomic: kiểm tra số dư → trừ ví → kích hoạt premium.
 */
async function payWithWallet(pool, userId, months = 1) {
  return payWithWalletInternal(pool, { payerId: userId, recipientId: userId, months, isGift: false });
}

/**
 * Wallet payment where the BENEFICIARY is someone else in the payer's
 * Care Circle (MVP audit FIX #10 — wallet variant). Refuses if they're
 * not connected; otherwise charges payer's wallet and activates Premium
 * on the recipient.
 *
 * @throws Error('not_in_care_circle') when the recipient is not a peer.
 */
async function payWithWalletForRecipient(pool, payerId, recipientId, months = 1) {
  if (Number(payerId) === Number(recipientId)) {
    return payWithWallet(pool, payerId, months);
  }

  const { rows } = await pool.query(
    `SELECT 1
       FROM user_connections
      WHERE status = 'accepted'
        AND (
          (requester_id = $1 AND addressee_id = $2) OR
          (requester_id = $2 AND addressee_id = $1)
        )
      LIMIT 1`,
    [payerId, recipientId]
  );
  if (rows.length === 0) {
    const err = new Error('not_in_care_circle');
    err.code = 'NOT_IN_CARE_CIRCLE';
    throw err;
  }

  return payWithWalletInternal(pool, { payerId, recipientId, months, isGift: true });
}

async function payWithWalletInternal(pool, { payerId, recipientId, months, isGift }) {
  const plan = PLANS[months] || PLANS[1];
  const amount = plan.price;
  const orderCode = generateOrderCode();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock payer's row + check balance. The recipient row is locked next
    // (only if different from payer) so we never deadlock — same ordering
    // every time, lowest user id first.
    const lowerId = Math.min(Number(payerId), Number(recipientId));
    const higherId = Math.max(Number(payerId), Number(recipientId));

    let payerRow, recipientRow;
    if (lowerId === higherId) {
      const r = await client.query(
        `SELECT id, wallet_balance, subscription_tier, subscription_expires_at
           FROM users WHERE id = $1 FOR UPDATE`,
        [payerId]
      );
      payerRow = recipientRow = r.rows[0];
    } else {
      const r = await client.query(
        `SELECT id, wallet_balance, subscription_tier, subscription_expires_at
           FROM users WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
        [lowerId, higherId]
      );
      payerRow = r.rows.find((u) => Number(u.id) === Number(payerId));
      recipientRow = r.rows.find((u) => Number(u.id) === Number(recipientId));
    }

    if (!payerRow) {
      await client.query('ROLLBACK');
      return { ok: false, message: t('error.user_not_found') };
    }
    if (!recipientRow) {
      await client.query('ROLLBACK');
      return { ok: false, message: t('error.user_not_found') };
    }

    if (Number(payerRow.wallet_balance) < amount) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message: `Số dư ví không đủ. Cần ${amount.toLocaleString('vi-VN')}đ, hiện có ${Number(payerRow.wallet_balance).toLocaleString('vi-VN')}đ.`,
      };
    }

    // Deduct from payer.
    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
      [amount, payerId]
    );

    // Record subscription against the BENEFICIARY (recipient) so existing
    // "who has Premium" queries continue to work without changes.
    const now = new Date();
    const subEnd = new Date(now);
    subEnd.setMonth(subEnd.getMonth() + plan.months);

    await client.query(
      `INSERT INTO subscriptions (user_id, payer_user_id, is_gift, order_code, amount, qr_url, status, plan_months, subscription_start, subscription_end, completed_at, qr_expires_at)
       VALUES ($1, $2, $3, $4, $5, '', 'completed', $6, $7, $8, NOW(), NOW())`,
      [recipientId, payerId, isGift, orderCode, amount, plan.months, now, subEnd]
    );

    // Extend if the recipient is already premium and hasn't expired.
    let newExpiry = subEnd;
    if (
      recipientRow.subscription_tier === 'premium' &&
      recipientRow.subscription_expires_at &&
      new Date(recipientRow.subscription_expires_at) > now
    ) {
      newExpiry = new Date(recipientRow.subscription_expires_at);
      newExpiry.setMonth(newExpiry.getMonth() + plan.months);
    }

    await client.query(
      `UPDATE users SET subscription_tier = 'premium', subscription_expires_at = $1 WHERE id = $2`,
      [newExpiry, recipientId]
    );

    await client.query('COMMIT');
    await cacheDel(`subscription:${recipientId}`);
    if (isGift) await cacheDel(`subscription:${payerId}`);

    // Notify the beneficiary, and the payer separately for gifts.
    notifyPremiumActivated(pool, recipientId, newExpiry).catch(() => {});
    if (isGift) {
      notifyGiftConfirmed(pool, payerId, recipientId, newExpiry).catch(() => {});
    }
    const newBalance = Number(payerRow.wallet_balance) - amount;
    notifyWalletLowIfNeeded(pool, payerId, newBalance).catch(() => {});

    return { ok: true, expiresAt: newExpiry, planMonths: plan.months, isGift };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, message: t('error.server') };
  } finally {
    client.release();
  }
}

// ─── getHistory ───────────────────────────────────────────────────────

async function getHistory(pool, userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query(
    `SELECT id, order_code, amount, status, plan_months, subscription_start, subscription_end, created_at, completed_at
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM subscriptions WHERE user_id = $1`,
    [userId]
  );

  return {
    subscriptions: rows,
    total: Number(countRows[0].count),
    page,
    limit,
  };
}

// ─── activateFromIap ─────────────────────────────────────────────────
/**
 * Activate a Premium subscription based on a verified IAP receipt.
 * Called by iap.service.verifyAndActivate AFTER the platform receipt has
 * been validated. Mirrors activateSubscription but skips the QR / payment
 * row workflow because IAP money already settled with Apple / Google.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {object} opts
 *   @param {string} opts.productId
 *   @param {string} opts.transactionId    used as order_code for traceability
 *   @param {number} opts.months           1 | 3 | 6 | 12
 *   @param {string} [opts.expiresAt]      platform-provided expiry (preferred)
 *   @param {string} opts.platform         'apple' | 'google'
 */
async function activateFromIap(pool, userId, { productId, transactionId, months, expiresAt, platform }) {
  const planMonths = Number(months) || 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const now = new Date();
    // Prefer the platform's expiry — it accounts for free trials, grace
    // periods, etc. — and fall back to today + planMonths only when the
    // verifier didn't surface one.
    const fallbackEnd = new Date(now);
    fallbackEnd.setMonth(fallbackEnd.getMonth() + planMonths);
    const subEnd = expiresAt ? new Date(expiresAt) : fallbackEnd;

    // Record the subscription with platform metadata so reporting can
    // break down revenue by source. Uses qr_url='' since there's no QR.
    await client.query(
      `INSERT INTO subscriptions (
         user_id, order_code, amount, qr_url, status, plan_months,
         subscription_start, subscription_end, completed_at, qr_expires_at
       ) VALUES ($1, $2, 0, '', 'completed', $3, $4, $5, NOW(), NOW())
       ON CONFLICT (order_code) DO NOTHING`,
      [userId, `iap:${platform}:${transactionId}`, planMonths, now, subEnd]
    );

    // Extend existing premium expiry if user is already premium and still active.
    const { rows: userRows } = await client.query(
      `SELECT subscription_tier, subscription_expires_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    const user = userRows[0];
    let newExpiry = subEnd;
    if (
      user?.subscription_tier === 'premium' &&
      user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > now &&
      // Only extend when the IAP didn't already include an absolute expiry
      // (Apple / Google's expiry is the authoritative one).
      !expiresAt
    ) {
      newExpiry = new Date(user.subscription_expires_at);
      newExpiry.setMonth(newExpiry.getMonth() + planMonths);
    }

    await client.query(
      `UPDATE users SET subscription_tier = 'premium', subscription_expires_at = $1 WHERE id = $2`,
      [newExpiry, userId]
    );

    await client.query('COMMIT');
    await cacheDel(`subscription:${userId}`);
    notifyPremiumActivated(pool, userId, newExpiry).catch(() => {});

    return { ok: true, expiresAt: newExpiry, planMonths, platform };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, message: err.message };
  } finally {
    client.release();
  }
}

// ─── IAP renewal / revoke from store webhooks ─────────────────────────
/**
 * Apply a renewal / expiry / revoke event coming from Apple Server
 * Notifications v2 or Google RTDN. Looks up the user via the existing
 * iap_receipts row (matched by original_transaction_id) and updates
 * users.subscription_expires_at — or downgrades them to free when the
 * event is REVOKE / REFUND / EXPIRED past now.
 *
 * @param {object} pool
 * @param {object} ev
 *   @param {'apple'|'google'} ev.platform
 *   @param {string}   ev.transactionId         the new event's tx id (DID_RENEW gives a new one)
 *   @param {string}   ev.originalTransactionId chain id — used to find the user
 *   @param {string}   ev.productId
 *   @param {string|null} ev.expiresAt          ISO; null when revoking
 *   @param {'renew'|'revoke'|'expire'}  ev.action
 *   @param {object}   [ev.rawPayload]
 */
async function applyIapWebhookEvent(pool, ev) {
  const {
    platform, transactionId, originalTransactionId, productId,
    expiresAt, action, rawPayload,
  } = ev;

  if (!originalTransactionId) {
    return { ok: false, error: 'Missing originalTransactionId' };
  }

  // 1. Find which user this chain belongs to via the first receipt we
  //    stored for it. If we can't, log and ack (Apple/Google retry forever
  //    otherwise) — there's nothing to update.
  const { rows } = await pool.query(
    `SELECT user_id FROM iap_receipts
     WHERE original_transaction_id = $1 OR transaction_id = $1
     ORDER BY id ASC LIMIT 1`,
    [originalTransactionId]
  );
  const userId = rows[0]?.user_id;
  if (!userId) {
    return { ok: false, error: 'Unknown subscription chain — no matching receipt' };
  }

  // 2. Persist the new receipt row for audit + future dedupe.
  if (transactionId) {
    try {
      await pool.query(
        `INSERT INTO iap_receipts
           (user_id, platform, product_id, transaction_id, original_transaction_id, expires_at, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [userId, platform, productId || 'unknown', transactionId,
         originalTransactionId, expiresAt || null, JSON.stringify(rawPayload || {})]
      );
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (action === 'renew' && expiresAt) {
      // Move expiry to the new value Apple/Google supplied. Always trust
      // the store's expiry — it accounts for prorations, grace periods.
      await client.query(
        `UPDATE users
         SET subscription_tier = 'premium', subscription_expires_at = $1
         WHERE id = $2`,
        [new Date(expiresAt), userId]
      );
    } else if (action === 'revoke' || action === 'expire') {
      // Downgrade to free, but only if the stored expiry was actually in
      // the past (or this is an explicit revoke). Prevents a race where a
      // late EXPIRED notification arrives after a renewal we already
      // applied.
      const { rows: u } = await client.query(
        `SELECT subscription_expires_at FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      const currentExpiry = u[0]?.subscription_expires_at;
      const shouldRevoke = action === 'revoke'
        || !currentExpiry
        || new Date(currentExpiry) <= new Date();

      if (shouldRevoke) {
        await client.query(
          `UPDATE users SET subscription_tier = 'free' WHERE id = $1`,
          [userId]
        );
      }
    }

    await client.query('COMMIT');
    await cacheDel(`subscription:${userId}`);
    return { ok: true, userId };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  PLANS,
  payWithWallet,
  VOICE_MONTHLY_LIMIT,
  PREMIUM_CONNECTION_LIMIT,
  FREE_CONNECTION_LIMIT,
  PREMIUM_HISTORY_DAYS,
  FREE_HISTORY_DAYS,
  createQRForRecipient,
  payWithWalletForRecipient,
  activateFromIap,
  applyIapWebhookEvent,
  getStatus,
  isPremium,
  createQR,
  activateSubscription,
  getHistory,
  parseSubDescription,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
};
