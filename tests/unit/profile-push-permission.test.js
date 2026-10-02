process.env.JWT_SECRET ||= 'profile-push-permission-test-secret';

const profileService = require('../../src/services/profile/profile.service');

describe('push token permission revocation', () => {
  test('clears regular push tokens without clearing the independent VoIP token', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
    };

    await expect(
      profileService.updatePushToken(pool, 42, null, null, null, null, false, true)
    ).resolves.toEqual({ ok: true });

    const queries = pool.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
    expect(queries).toContain('UPDATE users SET push_token = NULL, fcm_token = NULL WHERE id = $1');
    expect(
      queries.some((sql) =>
        sql.startsWith(
          'UPDATE users SET voip_push_token = NULL, voip_push_environment = NULL WHERE id = $1'
        )
      )
    ).toBe(false);
  });
});
