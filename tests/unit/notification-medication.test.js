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
  generateMessage: jest
    .fn()
    .mockResolvedValue({
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
