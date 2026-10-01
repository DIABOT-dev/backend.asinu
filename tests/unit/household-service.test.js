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
});
