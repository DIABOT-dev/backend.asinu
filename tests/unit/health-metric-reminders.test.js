'use strict';

jest.mock('../../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
const {
  HEALTH_METRIC_REMINDER_TYPES,
  areHealthMetricRemindersEnabled,
  getHiddenNotificationTypes,
  isHealthMetricReminderSuppressed,
} = require('../../src/services/notification/health-metric-reminders.policy');
const {
  reserveNotification,
  deliverNotification,
} = require('../../src/services/notification/notification-dispatch.service');
const {
  sendPushNotification,
} = require('../../src/services/notification/push.notification.service');
const {
  getNotifications,
  markAllAsRead,
  saveInAppNotification,
} = require('../../src/services/notification/notification.service');
const { hasReachedDailyCap } = require('../../src/services/notification/notification.policy');

describe('temporarily hidden health measurement notifications', () => {
  const originalFlag = process.env.HEALTH_METRIC_REMINDERS_ENABLED;
  beforeEach(() => {
    delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
    jest.clearAllMocks();
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
    else process.env.HEALTH_METRIC_REMINDERS_ENABLED = originalFlag;
  });

  test.each([undefined, '', 'false', '0', 'yes', 'invalid'])(
    'the pause is the default, even for invalid configuration %s',
    (value) => {
      if (value !== undefined) process.env.HEALTH_METRIC_REMINDERS_ENABLED = value;
      expect(areHealthMetricRemindersEnabled()).toBe(false);
      expect(getHiddenNotificationTypes()).toEqual(HEALTH_METRIC_REMINDER_TYPES);
    }
  );
  test.each(HEALTH_METRIC_REMINDER_TYPES)(
    'blocks creation of %s before a database write or budget reservation',
    async (type) => {
      const pool = { connect: jest.fn(), query: jest.fn() };
      expect(isHealthMetricReminderSuppressed(type)).toBe(true);
      await expect(
        reserveNotification(pool, { userId: 42, type, title: 'x', body: 'x' })
      ).resolves.toBeNull();
      await expect(saveInAppNotification(pool, 42, type, 'x', 'x')).resolves.toBeNull();
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
      expect(sendPushNotification).not.toHaveBeenCalled();
    }
  );
  test.each([
    'morning_checkin',
    'evening_checkin',
    'checkin_call',
    'emergency',
    'health_alert',
    'caregiver_alert',
    'early_signal',
    'checkin_followup_urgent',
    'reminder_medication',
    'reminder_medication_morning',
    'reminder_medication_evening',
    'reminder_water',
    'health_feed',
    'care_circle_invitation',
    'payment_failed',
  ])('keeps unrelated notification type %s available', (type) => {
    expect(isHealthMetricReminderSuppressed(type)).toBe(false);
  });
  test.each(HEALTH_METRIC_REMINDER_TYPES)(
    'cancels existing queued %s work without pushing',
    async (type) => {
      const pool = {
        query: jest.fn(async (sql) => ({
          rows: String(sql).includes('SELECT n.id, n.user_id')
            ? [{ id: 123, user_id: 42, type }]
            : [],
        })),
        release: jest.fn(),
      };
      pool.connect = jest.fn().mockResolvedValue(pool);
      await expect(deliverNotification(pool, 123)).resolves.toEqual({
        ok: false,
        skipped: true,
        reason: 'health_metric_reminders_paused',
      });
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("state = 'CANCELLED'"),
        [123]
      );
      expect(
        pool.query.mock.calls.some(([sql]) =>
          /attempts = attempts \+ 1|DELETE FROM notifications/.test(sql)
        )
      ).toBe(false);
      expect(sendPushNotification).not.toHaveBeenCalled();
    }
  );
  test('list, total and unread badge use the same filter before pagination', async () => {
    const visible = { id: 1, type: 'checkin_call', title: 'Check-in', message: 'Fixture' };
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [visible] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }),
    };
    await expect(getNotifications(pool, 42, { page: 2, limit: 10 })).resolves.toEqual({
      ok: true,
      notifications: [visible],
      pagination: { page: 2, limit: 10, total: 1, unreadCount: 1 },
    });
    expect(pool.query.mock.calls[0][1]).toEqual([42, 10, 10, HEALTH_METRIC_REMINDER_TYPES]);
    expect(pool.query.mock.calls[0][0]).toContain('NOT (type = ANY($4::text[]))');
    for (const [sql, values] of pool.query.mock.calls.slice(1)) {
      expect(sql).toContain('NOT (type = ANY($2::text[]))');
      expect(values).toEqual([42, HEALTH_METRIC_REMINDER_TYPES]);
    }
  });
  test('mark-all-read preserves the unread state of temporarily hidden history', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    await expect(markAllAsRead(pool, 42)).resolves.toEqual({ ok: true, markedCount: 1 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('NOT (type = ANY($2::text[]))'),
      [42, HEALTH_METRIC_REMINDER_TYPES]
    );
  });
  test('paused historical reminders no longer consume the daily budget of other notifications', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ count: 0 }] }) };
    await expect(hasReachedDailyCap(pool, 42)).resolves.toBe(false);
    const types = pool.query.mock.calls[0][1][1];
    expect(types).toContain('morning_checkin');
    expect(types).toContain('reminder_medication');
    for (const type of HEALTH_METRIC_REMINDER_TYPES) expect(types).not.toContain(type);
  });
  test('the explicit feature switch restores reminders and old inbox visibility', async () => {
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = ' TRUE ';
    expect(areHealthMetricRemindersEnabled()).toBe(true);
    expect(getHiddenNotificationTypes()).toEqual([]);
    for (const type of HEALTH_METRIC_REMINDER_TYPES)
      expect(isHealthMetricReminderSuppressed(type)).toBe(false);
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }),
    };
    await expect(getNotifications(pool, 42)).resolves.toMatchObject({ ok: true });
    expect(pool.query.mock.calls[0][1]).toEqual([42, 20, 0, []]);
  });
});
