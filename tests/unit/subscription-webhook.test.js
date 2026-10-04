'use strict';

jest.mock('../../src/services/payment/entitlement.service', () => ({
  householdOwnedBy: jest.fn(),
  downgradeHouseholdToFree: jest.fn(),
  invalidateHouseholdEntitlements: jest.fn(),
}));

const entitlementService = require('../../src/services/payment/entitlement.service');
const subscriptionService = require('../../src/services/payment/subscription.service');

describe('out-of-order subscription notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  test('old An Tam 2 refund cannot revoke a newer An Tam 4 entitlement', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: 7 }] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    entitlementService.householdOwnedBy.mockResolvedValue({
      plan_code: 'antam_4',
      product_id: 'asinu.antam4.yearly',
      original_transaction_id: 'same-chain',
      current_period_end: '2030-10-01T00:00:00.000Z',
    });

    const result = await subscriptionService.applyIapWebhookEvent(pool, {
      action: 'refund',
      platform: 'apple',
      productId: 'asinu.premium.yearly',
      transactionId: 'old-tx',
      originalTransactionId: 'same-chain',
      expiresAt: '2030-09-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({ ok: true, ignored: true });
    expect(entitlementService.downgradeHouseholdToFree).not.toHaveBeenCalled();
  });
});
