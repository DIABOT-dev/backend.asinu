/**
 * Users Service
 * Business logic cho user search và management
 */

const { t } = require('../../i18n');

/**
 * Search users by query string
 * @param {Object} pool - Database pool
 * @param {number} currentUserId - Current user ID to exclude
 * @param {string} query - Search query
 * @returns {Promise<Object>} - { ok, users, error }
 */
async function searchUsers(pool, currentUserId, query) {
  try {
    const q = query.trim();
    // Chỉ chấp nhận số điện thoại hợp lệ: 10 số bắt đầu 0, hoặc +84 + 9 số
    const isValidPhone = /^(0[0-9]{9}|\+84[0-9]{9})$/.test(q);
    if (!isValidPhone) {
      return { ok: true, users: [] };
    }

    // Chuẩn hoá: +84xxxxxxxxx → 0xxxxxxxxx
    const normalized = q.startsWith('+84') ? '0' + q.slice(3) : q;
    const sql = `SELECT id, COALESCE(display_name, full_name, email) as name, email, phone_number as phone
                 FROM users
                 WHERE deleted_at IS NULL AND id != $1
                   AND REGEXP_REPLACE(phone_number, '^\\+84', '0') = $2
                 LIMIT 1`;
    const params = [currentUserId, normalized];

    const result = await pool.query(sql, params);

    const users = result.rows.map(row => ({
      id: String(row.id),
      name: row.name || `User ${row.id}`,
      email: row.email || null,
      phone: row.phone || null
    }));

    return { ok: true, users };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Get all users (paginated)
 * @param {Object} pool - Database pool
 * @param {number} currentUserId - Current user ID to exclude
 * @param {number} limit - Max results
 * @returns {Promise<Object>} - { ok, users, error }
 */
async function getAllUsers(pool, currentUserId, limit = 100) {
  try {
    const result = await pool.query(
      `SELECT
        id,
        COALESCE(display_name, full_name, email) as name,
        email,
        phone_number as phone
       FROM users
       WHERE deleted_at IS NULL
         AND id != $1
       ORDER BY COALESCE(display_name, full_name, email)
       LIMIT $2`,
      [currentUserId, limit]
    );

    const users = result.rows.map(row => ({
      id: String(row.id),
      name: row.name || `User ${row.id}`,
      email: row.email || null,
      phone: row.phone || null
    }));

    return { ok: true, users };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

module.exports = {
  searchUsers,
  getAllUsers
};
