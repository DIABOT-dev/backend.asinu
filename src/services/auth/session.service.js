'use strict';

async function isSessionCurrent(pool, claims) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Authentication database is not configured');
  }
  const userId = Number(claims?.id ?? claims?.user_id);
  const version = claims?.auth_version ?? 0; // Existing tokens remain valid until revoked.
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    !Number.isFinite(claims?.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    return false;
  }
  const result = await pool.query(
    'SELECT auth_token_version FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  return Boolean(result.rows[0] && Number(result.rows[0].auth_token_version) === version);
}

module.exports = { isSessionCurrent };
