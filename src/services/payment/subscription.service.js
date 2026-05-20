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
    const dateStr = new Date(expiresAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'vi-VN');
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
    const dateStr = new Date(expiresAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'vi-VN');
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
  const plan = PLANS[months] || PLANS[1];
  const amount = plan.price;
  const orderCode = generateOrderCode();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock row và kiểm tra số dư
    const { rows: userRows } = await client.query(
      `SELECT wallet_balance, subscription_tier, subscription_expires_at
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    const user = userRows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return { ok: false, message: t('error.user_not_found') };
    }

    if (Number(user.wallet_balance) < amount) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message: `Số dư ví không đủ. Cần ${amount.toLocaleString('vi-VN')}đ, hiện có ${Number(user.wallet_balance).toLocaleString('vi-VN')}đ.`,
      };
    }

    // Trừ số dư ví
    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
      [amount, userId]
    );

    // Ghi lịch sử subscription
    const now = new Date();
    const subEnd = new Date(now);
    subEnd.setMonth(subEnd.getMonth() + plan.months);

    await client.query(
      `INSERT INTO subscriptions (user_id, order_code, amount, qr_url, status, plan_months, subscription_start, subscription_end, completed_at, qr_expires_at)
       VALUES ($1, $2, $3, '', 'completed', $4, $5, $6, NOW(), NOW())`,
      [userId, orderCode, amount, plan.months, now, subEnd]
    );

    // Gia hạn nếu đang là premium
    let newExpiry = subEnd;
    if (
      user.subscription_tier === 'premium' &&
      user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > now
    ) {
      newExpiry = new Date(user.subscription_expires_at);
      newExpiry.setMonth(newExpiry.getMonth() + plan.months);
    }

    await client.query(
      `UPDATE users SET subscription_tier = 'premium', subscription_expires_at = $1 WHERE id = $2`,
      [newExpiry, userId]
    );

    await client.query('COMMIT');
    await cacheDel(`subscription:${userId}`);

    // Notify Premium activated + check low balance after deduction
    notifyPremiumActivated(pool, userId, newExpiry).catch(() => {});
    const newBalance = Number(user.wallet_balance) - amount;
    notifyWalletLowIfNeeded(pool, userId, newBalance).catch(() => {});

    return { ok: true, expiresAt: newExpiry, planMonths: plan.months };
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

module.exports = {
  PLANS,
  payWithWallet,
  VOICE_MONTHLY_LIMIT,
  PREMIUM_CONNECTION_LIMIT,
  FREE_CONNECTION_LIMIT,
  PREMIUM_HISTORY_DAYS,
  FREE_HISTORY_DAYS,
  createQRForRecipient,
  getStatus,
  isPremium,
  createQR,
  activateSubscription,
  getHistory,
  parseSubDescription,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
};
