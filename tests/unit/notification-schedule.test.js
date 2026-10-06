'use strict';

const {
  getScheduledReminderHoldUntil,
  isScheduledReminder,
  scheduledHoldUntil,
} = require('../../src/services/notification/notification-schedule.policy');

describe('fixed-time notification priority', () => {
  const preferences = { reminders_enabled: true, morning_time: '09:15' };
  const at = (time) => new Date(`2026-10-06T${time}+07:00`);

  test.each([
    'morning_checkin',
    'evening_checkin',
    'reminder_morning_summary',
    'reminder_glucose',
    'reminder_future_type',
  ])('%s is a scheduled reminder', (type) => expect(isScheduledReminder(type)).toBe(true));
  test.each([
    'health_feed',
    'reengagement',
    'weekly_recap',
    'emergency',
    'doctor_message',
    undefined,
  ])('%s is not a scheduled reminder', (type) => expect(isScheduledReminder(type)).toBe(false));
  test.each(['09:10:00', '09:14:59', '09:15:59'])(
    'protects the configured minute and five minutes before it at %s',
    (time) => {
      expect(scheduledHoldUntil(preferences, at(time))).toEqual(at('09:20:00'));
    }
  );
  test.each(['09:09:59', '09:16:00', '09:20:00'])(
    'does not unnecessarily hold general notifications at %s',
    (time) => {
      expect(scheduledHoldUntil(preferences, at(time))).toBeNull();
    }
  );
  test('explicit HH:MM overrides legacy hours and accepts trimmed seconds', () => {
    expect(
      scheduledHoldUntil(
        { ...preferences, morning_time: ' 09:15:30 ', morning_hour: 10 },
        at('09:13:00')
      )
    ).toEqual(at('09:20:00'));
  });
  test('invalid explicit times use the same legacy and inferred fallbacks as cron', () => {
    expect(
      scheduledHoldUntil(
        { ...preferences, morning_time: '25:70', morning_hour: 10 },
        at('09:57:00')
      )
    ).toEqual(at('10:05:00'));
    expect(
      scheduledHoldUntil(
        { ...preferences, morning_time: null, inferred_morning_hour: 9 },
        at('08:57:00')
      )
    ).toEqual(at('09:05:00'));
    expect(
      scheduledHoldUntil(
        { ...preferences, afternoon_time: 'invalid', inferred_afternoon_time: '15:20' },
        at('15:18:00')
      )
    ).toEqual(at('15:25:00'));
    expect(
      scheduledHoldUntil({ ...preferences, evening_time: null, evening_hour: 20 }, at('19:58:00'))
    ).toEqual(at('20:05:00'));
  });
  test('protects default reminders and the existing 07:00 system check-in', () => {
    for (const time of ['07:00:00', '08:00:00', '14:00:00', '21:00:00']) {
      expect(scheduledHoldUntil({ reminders_enabled: true }, at(time))).toEqual(
        new Date(at(time).getTime() + 5 * 60000)
      );
    }
  });
  test('overlapping configured times hold until the latest reminder has its spacing', () => {
    expect(scheduledHoldUntil({ ...preferences, afternoon_time: '09:18' }, at('09:14:00'))).toEqual(
      at('09:23:00')
    );
  });
  test('opt-out, invalid dates and quiet-hour schedules do not hold notifications', () => {
    expect(
      scheduledHoldUntil({ ...preferences, reminders_enabled: false }, at('09:15:00'))
    ).toBeNull();
    expect(scheduledHoldUntil(preferences, 'invalid')).toBeNull();
    expect(
      scheduledHoldUntil({ ...preferences, evening_time: '22:00' }, at('21:58:00'))
    ).toBeNull();
    expect(
      scheduledHoldUntil({ ...preferences, morning_time: '04:00' }, at('03:58:00'))
    ).toBeNull();
  });
  test('uses the database clock and only completed-onboarding schedules', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ ...preferences, reference_time: at('09:14:00') }],
        }),
    };
    await expect(getScheduledReminderHoldUntil(pool, 42)).resolves.toBeNull();
    await expect(getScheduledReminderHoldUntil(pool, 42)).resolves.toEqual(at('09:20:00'));
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('uop.onboarding_completed_at IS NOT NULL'),
      [42]
    );
  });
});
