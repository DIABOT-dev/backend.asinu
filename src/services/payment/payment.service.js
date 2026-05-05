/**
 * Payment Service — SePay QR
 *
 * Flow:
 *  1. createQR  → sinh order_code, lưu payments (pending), trả về qr_url
 *  2. handleWebhook → SePay gọi vào, validate, cộng wallet_balance, mark completed
 *  3. getBalance / getHistory → truy vấn thông tin ví
 */

const crypto = require('crypto');
const subscriptionService = require('./subscription.service');
const { t } = require('../../i18n');
const { sendAndSave } = require('../notification/basic.notification.service');

const WALLET_LOW_BALANCE_THRESHOLD = 50000; // 50.000đ

const SEPAY_ACCOUNT = process.env.SEPAY_ACCOUNT_NUMBER;
const SEPAY_BANK    = process.env.SEPAY_BANK_CODE;
const SEPAY_API_KEY = process.env.SEPAY_API_KEY;

// ─── Helpers ────────────────────────────────────────────────────

function generateOrderCode() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Mô tả giao dịch nhúng vào QR:
 *   asinupay{userId}order{orderCode}
 * SePay sẽ trả về chuỗi này trong content của webhook.
 */
function buildDescription(userId, orderCode) {
  return `asinupay${userId}order${orderCode}`;
}

function parseDescription(content) {
  const userMatch  = content.match(/asinupay(\d+)/);
  const orderMatch = content.match(/order([a-zA-Z0-9]+)/);
  if (!userMatch || !orderMatch) return null;
  return { userId: Number(userMatch[1]), orderCode: orderMatch[1] };
}

// ─── createQR ───────────────────────────────────────────────────

/**
 * Tạo QR nạp tiền cho user.
 * @param {object} pool  - pg Pool
 * @param {number} userId
 * @param {number} amount - VND
 * @returns {{ orderCode, qrUrl }}
 */
async function createQR(pool, userId, amount) {
  if (!amount || amount < 1000) {
    throw Object.assign(new Error(t('error.min_amount')), { statusCode: 400 });
  }

  const orderCode   = generateOrderCode();
  const description = buildDescription(userId, orderCode);
  const qrUrl = `https://qr.sepay.vn/img?acc=${SEPAY_ACCOUNT}&bank=${SEPAY_BANK}&amount=${amount}&des=${description}`;

  const { rows: inserted } = await pool.query(
    `INSERT INTO payments (order_code, user_id, amount, qr_url, status, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW() + INTERVAL '30 minutes')
     RETURNING expires_at`,
    [orderCode, userId, amount, qrUrl]
  );

  return { order_code: orderCode, qr_url: qrUrl, amount, description, expires_at: inserted[0].expires_at };
}

// ─── handleWebhook ──────────────────────────────────────────────

/**
 * Xử lý webhook từ SePay sau khi user chuyển tiền.
 * SePay gửi POST với header: Authorization: Apikey {SEPAY_API_KEY}
 */
async function handleWebhook(pool, req) {
  // 1. Xác thực API key
  const authHeader = req.headers['authorization'] || '';
  const incoming   = authHeader.replace(/^Apikey\s+/i, '').trim();
  if (!SEPAY_API_KEY || incoming !== SEPAY_API_KEY) {
    return { ok: false, statusCode: 401, message: t('error.unauthorized') };
  }

  const body = req.body;
  const transferAmount = Number(body.transferAmount);
  const content        = String(body.content || '');

  // 2. Kiểm tra loại giao dịch dựa vào nội dung chuyển khoản
  // asinusub → subscription payment
  if (content.includes('asinusub')) {
    const subParsed = subscriptionService.parseSubDescription(content);
    if (!subParsed) {

      return { ok: true, message: 'ignored' };
    }

    const result = await subscriptionService.activateSubscription(
      pool,
      subParsed.userId,
      subParsed.orderCode
    );
    return { ok: result.ok, message: result.ok ? 'subscription_activated' : result.message };
  }

  // 3. Parse mô tả để lấy userId và orderCode (wallet top-up)
  const parsed = parseDescription(content);
  if (!parsed) {
    // Không phải giao dịch của Asinu — trả 200 để SePay không retry

    return { ok: true, message: 'ignored' };
  }

  const { userId, orderCode } = parsed;

  // 3. Atomically claim the pending payment (prevents double-credit on webhook retry)
  const { rows } = await pool.query(
    `UPDATE payments SET status = 'completed', completed_at = NOW()
     WHERE order_code = $1 AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [orderCode]
  );

  if (!rows.length) {
    return { ok: false, statusCode: 404, message: t('error.payment_not_found') };
  }

  const payment = rows[0];

  // 4. Kiểm tra số tiền
  if (Number(payment.amount) !== transferAmount) {
    await pool.query(
      `UPDATE payments SET status = 'failed' WHERE order_code = $1`,
      [orderCode]
    );
    // Thông báo thanh toán thất bại
    notifyPaymentFailed(pool, userId, payment.amount).catch(() => {});
    return { ok: false, statusCode: 400, message: t('error.payment_amount_mismatch') };
  }

  // 5. Cộng wallet
  const { rows: balRows } = await pool.query(
    `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance, push_token, language_preference`,
    [transferAmount, userId]
  );

  // Notify wallet topup success (non-blocking)
  if (balRows[0]) {
    const u = balRows[0];
    const lang = u.language_preference || 'vi';
    sendAndSave(pool, { id: userId, push_token: u.push_token }, 'wallet_topup_success',
      t('push.wallet_topup_title', lang),
      t('push.wallet_topup_body', lang, {
        amount: Number(transferAmount).toLocaleString('vi-VN'),
        balance: Number(u.wallet_balance).toLocaleString('vi-VN'),
      }),
      { amount: String(transferAmount), balance: String(u.wallet_balance), orderCode }
    ).catch(() => {});
  }

  return { ok: true, message: 'completed', userId, amount: transferAmount, orderCode };
}

// Helper: gửi thông báo thanh toán thất bại
async function notifyPaymentFailed(pool, userId, amount) {
  const { rows } = await pool.query(
    `SELECT push_token, language_preference FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return;
  const u = rows[0];
  const lang = u.language_preference || 'vi';
  return sendAndSave(pool, { id: userId, push_token: u.push_token }, 'payment_failed',
    t('push.payment_failed_title', lang),
    t('push.payment_failed_body', lang, { amount: Number(amount).toLocaleString('vi-VN') }),
    { amount: String(amount) }
  );
}

// ─── getBalance ─────────────────────────────────────────────────

async function getBalance(pool, userId) {
  const { rows } = await pool.query(
    `SELECT wallet_balance FROM users WHERE id = $1`,
    [userId]
  );
  return { balance: Number(rows[0]?.wallet_balance ?? 0) };
}

// ─── getHistory ─────────────────────────────────────────────────

async function getHistory(pool, userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const { rows } = await pool.query(
    `SELECT id, order_code, amount, status, qr_url, created_at, completed_at
     FROM payments
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM payments WHERE user_id = $1`,
    [userId]
  );

  return {
    payments: rows,
    total: Number(countRows[0].count),
    page,
    limit,
  };
}

module.exports = { createQR, handleWebhook, getBalance, getHistory };
