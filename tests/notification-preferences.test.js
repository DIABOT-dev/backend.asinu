'use strict';

const {
  getPreferences,
  updatePreferences,
} = require('../src/services/notification/smart.schedule.service');

describe('notification preferences', () => {
  test('returns and persists the Health Feed preference independently', async () => {
    const now = new Date();
    const readPool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ inferred_at: now }] })
        .mockResolvedValueOnce({
          rows: [{ reminders_enabled: true, health_feed_enabled: false }],
        }),
    };

    await expect(getPreferences(readPool, 42)).resolves.toMatchObject({
      reminders_enabled: true,
      health_feed_enabled: false,
    });

    const writePool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await updatePreferences(writePool, 42, { health_feed_enabled: false });

    const [query, values] = writePool.query.mock.calls[0];
    expect(query).toContain('health_feed_enabled');
    expect(values[8]).toBe(false);
    expect(values[13]).toBe(true);
  });

  test('keeps Health Feed enabled for users created before the preference existed', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ inferred_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await expect(getPreferences(pool, 7)).resolves.toMatchObject({
      health_feed_enabled: true,
    });
  });
});
