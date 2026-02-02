const { requireAuth } = require('../../src/middleware/auth.middleware');

function requireBrainAuth(req, res, next) {
  return requireAuth(req, res, () => {
    const payload = req.user || {};
    const rawUserId = payload.id ?? payload.user_id ?? payload.sub;
    const userId = typeof rawUserId === 'string' ? rawUserId.trim() : rawUserId;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Token missing user_id' });
    }
    req.userId = userId;
    return next();
  });
}

module.exports = { requireBrainAuth };
