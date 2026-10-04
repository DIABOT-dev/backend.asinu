const jwt = require('jsonwebtoken');
const { t, getLang } = require('../i18n');
const { isSessionCurrent } = require('../services/auth/session.service');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[FATAL] JWT_SECRET environment variable is not set. Server cannot start.');
}

async function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: t('error.missing_auth_token', getLang(req)) });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ ok: false, error: t('error.invalid_token', getLang(req)) });
  }
  try {
    if (!(await isSessionCurrent(req.app?.locals?.authPool, payload))) {
      return res.status(401).json({ ok: false, error: t('error.invalid_token', getLang(req)) });
    }
  } catch (err) {
    // A DB outage must not bypass revocation or turn into an unhandled rejection.
    return res.status(503).json({ ok: false, error: t('error.server', getLang(req)) });
  }
  req.user = payload;
  return next();
}

const requireAuth = authenticateJWT;

module.exports = { authenticateJWT, requireAuth };
