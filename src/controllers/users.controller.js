/**
 * User Search Controller
 * For searching users in the system (for care circle invitations, etc.)
 */

async function searchUsers(pool, req, res) {
  const query = String(req.query.q || '').trim();
  
  if (!query || query.length < 2) {
    return res.status(400).json({ ok: false, error: 'Từ khóa quá ngắn (tối thiểu 2 ký tự)' });
  }

  try {
    // Search by display_name, full_name, email, or phone
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
      [req.user.id, `%${query}%`, `${query}%`]
    );

    const users = result.rows.map(row => ({
      id: String(row.id),
      name: row.name || `User ${row.id}`,
      email: row.email || null,
      phone: row.phone || null
    }));

    return res.status(200).json({ ok: true, users });
  } catch (err) {
    console.error('search users failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getAllUsers(pool, req, res) {
  try {
    // Get all users except current user, limit to 100
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
       LIMIT 100`,
      [req.user.id]
    );

    const users = result.rows.map(row => ({
      id: String(row.id),
      name: row.name || `User ${row.id}`,
      email: row.email || null,
      phone: row.phone || null
    }));

    return res.status(200).json({ ok: true, users });
  } catch (err) {
    console.error('get all users failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

module.exports = {
  searchUsers,
  getAllUsers
};
