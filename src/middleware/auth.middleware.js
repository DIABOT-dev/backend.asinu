const jwt = require('jsonwebtoken');
const { t, getLang } = require('../i18n');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: t('error.missing_auth_token', getLang(req)) });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: t('error.invalid_token', getLang(req)) });
  }
}

const requireAuth = authenticateJWT;

module.exports = { authenticateJWT, requireAuth };
