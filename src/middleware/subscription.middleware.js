/**
 * Subscription Middleware
 * Protect premium-only endpoints.
 */

const { isPremium } = require('../services/subscription.service');
const { t, getLang } = require('../i18n');

/**
 * Middleware factory — requires a premium subscription.
 * Usage: router.post('/voice/chat', requireAuth, requirePremium(pool), handler)
 */
function requirePremium(pool) {
  return async function (req, res, next) {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: t('error.unauthenticated', getLang(req)) });
    }

    try {
      const premium = await isPremium(pool, userId);
      if (!premium) {
        return res.status(403).json({
          ok: false,
          code: 'PREMIUM_REQUIRED',
          error: t('error.premium_required', getLang(req)),
        });
      }
      next();
    } catch (err) {

      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  };
}

module.exports = { requirePremium };
