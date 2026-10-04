'use strict';

// Explicit opt-in: this suite must never run against an application database.
const databaseUrl = process.env.SECURITY_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1', ''].includes(url.hostname) ||
    !/^\/asinu_security_test_[a-z0-9_]+$/.test(url.pathname)
  ) {
    throw new Error('Security tests require a dedicated local asinu_security_test_* database');
  }
}
const describeDatabase = databaseUrl ? describe : describe.skip;
process.env.SEPAY_API_KEY = 'local-payment-test-key';
jest.mock('../src/lib/redis', () => ({
  cacheDel: jest.fn(),
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));
jest.mock('../src/services/notification/basic.notification.service', () => ({
  sendAndSave: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/integrations/crm-event.service', () => ({
  emitCrmEventAsync: jest.fn(),
}));

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const fs = require('fs');
const paymentService = require('../src/services/payment/payment.service');
const subscriptionService = require('../src/services/payment/subscription.service');
const entitlement = require('../src/services/payment/entitlement.service');
const { assertNotRevoked } = require('../src/services/payment/iap-revocation.service');
const { cacheDel } = require('../src/lib/redis');
const { sendAndSave } = require('../src/services/notification/basic.notification.service');

describeDatabase('payment security on PostgreSQL', () => {
  let pool;
  let userId;
  let orderCode;
  let webhookId;
  const future = () => new Date(Date.now() + 86400000).toISOString();
  const req = (overrides = {}) => ({
    headers: { authorization: 'Apikey local-payment-test-key' },
    body: {
      id: webhookId,
      transferType: 'in',
      transferAmount: 10000,
      content: `asinupay${userId}order${orderCode}`,
      ...overrides,
    },
  });

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    userId = (
      await pool.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [
        `security-${randomUUID()}@example.test`,
      ])
    ).rows[0].id;
    orderCode = randomUUID().replace(/-/g, '');
    webhookId = randomUUID();
    await pool.query(
      "INSERT INTO payments (user_id, order_code, amount, qr_url, expires_at) VALUES ($1,$2,10000,'test', NOW() + INTERVAL '5 minutes')",
      [userId, orderCode]
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  test('credit failure rolls back the payment and webhook marker, so a retry credits exactly once', async () => {
    const failedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const db = await pool.connect();
        return {
          release: () => db.release(),
          query: (sql, args) => {
            if (sql.startsWith("UPDATE payments SET status = 'completed'"))
              throw new Error('injected failure after credit');
            return db.query(sql, args);
          },
        };
      },
    };
    await expect(paymentService.handleWebhook(failedPool, req())).rejects.toThrow(
      'injected failure'
    );
    expect(
      (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [userId])).rows[0]
        .wallet_balance
    ).toBe('0.00');
    expect(
      (await pool.query('SELECT status FROM payments WHERE order_code=$1', [orderCode])).rows[0]
        .status
    ).toBe('pending');
    expect(
      (await pool.query('SELECT 1 FROM processed_webhooks WHERE webhook_id=$1', [webhookId]))
        .rowCount
    ).toBe(0);
    expect(sendAndSave).not.toHaveBeenCalled();
    expect(await paymentService.handleWebhook(pool, req())).toMatchObject({
      ok: true,
      message: 'completed',
    });
    expect(await paymentService.handleWebhook(pool, req())).toMatchObject({
      ok: true,
      message: 'duplicate_ignored',
    });
    expect(
      (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [userId])).rows[0]
        .wallet_balance
    ).toBe('10000.00');
    expect(sendAndSave).toHaveBeenCalledTimes(1);
  });

  test('concurrent retries with different webhook IDs cannot credit the same order twice', async () => {
    await Promise.all([
      paymentService.handleWebhook(pool, req()),
      paymentService.handleWebhook(pool, req({ id: randomUUID() })),
    ]);
    expect(
      (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [userId])).rows[0]
        .wallet_balance
    ).toBe('10000.00');
    expect(sendAndSave).toHaveBeenCalledTimes(1);
  });

  test('a forged owner in transfer content cannot credit another account', async () => {
    const otherId = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
    const result = await paymentService.handleWebhook(
      pool,
      req({ content: `asinupay${otherId}order${orderCode}` })
    );
    expect(result).toMatchObject({ ok: false, statusCode: 404 });
    expect(
      (
        await pool.query('SELECT wallet_balance FROM users WHERE id=ANY($1)', [[userId, otherId]])
      ).rows.every((row) => Number(row.wallet_balance) === 0)
    ).toBe(true);
    expect(
      (await pool.query('SELECT status FROM payments WHERE order_code=$1', [orderCode])).rows[0]
        .status
    ).toBe('pending');
  });

  test.each([{ transferType: 'out' }, { transferAmount: -10000 }, { transferAmount: 'NaN' }])(
    'invalid incoming transfer is not credited: %j',
    async (overrides) => {
      await paymentService.handleWebhook(pool, req(overrides));
      expect(
        (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [userId])).rows[0]
          .wallet_balance
      ).toBe('0.00');
    }
  );

  test('a missing idempotency table fails closed and leaves the order pending', async () => {
    const failedPool = {
      connect: async () => {
        const db = await pool.connect();
        return {
          release: () => db.release(),
          query: (sql, args) => {
            if (sql.includes('INSERT INTO processed_webhooks'))
              throw Object.assign(new Error('missing table'), { code: '42P01' });
            return db.query(sql, args);
          },
        };
      },
    };
    await expect(paymentService.handleWebhook(failedPool, req())).rejects.toMatchObject({
      code: '42P01',
    });
    expect(
      (await pool.query('SELECT status FROM payments WHERE order_code=$1', [orderCode])).rows[0]
        .status
    ).toBe('pending');
  });

  test('legacy subscription transfers verify the amount and share webhook transaction boundaries', async () => {
    await pool.query(
      "INSERT INTO subscriptions (user_id, order_code, amount, qr_url) VALUES ($1,$2,149000,'test')",
      [userId, orderCode]
    );
    const content = `asinusub${userId}order${orderCode}`;
    expect(
      await paymentService.handleWebhook(pool, req({ content, transferAmount: 1000 }))
    ).toMatchObject({ ok: false });
    expect(
      (await pool.query('SELECT 1 FROM processed_webhooks WHERE webhook_id=$1', [webhookId]))
        .rowCount
    ).toBe(0);
    expect(
      await paymentService.handleWebhook(pool, req({ content, transferAmount: 149000 }))
    ).toMatchObject({ ok: true });
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('antam_2');
  });

  async function seedPurchase(overrides = {}) {
    const purchase = {
      platform: 'apple',
      transactionId: randomUUID(),
      originalTransactionId: randomUUID(),
      productId: 'asinu.premium.yearly',
      planCode: 'antam_2',
      billingPeriod: 'yearly',
      expiresAt: future(),
      ...overrides,
    };
    await pool.query(
      'INSERT INTO iap_receipts (user_id, platform, product_id, transaction_id, original_transaction_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        userId,
        purchase.platform,
        purchase.productId,
        purchase.transactionId,
        purchase.originalTransactionId,
        purchase.expiresAt,
      ]
    );
    return purchase;
  }

  test('a refunded transaction cannot restore access, but a new purchase in the chain can', async () => {
    const purchase = await seedPurchase();
    expect((await subscriptionService.activateFromIap(pool, userId, purchase)).ok).toBe(true);
    await subscriptionService.applyIapWebhookEvent(pool, { ...purchase, action: 'refund' });
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('free');
    expect(await subscriptionService.activateFromIap(pool, userId, purchase)).toMatchObject({
      ok: false,
      code: 'IAP_PURCHASE_REVOKED',
    });
    const newPurchase = await seedPurchase({
      originalTransactionId: purchase.originalTransactionId,
    });
    expect((await subscriptionService.activateFromIap(pool, userId, newPurchase)).ok).toBe(true);
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('antam_2');
  });

  test('revocations are durable even when the webhook arrives before any receipt', async () => {
    const purchase = {
      platform: 'apple',
      transactionId: randomUUID(),
      originalTransactionId: randomUUID(),
      productId: 'asinu.premium.yearly',
    };
    await subscriptionService.applyIapWebhookEvent(pool, { ...purchase, action: 'revoke' });
    await expect(assertNotRevoked(pool, purchase)).rejects.toMatchObject({
      code: 'IAP_PURCHASE_REVOKED',
    });
  });

  test('a refund retry invalidates stale entitlement caches for the owner and removed members', async () => {
    const purchase = await seedPurchase();
    await subscriptionService.activateFromIap(pool, userId, purchase);
    const memberId = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
    await pool.query(
      "UPDATE subscription_household_members SET status='removed', removed_at=NOW() WHERE user_id=$1 AND status='active'",
      [memberId]
    );
    await pool.query(
      'INSERT INTO subscription_household_members (household_id, user_id, added_by) SELECT id, $2, $1 FROM subscription_households WHERE owner_user_id=$1',
      [userId, memberId]
    );
    cacheDel.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(
      subscriptionService.applyIapWebhookEvent(pool, { ...purchase, action: 'refund' })
    ).rejects.toThrow('cache unavailable');
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('free');
    cacheDel.mockClear();
    expect(
      (await subscriptionService.applyIapWebhookEvent(pool, { ...purchase, action: 'refund' })).ok
    ).toBe(true);
    expect(cacheDel).toHaveBeenCalledWith(`subscription:${userId}`);
    expect(cacheDel).toHaveBeenCalledWith(`subscription:${memberId}`);
  });

  test('refund racing restoration leaves the refunded account free', async () => {
    const purchase = await seedPurchase();
    await subscriptionService.activateFromIap(pool, userId, purchase);
    await Promise.all([
      subscriptionService.applyIapWebhookEvent(pool, { ...purchase, action: 'refund' }),
      subscriptionService.activateFromIap(pool, userId, purchase),
    ]);
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('free');
  });

  test('an old refund does not revoke a newer upgrade', async () => {
    const old = await seedPurchase();
    const upgrade = await seedPurchase({
      originalTransactionId: old.originalTransactionId,
      productId: 'asinu.antam4.yearly',
      planCode: 'antam_4',
    });
    await subscriptionService.activateFromIap(pool, userId, upgrade);
    await subscriptionService.applyIapWebhookEvent(pool, { ...old, action: 'refund' });
    expect((await entitlement.getEntitlement(pool, userId)).planCode).toBe('antam_4');
  });

  test('migration backfills only the last revoked transaction and is safe to rerun', async () => {
    const purchase = await seedPurchase();
    await subscriptionService.activateFromIap(pool, userId, purchase);
    await entitlement.downgradeHouseholdToFree(pool, userId, 'refunded');
    const migration = fs.readFileSync(
      require.resolve('../db/migrations/100_iap_transaction_revocations.sql'),
      'utf8'
    );
    await pool.query(migration);
    await pool.query(migration);
    await expect(assertNotRevoked(pool, purchase)).rejects.toMatchObject({
      code: 'IAP_PURCHASE_REVOKED',
    });
  });
});
