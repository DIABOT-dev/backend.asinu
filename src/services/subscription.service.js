/**
 * Subscription Service — Free vs Premium tier
 *
 * Flow:
 *  1. createQR  → sinh order_code, lưu subscriptions (pending), trả về qr_url
 *  2. activateSubscription → được gọi từ webhook, cập nhật user tier
 *  3. getStatus / isPremium → kiểm tra tier hiện tại
 */

const crypto = require('crypto');

const SEPAY_ACCOUNT = process.env.SEPAY_ACCOUNT_NUMBER;
const SEPAY_BANK    = process.env.SEPAY_BANK_CODE;
const SUBSCRIPTION_PRICE = Number(process.env.SUBSCRIPTION_PRICE) || 199000;

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── getStatus ──────────────────────────────────────────────────

/**
 * Lấy trạng thái subscription hiện tại của user.
 * @returns {{ tier, isPremium, expiresAt }}
 */
async function getStatus(pool, userId) {
  const { rows } = await pool.query(
    `SELECT subscription_tier, subscription_expires_at FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) return { tier: 'free', isPremium: false, expiresAt: null };

  const tier = user.subscription_tier || 'free';
  const expiresAt = user.subscription_expires_at;
  const isPremium = tier === 'premium' && expiresAt && new Date(expiresAt) > new Date();

  return { tier: isPremium ? 'premium' : 'free', isPremium: Boolean(isPremium), expiresAt };
}

// ─── isPremium ──────────────────────────────────────────────────

async function isPremium(pool, userId) {
  const status = await getStatus(pool, userId);
  return status.isPremium;
}

// ─── createQR ───────────────────────────────────────────────────

/**
 * Tạo QR đăng ký Premium.
 * @param {object} pool
 * @param {number} userId
 * @param {number} months - số tháng (default 1)
 * @returns {{ orderCode, qrUrl, amount, description, expiresAt }}
 */
async function createQR(pool, userId, months = 1) {
  const amount = SUBSCRIPTION_PRICE * months;
  const orderCode = generateOrderCode();
  const description = buildDescription(userId, orderCode);
  const qrUrl = `https://qr.sepay.vn/img?acc=${SEPAY_ACCOUNT}&bank=${SEPAY_BANK}&amount=${amount}&des=${description}`;

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, order_code, amount, qr_url, status, plan_months, qr_expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW() + INTERVAL '30 minutes')
     RETURNING qr_expires_at`,
    [userId, orderCode, amount, qrUrl, months]
  );

  return {
    order_code: orderCode,
    qr_url: qrUrl,
    amount,
    description,
    expires_at: rows[0].qr_expires_at,
    plan_months: months,
  };
}

// ─── activateSubscription ────────────────────────────────────────

/**
 * Kích hoạt Premium cho user sau khi thanh toán thành công.
 * Được gọi từ payment webhook.
 */
async function activateSubscription(pool, userId, orderCode, months = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lấy thông tin subscription
    const { rows: subRows } = await client.query(
      `SELECT * FROM subscriptions WHERE order_code = $1 AND status = 'pending' AND qr_expires_at > NOW()`,
      [orderCode]
    );

    if (!subRows.length) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'Subscription not found or expired' };
    }

    const sub = subRows[0];
    const planMonths = sub.plan_months || months;
    const now = new Date();
    const subEnd = new Date(now);
    subEnd.setMonth(subEnd.getMonth() + planMonths);

    // Cập nhật subscriptions record
    await client.query(
      `UPDATE subscriptions
       SET status = 'completed', subscription_start = $1, subscription_end = $2, completed_at = NOW()
       WHERE order_code = $3`,
      [now, subEnd, orderCode]
    );

    // Cập nhật user tier — extend nếu đang là premium
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
      // Extend từ ngày hết hạn hiện tại
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
    console.log(`[subscription] ✅ user ${userId} activated premium until ${newExpiry.toISOString()}`);
    return { ok: true, expiresAt: newExpiry, planMonths };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[subscription] activateSubscription failed:', err);
    return { ok: false, message: 'Internal error' };
  } finally {
    client.release();
  }
}

// ─── getHistory ──────────────────────────────────────────────────

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
  getStatus,
  isPremium,
  createQR,
  activateSubscription,
  getHistory,
  parseSubDescription,
};
