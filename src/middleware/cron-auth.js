'use strict';

/**
 * Authentication for internal scheduled/diagnostic endpoints.
 * Keep the secret in a header so it never appears in URLs or access logs.
 */
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('x-cron-secret') !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

module.exports = { requireCronSecret };
