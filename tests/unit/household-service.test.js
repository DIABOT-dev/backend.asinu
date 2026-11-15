'use strict';

const entitlementService = require('../../src/services/payment/entitlement.service');
const householdService = require('../../src/services/payment/household.service');

describe('subscription household service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads member names using the current users.phone_number column', async () => {
    jest.spyOn(entitlementService, 'householdOwnedBy').mockResolvedValue({
      id: 14,
      plan_code: 'free',
      status: 'active',
      current_period_end: null,
    });
    const pool = {
      query: jest.fn(async (sql, params) => {
        expect(sql).toContain('u.phone_number');
        expect(sql).not.toContain('u.phone,');
        expect(params).toEqual([14, 7]);
        return {
          rowCount: 1,
          rows: [
            {
              user_id: 7,
              added_at: new Date('2026-10-01T00:00:00.000Z'),
              name: '0901234567',
              avatar_url: null,
            },
          ],
        };
      }),
    };

    const result = await householdService.listProtectedMembers(pool, 7);

    expect(result).toMatchObject({
      householdId: 14,
      ownerUserId: 7,
      planCode: 'free',
      protectedMemberCount: 1,
      members: [{ userId: 7, name: '0901234567', avatarUrl: null }],
    });
  });
  test('member mutations inside a caller transaction never commit or release the caller client', async () => {
    jest.spyOn(entitlementService, 'householdOwnedBy').mockResolvedValue({ id: 14, plan_code: 'antam_2', status: 'active', current_period_end: new Date(Date.now() + 86400000) });
    jest.spyOn(entitlementService, 'householdProtecting').mockResolvedValue(null);
    jest.spyOn(entitlementService, 'ensureHousehold').mockResolvedValue({ id: 15 });
    jest.spyOn(entitlementService, 'invalidateEntitlement').mockResolvedValue();
    const client = { release: jest.fn(), query: jest.fn(async sql => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) throw Error('Do not end the caller transaction');
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 1 }], rowCount: 1 };
      if (sql.includes('SELECT m.household_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('u.phone_number')) return { rows: [{ user_id: 8, name: 'Người thử' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) };
    expect((await householdService.addProtectedMember(client, 7, 8)).members[0].userId).toBe(8);
    expect((await householdService.removeProtectedMember(client, 7, 8)).members[0].userId).toBe(8);
    expect(client.release).not.toHaveBeenCalled();
  });
});
