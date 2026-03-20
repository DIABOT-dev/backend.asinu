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

const PLANS = {
  1:  { months: 1,  labelKey: 'subscription.plan_1',  discount: 0,  price: 199000  },
  3:  { months: 3,  labelKey: 'subscription.plan_3',  discount: 5,  price: 567000  }, // 199000*3*0.95 = 567150 → 567000
  6:  { months: 6,  labelKey: 'subscription.plan_6',  discount: 10, price: 1075000 }, // 199000*6*0.90 = 1074600 → 1075000
  12: { months: 12, labelKey: 'subscription.plan_12', discount: 20, price: 1910000 }, // 199000*12*0.80 = 1910400 → 1910000
};

// ─── Limits ────────────────────────────────────────────────────────

const VOICE_MONTHLY_LIMIT      = 5000;
const PREMIUM_CONNECTION_LIMIT = 50;
const PREMIUM_HISTORY_DAYS     = 365;
const FREE_HISTORY_DAYS        = 7;

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
  const plan = PLANS[months] || PLANS[1];
  const amount = plan.price;
  const orderCode = generateOrderCode();
  const description = buildDescription(userId, orderCode);
  const qrUrl = `https://qr.sepay.vn/img?acc=${SEPAY_ACCOUNT}&bank=${SEPAY_BANK}&amount=${amount}&des=${description}`;

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, order_code, amount, qr_url, status, plan_months, qr_expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW() + INTERVAL '30 minutes')
     RETURNING qr_expires_at`,
    [userId, orderCode, amount, qrUrl, plan.months]
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

    return { ok: true, expiresAt: newExpiry, planMonths };
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
  VOICE_MONTHLY_LIMIT,
  PREMIUM_CONNECTION_LIMIT,
  PREMIUM_HISTORY_DAYS,
  FREE_HISTORY_DAYS,
  getStatus,
  isPremium,
  createQR,
  activateSubscription,
  getHistory,
  parseSubDescription,
  getVoiceUsageThisMonth,
  incrementVoiceUsage,
};
