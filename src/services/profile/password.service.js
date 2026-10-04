'use strict';

const { hashPassword, comparePassword, issueJwt } = require('../auth/auth.service');

async function changePassword(pool, userId, currentPassword, newPassword) {
  const { rows } = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  if (!rows.length || !rows[0].password_hash) return 'PASSWORD_NOT_SET';

  const valid = await comparePassword(currentPassword, rows[0].password_hash);
  if (!valid) return 'CURRENT_PASSWORD_WRONG';

  const newHash = await hashPassword(newPassword);
  const updated = await pool.query(
    'UPDATE users SET password_hash = $1, auth_token_version = auth_token_version + 1, updated_at = NOW() WHERE id = $2 AND password_hash = $3 AND deleted_at IS NULL RETURNING id, email, auth_token_version',
    [newHash, userId, rows[0].password_hash]
  );
  if (!updated.rows.length) return 'CURRENT_PASSWORD_WRONG';
  // Keep only the password-changing device signed in; all old tokens are revoked.
  return { token: issueJwt(updated.rows[0]).token };
}

module.exports = { changePassword };
