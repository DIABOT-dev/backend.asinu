/**
 * Subscription Middleware
 * Protect An Tam-only endpoints such as the AI call centre.
 */

const { isAnTam } = require('../services/payment/subscription.service');
const { t, getLang } = require('../i18n');

/**
 * Middleware factory — requires an active An Tam household entitlement.
 */
function requireAnTam(pool) {
  return async function (req, res, next) {
    const userId = req.user?.id;
    if (!userId) {
      return res
        .status(401)
        .json({ ok: false, code: 'UNAUTHORIZED', error: t('error.unauthenticated', getLang(req)) });
    }

    try {
      const enabled = await isAnTam(pool, userId);
      if (!enabled) {
        return res.status(403).json({
          ok: false,
          code: 'AN_TAM_REQUIRED',
          error: t('error.an_tam_required', getLang(req)),
        });
      }
      next();
    } catch (err) {
      return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
    }
  };
}

module.exports = { requireAnTam };
