/**
 * In-App Purchase (IAP) verification service.
 *
 * Apple App Store + Google Play Billing both require digital subscription
 * receipts to be verified server-side before activating the subscription
 * (mobile clients are trusted to PRESENT the receipt, never to claim it's
 * valid). This module centralises that verification so the rest of the
 * codebase calls a single `verifyAndActivate(pool, userId, payload)` and
 * doesn't care which platform the receipt came from.
 *
 * Implementation status:
 *  - Stubs in place for Apple App Store Server API (Notifications v2 era).
 *  - Stubs in place for Google Play Developer API (subscriptionsv2).
 *  - Both delegate to subscription.service.activateSubscription so the
 *    downstream "Premium active until X" state machine is the same
 *    regardless of payment source (IAP, SePay QR, wallet).
 *
 * TODO before production:
 *  - Wire the real Apple verifier (App Store Server SDK or HTTP fetch with
 *    JWT signed by your APP_STORE_KEY + APP_STORE_ISSUER_ID).
 *  - Wire the real Google verifier (googleapis client + service account).
 *  - Subscribe to Apple Server Notifications v2 + Google Pub/Sub for
 *    renewals / cancellations / refunds.
 */

const logger = require('../../lib/logger');
const subscriptionService = require('./subscription.service');

// ─── Provider detection ────────────────────────────────────────────

const PLATFORM_APPLE = 'apple';
const PLATFORM_GOOGLE = 'google';

function isApplePlatform(p) {
  return String(p || '').toLowerCase() === PLATFORM_APPLE || String(p || '').toLowerCase() === 'ios';
}
function isGooglePlatform(p) {
  return String(p || '').toLowerCase() === PLATFORM_GOOGLE || String(p || '').toLowerCase() === 'android';
}

// ─── Product ID → plan months mapping ──────────────────────────────

/**
 * The mobile client passes the product ID from App Store / Play Console
 * (e.g. `asinu.premium.monthly`). We map it to the same plan_months
 * value the SePay flow uses so the subscription record stays uniform.
 */
function productIdToMonths(productId) {
  const id = String(productId || '').toLowerCase();
  if (id.endsWith('.monthly') || id.endsWith('.month') || id.endsWith('.1m')) return 1;
  if (id.endsWith('.quarterly') || id.endsWith('.3m')) return 3;
  if (id.endsWith('.semiannual') || id.endsWith('.6m')) return 6;
  if (id.endsWith('.yearly') || id.endsWith('.annual') || id.endsWith('.year') || id.endsWith('.12m')) return 12;
  return null;
}

// ─── Apple verifier (STUB) ─────────────────────────────────────────

/**
 * Verify an Apple App Store receipt / signed transaction.
 *
 * Inputs (one of):
 *   - signedTransaction: a JWS string (App Store Server API v2 era)
 *   - receiptData: base64 string (legacy verifyReceipt era)
 *
 * Returns a normalized:
 *   { ok: true, productId, transactionId, originalTransactionId,
 *     expiresAt, environment }
 * or { ok: false, code, error }.
 *
 * NOT YET IMPLEMENTED — returns ok:false so callers can detect the stub.
 */
async function verifyAppleReceipt({ signedTransaction, receiptData } = {}) {
  if (!signedTransaction && !receiptData) {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Missing Apple receipt' };
  }
  // TODO: integrate App Store Server API.
  //  1. If signedTransaction: decode JWT header → fetch Apple keys →
  //     verify signature against APPLE_BUNDLE_ID audience → read claims.
  //  2. If receiptData (legacy): POST to /verifyReceipt with
  //     APPLE_APP_STORE_SHARED_SECRET; check status code; read latest_receipt_info.
  logger.warn('iap.apple_verify.not_implemented');
  return {
    ok: false,
    code: 'APPLE_VERIFIER_NOT_IMPLEMENTED',
    error: 'Apple receipt verifier is scaffolded only — set up APPLE_APP_STORE_* env first.',
  };
}

// ─── Google verifier (STUB) ────────────────────────────────────────

/**
 * Verify a Google Play subscription purchase.
 *
 * Inputs:
 *   - productId: subscription SKU configured on Play Console
 *   - purchaseToken: token returned by the Play Billing client
 *
 * Returns the same normalized shape as the Apple verifier.
 */
async function verifyGooglePurchase({ productId, purchaseToken } = {}) {
  if (!productId || !purchaseToken) {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Missing Google productId or purchaseToken' };
  }
  // TODO: integrate googleapis client.
  //  1. Auth with GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.
  //  2. Call androidpublisher.purchases.subscriptionsv2.get
  //     ({ packageName: GOOGLE_PLAY_PACKAGE_NAME, token: purchaseToken }).
  //  3. Read state (ACTIVE / CANCELED / IN_GRACE / ON_HOLD / EXPIRED).
  //  4. Map to normalized shape.
  logger.warn('iap.google_verify.not_implemented');
  return {
    ok: false,
    code: 'GOOGLE_VERIFIER_NOT_IMPLEMENTED',
    error: 'Google Play verifier is scaffolded only — set up GOOGLE_PLAY_SERVICE_ACCOUNT_JSON first.',
  };
}

// ─── Idempotency: store the receipt before activating ─────────────

/**
 * Insert a row into iap_receipts with the platform's globally-unique
 * transaction id. Returns `false` if we've already processed it
 * (ON CONFLICT DO NOTHING), so caller can skip re-activation.
 */
async function recordReceipt(pool, { userId, platform, productId, transactionId, originalTransactionId, expiresAt, rawPayload }) {
  try {
    const insert = await pool.query(
      `INSERT INTO iap_receipts
         (user_id, platform, product_id, transaction_id, original_transaction_id, expires_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING id`,
      [userId, platform, productId, transactionId, originalTransactionId || null, expiresAt || null,
       JSON.stringify(rawPayload || {})]
    );
    return insert.rowCount > 0;
  } catch (err) {
    // 42P01 = relation does not exist — migration not yet applied
    if (err.code === '42P01') {
      logger.warn('iap.receipts_table_missing — migration 072_iap_receipts.sql chưa chạy');
      return true; // fail-open so we don't double-charge while migration is pending
    }
    throw err;
  }
}

// ─── Public entry point ────────────────────────────────────────────

/**
 * The single function the mobile-facing API route calls. Picks the right
 * verifier based on `platform`, records the receipt for idempotency, and
 * delegates activation to subscriptionService so SePay and IAP write to
 * the same `subscriptions` table with the same lifecycle hooks.
 *
 * @param {object} pool      pg pool
 * @param {number} userId    the user who's upgrading themselves
 * @param {object} payload
 *   @param {string} payload.platform                  'apple' | 'google'
 *   @param {string} [payload.productId]               required for Google
 *   @param {string} [payload.purchaseToken]           required for Google
 *   @param {string} [payload.signedTransaction]       Apple v2 JWS
 *   @param {string} [payload.receiptData]             Apple legacy base64
 */
async function verifyAndActivate(pool, userId, payload = {}) {
  const platform = (payload.platform || '').toLowerCase();
  let verification;

  if (isApplePlatform(platform)) {
    verification = await verifyAppleReceipt({
      signedTransaction: payload.signedTransaction,
      receiptData: payload.receiptData,
    });
  } else if (isGooglePlatform(platform)) {
    verification = await verifyGooglePurchase({
      productId: payload.productId,
      purchaseToken: payload.purchaseToken,
    });
  } else {
    return { ok: false, code: 'UNKNOWN_PLATFORM', error: `Unsupported platform: ${platform}` };
  }

  if (!verification.ok) {
    return verification; // pass through the error code from the verifier
  }

  const { productId, transactionId, originalTransactionId, expiresAt } = verification;
  const months = productIdToMonths(productId);
  if (!months) {
    return { ok: false, code: 'UNKNOWN_PRODUCT', error: `Cannot map productId ${productId} to plan months` };
  }

  // Idempotency: only activate the FIRST time we see this transaction id.
  const isNew = await recordReceipt(pool, {
    userId,
    platform: isApplePlatform(platform) ? PLATFORM_APPLE : PLATFORM_GOOGLE,
    productId,
    transactionId,
    originalTransactionId,
    expiresAt,
    rawPayload: payload,
  });

  if (!isNew) {
    logger.info('iap.receipt.duplicate', { user_id: userId, transactionId });
    return { ok: true, alreadyProcessed: true };
  }

  // Reuse the same activation path SePay webhook uses so the rest of the
  // backend (notifications, cache invalidation, premium expiry math) is
  // identical regardless of payment source.
  const result = await subscriptionService.activateFromIap(pool, userId, {
    productId,
    transactionId,
    months,
    expiresAt,
    platform: isApplePlatform(platform) ? PLATFORM_APPLE : PLATFORM_GOOGLE,
  });

  return result;
}

module.exports = {
  verifyAndActivate,
  verifyAppleReceipt, // exported for unit tests
  verifyGooglePurchase, // exported for unit tests
  productIdToMonths,
};
