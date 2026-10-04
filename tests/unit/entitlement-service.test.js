'use strict';

const entitlementService = require('../../src/services/payment/entitlement.service');

describe('ensureHousehold connection ownership', () => {
  function checkedOutClient() {
    const query = jest.fn(async (sql) => {
      if (sql.includes('INSERT INTO subscription_households')) {
        return { rows: [{ id: 42, owner_user_id: 7 }] };
      }
      if (sql.includes('UPDATE subscription_households')) {
        return { rows: [{ id: 42, owner_user_id: 7, plan_code: 'antam_4' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    return {
      connect: jest.fn(async () => {
        throw new Error('Client has already been connected. You cannot reuse a client.');
      }),
      query,
      release: jest.fn(),
    };
  }

  test('uses a checked-out client without reconnecting or ending its transaction', async () => {
    const client = checkedOutClient();

    const household = await entitlementService.activateHouseholdPlan(client, 7, {
      planCode: 'antam_4',
      billingPeriod: 'yearly',
      platform: 'apple',
      productId: 'asinu.antam4.yearly',
      originalTransactionId: 'test-original-transaction',
      startsAt: new Date('2026-10-03T16:00:00Z'),
      expiresAt: new Date('2026-10-03T17:00:00Z'),
    });

    expect(household.plan_code).toBe('antam_4');
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain('BEGIN');
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });

  test('acquires and releases its own client when passed a pool', async () => {
    const client = checkedOutClient();
    const pool = { connect: jest.fn(async () => client) };

    const household = await entitlementService.ensureHousehold(pool, 7);

    expect(household.id).toBe(42);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('BEGIN');
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('protected-member benefits', () => {
  const household = {
    id: 42,
    owner_user_id: 7,
    plan_code: 'antam_4',
    status: 'active',
    billing_period: 'yearly',
    current_period_end: '2030-01-01T00:00:00.000Z',
    protected_member_count: 4,
  };

  test('paying owner can manage the plan but is not called when not in a protected slot', () => {
    expect(entitlementService._test.toEntitlement({ ...household, is_protected_member: false }, 7))
      .toMatchObject({
        isAnTam: true,
        isOwner: true,
        isProtectedMember: false,
        protectedMemberCount: 4,
        callCenterEnabled: false,
        automaticEarlySignals: false,
      });
  });

  test('protected household member receives call and automatic signal benefits', () => {
    expect(entitlementService._test.toEntitlement({ ...household, is_protected_member: true }, 8))
      .toMatchObject({
        isAnTam: true,
        isOwner: false,
        isProtectedMember: true,
        callCenterEnabled: true,
        automaticEarlySignals: true,
      });
  });
});
