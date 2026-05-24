/**
 * IAP controller — HTTP layer for Apple App Store / Google Play Billing.
 *
 * POST /api/iap/verify
 *   body: { platform, productId, purchaseToken?, signedTransaction?, receiptData? }
 *   Returns: { ok, expiresAt, planMonths } | { ok: false, code, error }
 *
 * GET /api/iap/products
 *   Returns the product ID + price metadata so the mobile client can show
 *   a price even before the StoreKit / Play Billing query resolves.
 */

const { t, getLang } = require('../i18n');
const iapService = require('../services/payment/iap.service');

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.asinu.lite';
const GOOGLE_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.asinu.lite';

async function verifyReceipt(pool, req, res) {
  const userId = req.user?.id;
  const payload = req.body || {};

  if (!userId) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: t('error.unauthenticated', getLang(req)) });
  }
  if (!payload.platform) {
    return res.status(400).json({ ok: false, code: 'INVALID_PAYLOAD', error: 'Missing platform' });
  }

  try {
    const result = await iapService.verifyAndActivate(pool, userId, payload);
    if (!result.ok) {
      // 402 Payment Required for verification failures so the FE can
      // distinguish them from auth or validation errors.
      return res.status(402).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Static catalogue of products — the client uses this to verify it knows
 * the right product IDs before querying the platform store, and to show
 * a placeholder price on slow networks.
 */
function listProducts(_pool, req, res) {
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    ok: true,
    apple_bundle_id: APPLE_BUNDLE_ID,
    google_package_name: GOOGLE_PACKAGE_NAME,
    products: [
      {
        id: process.env.IAP_PRODUCT_MONTHLY || 'asinu.premium.monthly',
        plan_months: 1,
        display_price_vnd: 199000,
      },
      {
        id: process.env.IAP_PRODUCT_YEARLY || 'asinu.premium.yearly',
        plan_months: 12,
        display_price_vnd: 999000,
      },
    ],
  });
}

/**
 * Apple Server Notifications v2 — Apple POSTs signed JWS webhook envelopes
 * here when subscriptions renew, expire, refund, or are revoked. URL goes
 * in App Store Connect → App Information → App Store Server Notifications.
 *
 * Apple expects 200 within 5s; non-2xx triggers exponential retry for 3 days.
 * We always return 200 unless verification fails so retries don't loop.
 */
async function appleNotifications(pool, req, res) {
  try {
    const result = await iapService.handleAppleNotification(pool, req.body || {});
    if (!result.ok && result.code === 'APPLE_NOTIF_VERIFY_FAILED') {
      // Signature failed → 401 so attacker doesn't get acked.
      return res.status(401).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Google Play Real-Time Developer Notifications — Pub/Sub push delivers
 * subscription state changes here. Configure in Google Play Console →
 * Monetization setup → Real-time developer notifications.
 *
 * Pub/Sub retries non-200 responses; ack everything we accept.
 */
async function googleNotifications(pool, req, res) {
  try {
    const result = await iapService.handleGoogleNotification(pool, req.body || {});
    // Always 200 to ack — even errors we logged. Pub/Sub will retry only
    // on 5xx, and we don't want infinite retry on a malformed message.
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { verifyReceipt, listProducts, appleNotifications, googleNotifications };
