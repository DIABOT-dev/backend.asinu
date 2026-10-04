'use strict';

jest.mock('../../src/lib/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}));
jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn(),
}));

const { cacheGet, cacheSet } = require('../../src/lib/redis');
const entitlementService = require('../../src/services/payment/entitlement.service');
const { getStatus } = require('../../src/services/payment/subscription.service');

describe('subscription status cache', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not return an expired cached paid entitlement', async () => {
    cacheGet.mockResolvedValue({
      isAnTam: true,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    entitlementService.getEntitlement.mockResolvedValue({ isAnTam: false, expiresAt: null });

    const status = await getStatus({}, 7);

    expect(status.isAnTam).toBe(false);
    expect(entitlementService.getEntitlement).toHaveBeenCalledWith({}, 7);
  });

  test('caps paid cache lifetime at the Store period end', async () => {
    cacheGet.mockResolvedValue(null);
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    entitlementService.getEntitlement.mockResolvedValue({ isAnTam: true, expiresAt });

    await getStatus({}, 8);

    const ttl = cacheSet.mock.calls[0][2];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });
});
