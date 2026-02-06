/**
 * Users Service
 * Business logic cho user search và management
 */

/**
 * Search users by query string
 * @param {Object} pool - Database pool
 * @param {number} currentUserId - Current user ID to exclude
 * @param {string} query - Search query
 * @returns {Promise<Object>} - { ok, users, error }
 */
async function searchUsers(pool, currentUserId, query) {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        COALESCE(display_name, full_name, email) as name,
        email,
        COALESCE(phone, phone_number) as phone
       FROM users
       WHERE deleted_at IS NULL
         AND id != $1
         AND (
           display_name ILIKE $2
           OR full_name ILIKE $2
           OR email ILIKE $2
           OR phone ILIKE $2
           OR phone_number ILIKE $2
         )
       ORDER BY 
         CASE 
           WHEN display_name ILIKE $3 THEN 1
           WHEN full_name ILIKE $3 THEN 2
           WHEN email ILIKE $3 THEN 3
           ELSE 4
         END,
         COALESCE(display_name, full_name, email)
       LIMIT 20`,
      [currentUserId, `%${query}%`, `${query}%`]
    );

    const users = result.rows.map(row => ({
      id: String(row.id),
      name: row.name || `User ${row.id}`,
      email: row.email || null,
      phone: row.phone || null
    }));

    return { ok: true, users };
  } catch (err) {
    console.error('[users.service] searchUsers failed:', err);
    return { ok: false, error: 'Lỗi server' };
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
        COALESCE(phone, phone_number) as phone
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
    console.error('[users.service] getAllUsers failed:', err);
    return { ok: false, error: 'Lỗi server' };
  }
}

module.exports = {
  searchUsers,
  getAllUsers
};
