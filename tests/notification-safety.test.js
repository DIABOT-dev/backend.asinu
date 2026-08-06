const { canSendNonUrgent, hasReachedDailyCap } = require('../src/services/notification/notification.policy');
const { runBasicNotifications } = require('../src/services/notification/basic.notification.service');
const { requireCronSecret } = require('../src/middleware/cron-auth');

describe('notification safety controls', () => {
  test('fails closed for a user without reminder opt-in', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ reminders_enabled: false }] }) };

    await expect(canSendNonUrgent(pool, 1, 'reminder_glucose')).resolves.toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('allows opted-in reminders below the daily cap', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ reminders_enabled: true }] })
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }),
    };

    await expect(canSendNonUrgent(pool, 1, 'reminder_glucose')).resolves.toBe(true);
  });

  test('blocks reminders at the daily cap', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: 3 }] }) };

    await expect(hasReachedDailyCap(pool, 1)).resolves.toBe(true);
  });

  test('rejects NaN scheduler overrides before any database query', async () => {
    await expect(runBasicNotifications({}, NaN, 0)).rejects.toThrow('Invalid hour');
  });

  test('rejects an invalid cron secret', () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    requireCronSecret({ get: () => 'wrong-secret' }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Unauthorized' });
    process.env.CRON_SECRET = previous;
  });
});
