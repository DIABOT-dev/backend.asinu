'use strict';

jest.mock('../../src/services/notification/notification-dispatch.service', () => ({
  reserveNotification: jest.fn().mockResolvedValue({ notificationId: 1, existing: false }),
  deliverNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/checkin/checkin.service', () => ({
  runCheckinFollowUps: jest.fn().mockResolvedValue({ sent: 0 }),
  runMorningCheckin: jest.fn().mockResolvedValue({ sent: 0 }),
  runAlertConfirmationFollowUps: jest.fn().mockResolvedValue({ sent: 0 }),
}));
jest.mock('../../src/services/notification/notification-intelligence.service', () => ({
  generateMessage: jest.fn().mockResolvedValue({
    text: 'Fixture reminder',
    templateId: 'fixture',
    topic: { kind: 'medical_condition', code: 'diabetes', recordedAt: null },
  }),
  checkAlertTriggers: jest.fn().mockResolvedValue(null),
}));
const {
  reserveNotification,
} = require('../../src/services/notification/notification-dispatch.service');
const {
  runBasicNotifications,
} = require('../../src/services/notification/basic.notification.service');
const {
  runMorningCheckin,
  runCheckinFollowUps,
  runAlertConfirmationFollowUps,
} = require('../../src/services/checkin/checkin.service');
const originalMetricFlag = process.env.HEALTH_METRIC_REMINDERS_ENABLED;
beforeEach(() => {
  process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'true';
});
afterAll(() => {
  if (originalMetricFlag === undefined) delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
  else process.env.HEALTH_METRIC_REMINDERS_ENABLED = originalMetricFlag;
});

test.each([
  ['Có', true],
  ['Không', false],
  ['Chỉ thực phẩm chức năng', false],
  [null, false],
  [undefined, false],
  ['yes', true],
  ['no', false],
])(
  'medication reminder requires explicit daily medication: %s',
  async (daily_medication, expected) => {
    reserveNotification.mockClear();
    const user = {
      id: 42,
      lang: 'vi',
      medical_conditions: ['Tiểu đường'],
      daily_medication,
      no_medication_today: true,
      no_glucose_today: true,
      no_log_today: true,
      no_evening_log: true,
    };
    const pool = {
      query: jest.fn(async (sql) => ({
        rows: /AS no_log_today|AS no_evening_log/.test(sql) ? [user] : [],
      })),
    };
    const result = await runBasicNotifications(pool, 8, 0);
    expect(result.results.some((entry) => entry.failed)).toBe(false);
    for (const type of ['reminder_morning_summary', 'reminder_evening_summary']) {
      const notification = reserveNotification.mock.calls.find(
        ([, options]) => options.type === type
      )?.[1];
      expect(notification).toBeDefined();
      expect(notification.data.missingTypes.includes('medication')).toBe(expected);
      expect(notification.data.templateId).toBe('fixture');
      expect(notification.data.topic.code).toBe('diabetes');
    }
    expect(
      pool.query.mock.calls
        .filter(([sql]) => /AS no_log_today|AS no_evening_log/.test(sql))
        .every(([sql]) => sql.includes('uop.daily_medication'))
    ).toBe(true);
  }
);

test.each([22, 23, 0, 5])(
  'night scheduler at %s only selects explicit reminder slots and safety follow-ups',
  async (hour) => {
    jest.clearAllMocks();
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await runBasicNotifications(pool, hour, 30);
    expect(result.quietHours).toBe(true);
    expect(result.results.some((entry) => entry.failed)).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(3);
    const queries = pool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' '));
    expect(queries[0]).toContain('IS NOT NULL OR np.morning_hour IS NOT NULL');
    expect(queries[1]).toContain('THEN np.afternoon_time::time END) IS NOT NULL');
    expect(queries[2]).toContain('IS NOT NULL OR np.evening_hour IS NOT NULL');
    expect(
      pool.query.mock.calls.every(([, values]) => values[0] === hour && values[1] === 30)
    ).toBe(true);
    expect(runMorningCheckin).not.toHaveBeenCalled();
    expect(runCheckinFollowUps).toHaveBeenCalledTimes(1);
    expect(runAlertConfirmationFollowUps).toHaveBeenCalledTimes(1);
  }
);

test('daytime scheduler resumes automatically at 06:00', async () => {
  jest.clearAllMocks();
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const result = await runBasicNotifications(pool, 6, 0);
  expect(result.quietHours).not.toBe(true);
  expect(result.results.some((entry) => entry.failed)).toBe(false);
  expect(runMorningCheckin).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls[0][0]).not.toContain('IS NOT NULL OR np.morning_hour IS NOT NULL');
});

test.each([8, 14, 21, 23, 5])(
  'paused measurement reminders do not query profiles or generate scheduled messages at %s',
  async (hour) => {
    delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
    jest.clearAllMocks();
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await runBasicNotifications(pool, hour, 0);
    expect(result.results.filter((entry) => entry.paused).map((entry) => entry.type)).toEqual([
      'morning_summary',
      'afternoon',
      'evening_summary',
    ]);
    expect(
      pool.query.mock.calls.some(([sql]) =>
        /AS no_log_today|AS no_evening_log|np.afternoon_time/.test(sql)
      )
    ).toBe(false);
    expect(reserveNotification).not.toHaveBeenCalled();
    expect(runCheckinFollowUps).toHaveBeenCalledTimes(1);
    expect(runAlertConfirmationFollowUps).toHaveBeenCalledTimes(1);
  }
);
