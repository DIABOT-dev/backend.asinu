/**
 * Unit tests for the IAP service. Mocks Apple + Google SDKs and the
 * downstream subscription service so the wiring is exercised in
 * isolation. No DB, no network.
 */

'use strict';

// ─── Mocks ─────────────────────────────────────────────────────────

// Apple SDK — provide a constructor returning the methods we call.
const mockAppleVerifier = {
  verifyAndDecodeNotification: jest.fn(),
  verifyAndDecodeTransaction: jest.fn(),
};

jest.mock('@apple/app-store-server-library', () => {
  return {
    SignedDataVerifier: jest.fn().mockImplementation(() => mockAppleVerifier),
    Environment: { PRODUCTION: 'PRODUCTION', SANDBOX: 'SANDBOX' },
  };
});

// Google SDK — fake an androidpublisher with subscriptionsv2.get.
const mockGooglePublisher = {
  purchases: {
    subscriptionsv2: { get: jest.fn() },
  },
};

jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: jest.fn().mockImplementation(() => ({})) },
    androidpublisher: jest.fn(() => mockGooglePublisher),
  },
}));

// fs.readdirSync / readFileSync — fake Apple cert dir so getAppleVerifier
// doesn't bail with "no_root_certs".
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readdirSync: jest.fn(() => ['AppleRootCA-G3.cer']),
    readFileSync: jest.fn(() => Buffer.from('fake-cert-bytes')),
  };
});

// Downstream activation — assert we call it with the right args.
jest.mock('../../src/services/payment/subscription.service', () => ({
  activateFromIap: jest.fn(),
  applyIapWebhookEvent: jest.fn(),
  getStatus: jest.fn(),
}));

// Silence Sentry capture — module is optional anyway.
jest.mock('../../src/lib/sentry', () => ({
  captureException: jest.fn(),
}));

const iapService = require('../../src/services/payment/iap.service');
const subscriptionService = require('../../src/services/payment/subscription.service');

// ─── Test setup ────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APPLE_BUNDLE_ID = 'com.asinu.lite';
  process.env.APPLE_IAP_ENV = 'sandbox';
  process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.asinu.lite';
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    client_email: 'svc@example.iam.gserviceaccount.com',
    private_key: 'fake',
  });
});

describe('verifyAndActivate', () => {
  test('rejects a signed Apple transaction containing a revocation date', async () => {
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue({
      productId: 'asinu.antam4.yearly',
      transactionId: 'refunded-tx',
      expiresDate: Date.now() + 86400000,
      revocationDate: Date.now(),
      environment: 'Sandbox',
    });
    const pool = { query: jest.fn() };
    const result = await iapService.verifyAndActivate(pool, 2, {
      platform: 'apple',
      signedTransaction: 'signed',
    });
    expect(result).toMatchObject({ ok: false, code: 'IAP_PURCHASE_REVOKED' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(subscriptionService.activateFromIap).not.toHaveBeenCalled();
  });

  test('rejects an older signed receipt after a refund webhook recorded revocation', async () => {
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue({
      productId: 'asinu.antam4.yearly',
      transactionId: 'refunded-tx',
      expiresDate: Date.now() + 86400000,
      environment: 'Sandbox',
    });
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ exists: 1 }] }) };
    const result = await iapService.verifyAndActivate(pool, 2, {
      platform: 'apple',
      signedTransaction: 'old-signed',
    });
    expect(result).toMatchObject({ ok: false, code: 'IAP_PURCHASE_REVOKED' });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(subscriptionService.activateFromIap).not.toHaveBeenCalled();
  });

  test('does not record or activate an expired Apple subscription', async () => {
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue({
      productId: 'asinu.antam4.yearly',
      transactionId: 'expired-test-transaction',
      expiresDate: new Date('2020-01-01T00:00:00Z').getTime(),
      environment: 'Sandbox',
    });
    const pool = { query: jest.fn() };

    const result = await iapService.verifyAndActivate(pool, 2, {
      platform: 'apple',
      productId: 'asinu.antam4.yearly',
      signedTransaction: 'signed-test-transaction',
    });

    expect(result).toMatchObject({ ok: false, code: 'IAP_SUBSCRIPTION_EXPIRED' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(subscriptionService.activateFromIap).not.toHaveBeenCalled();
  });
});

describe('assertIapRuntimeConfig', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowSandbox = process.env.IAP_ALLOW_SANDBOX;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowSandbox === undefined) delete process.env.IAP_ALLOW_SANDBOX;
    else process.env.IAP_ALLOW_SANDBOX = originalAllowSandbox;
  });

  test('rejects sandbox verification on the production backend by default', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_APP_APPLE_ID = '6758967197';
    process.env.APPLE_IAP_ENV = 'sandbox';
    delete process.env.IAP_ALLOW_SANDBOX;

    expect(() => iapService.assertIapRuntimeConfig()).toThrow('APPLE_IAP_ENV=production');
  });

  test('allows sandbox only when an isolated staging backend opts in', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_APP_APPLE_ID = '6758967197';
    process.env.APPLE_IAP_ENV = 'sandbox';
    process.env.IAP_ALLOW_SANDBOX = 'true';

    expect(() => iapService.assertIapRuntimeConfig()).not.toThrow();
  });
});

// ─── handleAppleNotification ───────────────────────────────────────

describe('handleAppleNotification', () => {
  const { handleAppleNotification } = iapService;
  const pool = {}; // not touched — subscriptionService is mocked

  function buildNotification(type, subtype = null) {
    return {
      notificationType: type,
      subtype,
      data: { signedTransactionInfo: 'fake.jws.string' },
    };
  }

  function buildTx(overrides = {}) {
    return {
      transactionId: 12345,
      originalTransactionId: 99999,
      productId: 'asinu.premium.monthly',
      expiresDate: new Date('2030-01-01').getTime(),
      ...overrides,
    };
  }

  test('rejects empty payload', async () => {
    const r = await handleAppleNotification(pool, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PAYLOAD');
  });

  test('a renewal carrying a revoked signed transaction is treated as revocation', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(buildNotification('DID_RENEW'));
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue(
      buildTx({ revocationDate: Date.now() })
    );
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true });
    await handleAppleNotification(pool, { signedPayload: 'signed' });
    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'revoke' })
    );
  });

  test('returns APPLE_NOTIF_VERIFY_FAILED when JWS signature invalid', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockRejectedValue(new Error('Bad signature'));
    const r = await handleAppleNotification(pool, { signedPayload: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('APPLE_NOTIF_VERIFY_FAILED');
  });

  test('DID_RENEW → applyIapWebhookEvent with action="renew"', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(buildNotification('DID_RENEW'));
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue(buildTx());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true, userId: 7 });

    const r = await handleAppleNotification(pool, { signedPayload: 'jws' });

    expect(r.ok).toBe(true);
    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        platform: 'apple',
        action: 'renew',
        productId: 'asinu.premium.monthly',
        transactionId: '12345',
        originalTransactionId: '99999',
      })
    );
  });

  test('REFUND → action="refund"', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(buildNotification('REFUND'));
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue(buildTx());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true });

    await handleAppleNotification(pool, { signedPayload: 'jws' });

    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'refund' })
    );
  });

  test('EXPIRED → action="expire"', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(buildNotification('EXPIRED'));
    mockAppleVerifier.verifyAndDecodeTransaction.mockResolvedValue(buildTx());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true });

    await handleAppleNotification(pool, { signedPayload: 'jws' });

    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'expire' })
    );
  });

  test('DID_FAIL_TO_RENEW → ignored (grace period)', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(
      buildNotification('DID_FAIL_TO_RENEW')
    );
    const r = await handleAppleNotification(pool, { signedPayload: 'jws' });

    expect(r.ok).toBe(true);
    expect(r.ignored).toBe(true);
    expect(subscriptionService.applyIapWebhookEvent).not.toHaveBeenCalled();
  });

  test('unknown notificationType → ignored, NOT propagated as error', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue(
      buildNotification('CONSUMPTION_REQUEST_2099')
    );
    const r = await handleAppleNotification(pool, { signedPayload: 'jws' });

    expect(r.ok).toBe(true);
    expect(r.ignored).toBe(true);
  });

  test('notification without signedTransactionInfo is ack-and-ignore', async () => {
    mockAppleVerifier.verifyAndDecodeNotification.mockResolvedValue({
      notificationType: 'CONSUMPTION_REQUEST',
      data: {},
    });

    const r = await handleAppleNotification(pool, { signedPayload: 'jws' });
    expect(r.ok).toBe(true);
    expect(r.ignored).toBe(true);
  });
});

// ─── handleGoogleNotification ──────────────────────────────────────

describe('handleGoogleNotification', () => {
  const { handleGoogleNotification } = iapService;
  const pool = {};

  function buildEnvelope(notificationType, purchaseToken = 'tok-1') {
    const payload = {
      packageName: 'com.asinu.lite',
      eventTimeMillis: '0',
      subscriptionNotification: {
        version: '1.0',
        notificationType,
        purchaseToken,
        subscriptionId: 'asinu.antam2.monthly',
      },
    };
    return {
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
        messageId: 'm-1',
      },
    };
  }

  function googleApiResponse(overrides = {}) {
    return {
      data: {
        latestOrderId: 'GPA.1234-5678-9012-34567..0',
        lineItems: [{ productId: 'asinu.antam2.monthly', expiryTime: '2030-01-01T00:00:00Z' }],
        ...overrides,
      },
    };
  }

  test('rejects empty body', async () => {
    const r = await handleGoogleNotification(pool, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PAYLOAD');
  });

  test('non-subscription notification is ack-and-ignore (test notif, etc.)', async () => {
    const envelope = {
      message: {
        data: Buffer.from(
          JSON.stringify({ packageName: 'com.asinu.lite', testNotification: { version: '1.0' } })
        ).toString('base64'),
      },
    };
    const r = await handleGoogleNotification(pool, envelope);
    expect(r.ok).toBe(true);
    expect(r.ignored).toBe(true);
  });

  test('SUBSCRIPTION_RENEWED (2) → calls Google API, action="renew"', async () => {
    mockGooglePublisher.purchases.subscriptionsv2.get.mockResolvedValue(googleApiResponse());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true, userId: 9 });

    const r = await handleGoogleNotification(pool, buildEnvelope(2));

    expect(r.ok).toBe(true);
    expect(mockGooglePublisher.purchases.subscriptionsv2.get).toHaveBeenCalledWith({
      packageName: 'com.asinu.lite',
      token: 'tok-1',
    });
    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        platform: 'google',
        action: 'renew',
        productId: 'asinu.antam2.monthly',
        expiresAt: new Date('2030-01-01T00:00:00Z').toISOString(),
      })
    );
  });

  test('SUBSCRIPTION_REVOKED (12) → action="revoke"', async () => {
    mockGooglePublisher.purchases.subscriptionsv2.get.mockResolvedValue(googleApiResponse());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true });

    await handleGoogleNotification(pool, buildEnvelope(12));

    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'revoke' })
    );
  });

  test('SUBSCRIPTION_EXPIRED (13) → action="expire"', async () => {
    mockGooglePublisher.purchases.subscriptionsv2.get.mockResolvedValue(googleApiResponse());
    subscriptionService.applyIapWebhookEvent.mockResolvedValue({ ok: true });

    await handleGoogleNotification(pool, buildEnvelope(13));

    expect(subscriptionService.applyIapWebhookEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'expire' })
    );
  });

  test('SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8) → ignored', async () => {
    const r = await handleGoogleNotification(pool, buildEnvelope(8));
    expect(r.ok).toBe(true);
    expect(r.ignored).toBe(true);
    expect(mockGooglePublisher.purchases.subscriptionsv2.get).not.toHaveBeenCalled();
  });

  test('Google API failure → GOOGLE_GET_FAILED, not propagated as success', async () => {
    mockGooglePublisher.purchases.subscriptionsv2.get.mockRejectedValue(
      new Error('API quota exceeded')
    );
    const r = await handleGoogleNotification(pool, buildEnvelope(2));

    expect(r.ok).toBe(false);
    expect(r.code).toBe('GOOGLE_GET_FAILED');
    expect(subscriptionService.applyIapWebhookEvent).not.toHaveBeenCalled();
  });

  test('Google response without lineItems → GOOGLE_NO_LINE_ITEM', async () => {
    mockGooglePublisher.purchases.subscriptionsv2.get.mockResolvedValue(
      googleApiResponse({ lineItems: [] })
    );
    const r = await handleGoogleNotification(pool, buildEnvelope(2));

    expect(r.ok).toBe(false);
    expect(r.code).toBe('GOOGLE_NO_LINE_ITEM');
  });

  test('malformed base64 data → GOOGLE_BAD_PAYLOAD', async () => {
    const r = await handleGoogleNotification(pool, {
      message: { data: 'not-base64!!!' },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GOOGLE_BAD_PAYLOAD');
  });
});
