const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireGooglePubSubAuth } = require('../middleware/google-pubsub-auth.middleware');
const {
  verifyReceipt,
  listProducts,
  appleNotifications,
  googleNotifications,
} = require('../controllers/iap.controller');

/**
 * Stricter limiter on /verify only. A legitimate user calls /verify
 * at most a handful of times per minute (initial purchase, retry on
 * network blip, "restore purchases"). Anything beyond that is brute-force
 * receipt spraying or an integration bug that's worth a 429.
 *
 * Keyed by authenticated user id when present so multiple users behind
 * the same NAT (e.g. office wifi) aren't punished together. Falls back
 * to IP for unauth'd cases (shouldn't happen — verify requires auth).
 *
 * NOT applied to webhooks — Apple/Google retry aggressively and we'd
 * be throwing away legit traffic.
 */
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 verify attempts per minute per user
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', error: 'Too many verification attempts; slow down.' },
  keyGenerator: (req) =>
    req.user && req.user.id ? `iap-verify:user:${req.user.id}` : `iap-verify:ip:${req.ip}`,
});

function iapRoutes(pool) {
  const router = express.Router();

  // Public — client needs pricing before sign-in to render a "from N₫" badge.
  router.get('/products', (req, res) => listProducts(pool, req, res));

  // Authenticated — every receipt must be tied to a user.
  // requireAuth runs FIRST so the limiter can key by user id.
  router.post('/verify', requireAuth, verifyLimiter, (req, res) => verifyReceipt(pool, req, res));

  // Store webhooks — Apple signs the body; Google must also present a
  // verified Pub/Sub OIDC identity. Keep these URLs out of public docs.
  router.post('/apple-notifications', (req, res) => appleNotifications(pool, req, res));
  router.post(
    '/google-notifications',
    requireGooglePubSubAuth,
    (req, res) => googleNotifications(pool, req, res)
  );

  return router;
}

module.exports = iapRoutes;
