'use strict';

const { hashPassword, comparePassword } = require('../auth/auth.service');

async function changePassword(pool, userId, currentPassword, newPassword) {
  const { rows } = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  if (!rows.length || !rows[0].password_hash) return 'PASSWORD_NOT_SET';

  const valid = await comparePassword(currentPassword, rows[0].password_hash);
  if (!valid) return 'CURRENT_PASSWORD_WRONG';

  const newHash = await hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
    newHash,
    userId,
  ]);
  return 'PASSWORD_CHANGED';
}

module.exports = { changePassword };
