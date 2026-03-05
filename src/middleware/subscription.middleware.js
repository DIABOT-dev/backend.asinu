/**
 * Subscription Middleware
 * Protect premium-only endpoints.
 */

const { isPremium } = require('../services/subscription.service');

/**
 * Middleware factory — requires a premium subscription.
 * Usage: router.post('/voice/chat', requireAuth, requirePremium(pool), handler)
 */
function requirePremium(pool) {
  return async function (req, res, next) {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: 'Vui lòng đăng nhập' });
    }

    try {
      const premium = await isPremium(pool, userId);
      if (!premium) {
        return res.status(403).json({
          ok: false,
          code: 'PREMIUM_REQUIRED',
          error: 'Tính năng này yêu cầu gói Premium. Nâng cấp để sử dụng.',
        });
      }
      next();
    } catch (err) {
      console.error('[subscription.middleware] requirePremium error:', err);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  };
}

module.exports = { requirePremium };
