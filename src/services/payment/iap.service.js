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
 * Production setup required:
 *   - Apple Root CA(s) in $APPLE_ROOT_CA_DIR (.cer files). Download from
 *     https://www.apple.com/certificateauthority/ — at minimum
 *     AppleRootCA-G3.cer (used by StoreKit 2 signed transactions).
 *   - Env vars:
 *       APPLE_BUNDLE_ID              e.g. com.asinu.lite
 *       APPLE_APP_APPLE_ID           numeric App Store ID (for online check)
 *       APPLE_IAP_ENV                'sandbox' | 'production'
 *       GOOGLE_PLAY_PACKAGE_NAME     e.g. com.asinu.lite
 *       GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  JSON string (or path) of svc-acct creds
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../lib/logger');
const { captureException } = require('../../lib/sentry');
const subscriptionService = require('./subscription.service');

/**
 * Wrap an IAP failure with Sentry tags so platform / product errors
 * are easy to slice in the dashboard. No-ops when Sentry isn't enabled.
 */
function captureIapFailure(err, ctx) {
  try {
    const error = err instanceof Error ? err : new Error(String(err?.message || err));
    captureException(error, {
      tags: {
        component: 'iap',
        platform: ctx?.platform || 'unknown',
        code: ctx?.code || 'UNKNOWN',
        productId: ctx?.productId,
        notificationType: ctx?.notificationType,
      },
      extra: ctx,
    });
  } catch {
    // never let observability break the response path
  }
}

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

function productIdToMonths(productId) {
  const id = String(productId || '').toLowerCase();
  if (id.endsWith('.monthly') || id.endsWith('.month') || id.endsWith('.1m')) return 1;
  if (id.endsWith('.quarterly') || id.endsWith('.3m')) return 3;
  if (id.endsWith('.semiannual') || id.endsWith('.6m')) return 6;
  if (id.endsWith('.yearly') || id.endsWith('.annual') || id.endsWith('.year') || id.endsWith('.12m')) return 12;
  return null;
}

// ─── Apple verifier ────────────────────────────────────────────────

let _appleVerifierCache = null;

function getAppleVerifier() {
  if (_appleVerifierCache) return _appleVerifierCache;

  const bundleId = process.env.APPLE_BUNDLE_ID;
  if (!bundleId) return null;

  // Lazy-require so the rest of the app still loads when the dep is
  // missing (e.g. local dev without IAP).
  let lib;
  try {
    lib = require('@apple/app-store-server-library');
  } catch (e) {
    logger.warn('iap.apple.lib_missing — npm i @apple/app-store-server-library');
    return null;
  }
  const { SignedDataVerifier, Environment } = lib;

  // Load Apple Root certificates from disk. Download them from
  // https://www.apple.com/certificateauthority/ and drop the .cer files
  // into the configured directory.
  const certDir = process.env.APPLE_ROOT_CA_DIR
    || path.resolve(__dirname, '../../../certs/apple');

  let rootCerts;
  try {
    const files = fs.readdirSync(certDir).filter(f => f.endsWith('.cer'));
    if (files.length === 0) {
      logger.warn(`iap.apple.no_root_certs — drop AppleRootCA-G3.cer into ${certDir}`);
      return null;
    }
    rootCerts = files.map(f => fs.readFileSync(path.join(certDir, f)));
  } catch (e) {
    logger.warn(`iap.apple.cert_dir_missing — ${certDir}: ${e.message}`);
    return null;
  }

  const envName = (process.env.APPLE_IAP_ENV || 'sandbox').toLowerCase();
  const environment = envName === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
  const appAppleId = process.env.APPLE_APP_APPLE_ID
    ? Number(process.env.APPLE_APP_APPLE_ID)
    : undefined;
  // enableOnlineChecks=true makes the lib hit Apple's CRL / OCSP — safer
  // but adds ~300ms latency. Keep on in production, off in sandbox.
  const enableOnlineChecks = environment === Environment.PRODUCTION;

  _appleVerifierCache = new SignedDataVerifier(
    rootCerts,
    enableOnlineChecks,
    environment,
    bundleId,
    appAppleId
  );
  return _appleVerifierCache;
}

/**
 * Verify an Apple App Store signed transaction (StoreKit 2 JWS).
 *
 * Inputs (one of):
 *   - signedTransaction: a JWS string (App Store Server API v2 era)
 *
 * Returns:
 *   { ok: true, productId, transactionId, originalTransactionId,
 *     expiresAt, environment }
 *   { ok: false, code, error }
 */
async function verifyAppleReceipt({ signedTransaction } = {}) {
  if (!signedTransaction) {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Missing Apple signedTransaction' };
  }

  const verifier = getAppleVerifier();
  if (!verifier) {
    return {
      ok: false,
      code: 'APPLE_VERIFIER_NOT_CONFIGURED',
      error: 'Apple verifier missing — set APPLE_BUNDLE_ID + drop AppleRootCA-G3.cer into certs/apple/.',
    };
  }

  try {
    const decoded = await verifier.verifyAndDecodeTransaction(signedTransaction);
    if (!decoded || !decoded.productId || !decoded.transactionId) {
      return { ok: false, code: 'APPLE_INVALID_TRANSACTION', error: 'Decoded transaction missing required fields' };
    }
    return {
      ok: true,
      productId: decoded.productId,
      transactionId: String(decoded.transactionId),
      originalTransactionId: decoded.originalTransactionId
        ? String(decoded.originalTransactionId)
        : null,
      // Apple gives expiresDate in ms since epoch; null when product is not a subscription.
      expiresAt: decoded.expiresDate ? new Date(decoded.expiresDate).toISOString() : null,
      environment: decoded.environment,
    };
  } catch (err) {
    logger.warn('iap.apple_verify.failed', { message: err.message });
    captureIapFailure(err, { platform: 'apple', code: 'APPLE_VERIFY_FAILED' });
    return { ok: false, code: 'APPLE_VERIFY_FAILED', error: err.message };
  }
}

// ─── Google verifier ────────────────────────────────────────────────

let _googleClientCache = null;

async function getGoogleAndroidpublisher() {
  if (_googleClientCache) return _googleClientCache;

  const credentialsRaw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!credentialsRaw) return null;

  let lib;
  try {
    lib = require('googleapis');
  } catch (e) {
    logger.warn('iap.google.lib_missing — npm i googleapis');
    return null;
  }
  const { google } = lib;

  // The env var can be either inline JSON or a path to a JSON file.
  let credentials;
  try {
    if (credentialsRaw.trim().startsWith('{')) {
      credentials = JSON.parse(credentialsRaw);
    } else {
      credentials = JSON.parse(fs.readFileSync(credentialsRaw, 'utf8'));
    }
  } catch (e) {
    logger.warn('iap.google.bad_credentials', { message: e.message });
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  _googleClientCache = google.androidpublisher({ version: 'v3', auth });
  return _googleClientCache;
}

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

  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!packageName) {
    return {
      ok: false,
      code: 'GOOGLE_VERIFIER_NOT_CONFIGURED',
      error: 'Google verifier missing GOOGLE_PLAY_PACKAGE_NAME',
    };
  }

  const publisher = await getGoogleAndroidpublisher();
  if (!publisher) {
    return {
      ok: false,
      code: 'GOOGLE_VERIFIER_NOT_CONFIGURED',
      error: 'Google verifier missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    };
  }

  try {
    // subscriptionsv2 is the modern endpoint and matches Play Billing v6+.
    // It returns lineItems with the productId + expiry. The classic
    // `purchases.subscriptions.get` still works but is one-product-only
    // and deprecated for new code.
    const { data } = await publisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    if (!data) {
      return { ok: false, code: 'GOOGLE_EMPTY_RESPONSE', error: 'Google returned empty body' };
    }

    // subscriptionState: SUBSCRIPTION_STATE_ACTIVE, IN_GRACE_PERIOD, etc.
    const state = data.subscriptionState;
    const goodStates = new Set([
      'SUBSCRIPTION_STATE_ACTIVE',
      'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      'SUBSCRIPTION_STATE_ON_HOLD', // user is in hold; some apps want to deny — we deny.
    ]);
    if (!state || !['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(state)) {
      return {
        ok: false,
        code: 'GOOGLE_INACTIVE',
        error: `Subscription not active (state=${state || 'unknown'})`,
      };
    }

    // lineItems[0] is the SKU; assume single-SKU purchases (no add-ons).
    const item = (data.lineItems || [])[0];
    if (!item || !item.productId) {
      return { ok: false, code: 'GOOGLE_NO_LINE_ITEM', error: 'Subscription has no line items' };
    }
    if (item.productId !== productId) {
      return {
        ok: false,
        code: 'GOOGLE_PRODUCT_MISMATCH',
        error: `Token product ${item.productId} != requested ${productId}`,
      };
    }

    return {
      ok: true,
      productId: item.productId,
      // latestOrderId is the globally-unique transaction id; use it for
      // idempotency. Falls back to a synthesized id if missing.
      transactionId: data.latestOrderId || `gp:${purchaseToken.slice(0, 32)}`,
      originalTransactionId: data.latestOrderId
        ? data.latestOrderId.split('..')[0] // Play order ids: GPA....1234..1
        : null,
      expiresAt: item.expiryTime ? new Date(item.expiryTime).toISOString() : null,
      environment: data.testPurchase ? 'sandbox' : 'production',
    };
  } catch (err) {
    logger.warn('iap.google_verify.failed', { message: err.message, code: err.code });
    captureIapFailure(err, { platform: 'google', code: 'GOOGLE_VERIFY_FAILED', productId });
    return { ok: false, code: 'GOOGLE_VERIFY_FAILED', error: err.message };
  }
}

// ─── Idempotency: store the receipt before activating ─────────────

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
    if (err.code === '42P01') {
      logger.warn('iap.receipts_table_missing — migration 072_iap_receipts.sql chưa chạy');
      return true; // fail-open so we don't double-charge while migration is pending
    }
    throw err;
  }
}

// ─── Public entry point ────────────────────────────────────────────

async function verifyAndActivate(pool, userId, payload = {}) {
  const platform = (payload.platform || '').toLowerCase();
  let verification;

  if (isApplePlatform(platform)) {
    verification = await verifyAppleReceipt({
      signedTransaction: payload.signedTransaction || payload.receiptData,
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
    return verification;
  }

  const { productId, transactionId, originalTransactionId, expiresAt } = verification;
  const months = productIdToMonths(productId);
  if (!months) {
    return { ok: false, code: 'UNKNOWN_PRODUCT', error: `Cannot map productId ${productId} to plan months` };
  }

  const isNew = await recordReceipt(pool, {
    userId,
    platform: isApplePlatform(platform) ? PLATFORM_APPLE : PLATFORM_GOOGLE,
    productId,
    transactionId,
    originalTransactionId,
    expiresAt,
    rawPayload: { ...payload, environment: verification.environment },
  });

  if (!isNew) {
    logger.info('iap.receipt.duplicate', { user_id: userId, transactionId });
    return { ok: true, alreadyProcessed: true, planMonths: months, expiresAt, platform };
  }

  const result = await subscriptionService.activateFromIap(pool, userId, {
    productId,
    transactionId,
    months,
    expiresAt,
    platform: isApplePlatform(platform) ? PLATFORM_APPLE : PLATFORM_GOOGLE,
  });

  return result;
}

// ─── Apple Server Notifications v2 ─────────────────────────────────

/**
 * Verify + decode an Apple Server Notification v2 envelope and apply the
 * state change to our DB. Apple POSTs a signed JWS body with field
 * `signedPayload` to the URL configured in App Store Connect.
 *
 * notificationType reference:
 *   https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 *
 * @param {object} pool
 * @param {object} envelope  { signedPayload: string }
 */
async function handleAppleNotification(pool, envelope) {
  if (!envelope || !envelope.signedPayload) {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Missing signedPayload' };
  }

  const verifier = getAppleVerifier();
  if (!verifier) {
    return { ok: false, code: 'APPLE_VERIFIER_NOT_CONFIGURED', error: 'Apple verifier not configured' };
  }

  let decodedNotification;
  try {
    decodedNotification = await verifier.verifyAndDecodeNotification(envelope.signedPayload);
  } catch (err) {
    logger.warn('iap.apple_notif.verify_failed', { message: err.message });
    captureIapFailure(err, { platform: 'apple', code: 'APPLE_NOTIF_VERIFY_FAILED' });
    return { ok: false, code: 'APPLE_NOTIF_VERIFY_FAILED', error: err.message };
  }

  const notificationType = decodedNotification.notificationType;
  const subtype = decodedNotification.subtype;
  const data = decodedNotification.data;
  if (!data || !data.signedTransactionInfo) {
    // CONSUMPTION_REQUEST and a few other types have no signed tx. Ack.
    return { ok: true, ignored: true, reason: 'no signedTransactionInfo' };
  }

  let tx;
  try {
    tx = await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
  } catch (err) {
    captureIapFailure(err, {
      platform: 'apple',
      code: 'APPLE_TX_VERIFY_FAILED',
      notificationType: decodedNotification.notificationType,
    });
    return { ok: false, code: 'APPLE_TX_VERIFY_FAILED', error: err.message };
  }

  // Map Apple notification type → our action enum.
  let action = null;
  if (
    notificationType === 'DID_RENEW' ||
    notificationType === 'SUBSCRIBED' ||
    notificationType === 'OFFER_REDEEMED' ||
    notificationType === 'DID_CHANGE_RENEWAL_PREF'
  ) {
    action = 'renew';
  } else if (notificationType === 'EXPIRED') {
    action = 'expire';
  } else if (notificationType === 'REFUND' || notificationType === 'REVOKE') {
    action = 'revoke';
  } else if (notificationType === 'DID_FAIL_TO_RENEW') {
    // Grace period — leave expiry alone; user is still premium until it ends.
    return { ok: true, ignored: true, reason: 'grace period' };
  } else {
    return { ok: true, ignored: true, reason: `unhandled type ${notificationType}` };
  }

  return await subscriptionService.applyIapWebhookEvent(pool, {
    platform: 'apple',
    transactionId: tx.transactionId ? String(tx.transactionId) : null,
    originalTransactionId: tx.originalTransactionId ? String(tx.originalTransactionId) : null,
    productId: tx.productId,
    expiresAt: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
    action,
    rawPayload: { notificationType, subtype, environment: decodedNotification.signedDate ? 'sandbox-or-prod' : undefined },
  });
}

// ─── Google Real-Time Developer Notifications (Pub/Sub) ────────────

/**
 * Handle a Pub/Sub push message from Google Play. The envelope looks
 * like:
 *   { message: { data: <base64>, messageId, publishTime, ... }, subscription }
 * data decodes to JSON:
 *   { version, packageName, eventTimeMillis, subscriptionNotification: {...} }
 *
 * notificationType reference:
 *   https://developer.android.com/google/play/billing/rtdn-reference#sub
 */
async function handleGoogleNotification(pool, body) {
  const message = body && body.message;
  if (!message || !message.data) {
    return { ok: false, code: 'INVALID_PAYLOAD', error: 'Missing message.data' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch (err) {
    return { ok: false, code: 'GOOGLE_BAD_PAYLOAD', error: 'Could not decode pub/sub data' };
  }

  const sub = payload.subscriptionNotification;
  if (!sub) {
    // testNotification or other types — ack.
    return { ok: true, ignored: true, reason: 'no subscriptionNotification' };
  }

  // notificationType: see RTDN reference.
  //   1 SUBSCRIPTION_RECOVERED      → renew
  //   2 SUBSCRIPTION_RENEWED        → renew
  //   3 SUBSCRIPTION_CANCELED       → keep (active until expiry)
  //   4 SUBSCRIPTION_PURCHASED      → renew (initial)
  //   5 SUBSCRIPTION_ON_HOLD        → expire
  //   6 SUBSCRIPTION_IN_GRACE_PERIOD → no-op
  //   7 SUBSCRIPTION_RESTARTED      → renew
  //   8 SUBSCRIPTION_PRICE_CHANGE_CONFIRMED → no-op
  //   9 SUBSCRIPTION_DEFERRED       → renew (with new expiry)
  //  10 SUBSCRIPTION_PAUSED         → expire (treat as paused)
  //  11 SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED → no-op
  //  12 SUBSCRIPTION_REVOKED        → revoke
  //  13 SUBSCRIPTION_EXPIRED        → expire
  const type = sub.notificationType;
  let action = null;
  if ([1, 2, 4, 7, 9].includes(type)) action = 'renew';
  else if ([12].includes(type)) action = 'revoke';
  else if ([5, 10, 13].includes(type)) action = 'expire';
  else return { ok: true, ignored: true, reason: `unhandled type ${type}` };

  // Hit Play API to get current state + expiry (the notification itself
  // doesn't include the new expiry — we have to look it up).
  const publisher = await getGoogleAndroidpublisher();
  if (!publisher) {
    return { ok: false, code: 'GOOGLE_VERIFIER_NOT_CONFIGURED', error: 'Google verifier missing creds' };
  }

  let info;
  try {
    const { data } = await publisher.purchases.subscriptionsv2.get({
      packageName: payload.packageName,
      token: sub.purchaseToken,
    });
    info = data;
  } catch (err) {
    captureIapFailure(err, {
      platform: 'google',
      code: 'GOOGLE_GET_FAILED',
      notificationType: sub.notificationType,
    });
    return { ok: false, code: 'GOOGLE_GET_FAILED', error: err.message };
  }

  const item = (info?.lineItems || [])[0];
  if (!item) return { ok: false, code: 'GOOGLE_NO_LINE_ITEM', error: 'No line items' };

  return await subscriptionService.applyIapWebhookEvent(pool, {
    platform: 'google',
    transactionId: info.latestOrderId || `gp:${sub.purchaseToken.slice(0, 32)}`,
    originalTransactionId: info.latestOrderId
      ? info.latestOrderId.split('..')[0]
      : `gp:${sub.purchaseToken.slice(0, 32)}`,
    productId: item.productId,
    expiresAt: item.expiryTime ? new Date(item.expiryTime).toISOString() : null,
    action,
    rawPayload: { notificationType: type, packageName: payload.packageName },
  });
}

module.exports = {
  verifyAndActivate,
  verifyAppleReceipt,
  verifyGooglePurchase,
  productIdToMonths,
  handleAppleNotification,
  handleGoogleNotification,
};
