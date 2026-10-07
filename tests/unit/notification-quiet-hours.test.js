'use strict';

const {
  explicitReminderMinute,
  getQuietHoursHoldUntil,
  resolveNotificationTimezone,
} = require('../../src/services/notification/notification-quiet-hours.policy');
const at = (time) => new Date(`2026-10-07T${time}+07:00`);
const routine = { type: 'care_circle_invitation', priority: 'high', data: {} };
const hold = (notification, preferences, time, timezone = 'Asia/Ho_Chi_Minh') =>
  getQuietHoursHoldUntil(notification, preferences, timezone, at(time));

describe('notification quiet hours, 22:00 to 06:00', () => {
  test.each(['00:00:00', '03:30:00', '05:00:00', '05:59:59'])(
    'holds ordinary pushes until 06:00 at %s',
    (time) => {
      expect(hold(routine, {}, time)).toEqual(at('06:00:00'));
    }
  );
  test.each(['22:00:00', '22:30:00', '23:59:59'])(
    'holds evening pushes until the next morning at %s',
    (time) => {
      expect(hold(routine, {}, time)).toEqual(new Date('2026-10-08T06:00:00+07:00'));
    }
  );
  test.each(['06:00:00', '06:00:01', '12:00:00', '21:59:59'])(
    'does not hold daytime pushes at %s',
    (time) => {
      expect(hold(routine, {}, time)).toBeNull();
    }
  );
  test.each([
    'payment_failed',
    'subscription_expired',
    'wallet_topup_success',
    'doctor_message',
    'profile_incomplete',
    'early_signal',
    'health_feed',
    'checkin_followup',
  ])(
    '%s does not bypass quiet hours merely because it is transactional or high priority',
    (type) => {
      expect(
        hold({ ...routine, type }, { reminders_enabled: true, evening_time: '23:00' }, '23:00:00')
      ).not.toBeNull();
    }
  );
  test.each(['emergency', 'alert', 'health_alert', 'caregiver_alert', 'checkin_followup_urgent'])(
    '%s retains immediate safety delivery',
    (type) => {
      expect(hold({ ...routine, type }, {}, '23:00:00')).toBeNull();
    }
  );
  test.each([
    { type: 'early_signal', data: { severity: 'urgent' } },
    { type: 'custom', priority: 'critical' },
    { type: 'custom', data: { requiresImmediate: true } },
    { type: 'custom', data: { alertType: 'emergency' } },
    { type: 'checkin_call', data: { kind: 'INCOMING_CALL' } },
    { type: 'checkin_call', data: { kind: 'URGENT_REPEAT' } },
  ])('urgent/active-call payload remains immediate: %j', (notification) => {
    expect(hold(notification, {}, '01:00:00')).toBeNull();
  });
  test('routine care-circle reengagement does not inherit the caregiver emergency exception', () => {
    for (const data of [{ reengage_patient_id: 42 }, { templateId: 'reengage_care_circle' }]) {
      expect(
        hold({ type: 'caregiver_alert', priority: 'high', data }, {}, '23:00:00')
      ).not.toBeNull();
    }
  });
  test('user-selected evening reminder is delivered at night and its spaced retry stays eligible', () => {
    const reminder = { type: 'reminder_evening_summary', created_at: at('23:15:20') };
    const preferences = { reminders_enabled: true, evening_time: '23:15' };
    expect(hold(reminder, preferences, '23:15:20')).toBeNull();
    expect(hold(reminder, preferences, '23:20:00')).toBeNull();
    expect(
      getQuietHoursHoldUntil(reminder, preferences, null, new Date('2026-10-08T00:05:00+07:00'))
    ).toBeNull();
  });
  test('explicit morning and afternoon time selections also support night hours', () => {
    for (const [type, slot, time] of [
      ['reminder_morning_summary', 'morning', '05:30'],
      ['reminder_afternoon', 'afternoon', '00:15'],
    ]) {
      const reference = at(`${time}:10`);
      expect(
        getQuietHoursHoldUntil(
          { type, created_at: reference },
          { reminders_enabled: true, [`${slot}_time`]: time },
          null,
          reference
        )
      ).toBeNull();
    }
  });
  test('inferred schedules and global opt-in do not count as an explicit night configuration', () => {
    const reminder = { type: 'reminder_evening_summary', created_at: at('23:00:00') };
    for (const preferences of [
      { reminders_enabled: true },
      { reminders_enabled: true, inferred_evening_hour: 23 },
      { reminders_enabled: true, inferred_evening_time: '23:00' },
      { reminders_enabled: true, evening_time: 'invalid' },
      { reminders_enabled: false, evening_time: '23:00' },
    ])
      expect(hold(reminder, preferences, '23:00:00')).not.toBeNull();
  });
  test('wrong slot, removed configuration, old creation time, future or unknown creation never bypass quiet hours', () => {
    const preferences = { reminders_enabled: true, evening_time: '23:00' };
    for (const notification of [
      { type: 'reminder_morning_summary', created_at: at('23:00:00') },
      { type: 'reminder_evening_summary', created_at: at('21:00:00') },
      { type: 'reminder_evening_summary', created_at: at('23:01:00') },
      { type: 'reminder_evening_summary', created_at: new Date('2026-10-06T23:00:00+07:00') },
      { type: 'reminder_evening_summary', created_at: 'invalid' },
      { type: 'reminder_evening_summary' },
    ])
      expect(hold(notification, preferences, '23:00:00')).not.toBeNull();
    expect(
      hold(
        { type: 'reminder_evening_summary', created_at: at('23:00:00') },
        { reminders_enabled: true, evening_time: null },
        '23:00:00'
      )
    ).not.toBeNull();
  });
  test('legacy user-selected hours remain supported, but null and inferred hours do not', () => {
    expect(explicitReminderMinute({ evening_hour: 23 }, 'evening')).toBe(1380);
    expect(
      explicitReminderMinute({ evening_time: ' 22:15:30 ', evening_hour: 23 }, 'evening')
    ).toBe(1335);
    for (const value of [null, undefined, NaN, '23', -1, 24])
      expect(
        explicitReminderMinute({ evening_hour: value, inferred_evening_hour: 23 }, 'evening')
      ).toBeNull();
  });
  test('quiet hours use recipient timezone rather than the server clock', () => {
    const reference = new Date('2026-10-07T23:30:00Z');
    expect(getQuietHoursHoldUntil(routine, {}, 'UTC', reference)).toEqual(
      new Date('2026-10-08T06:00:00Z')
    );
    expect(getQuietHoursHoldUntil(routine, {}, 'Asia/Ho_Chi_Minh', reference)).toBeNull();
  });
  test.each([
    ['2026-03-07T22:30:00-05:00', '2026-03-08T06:00:00-04:00'],
    ['2026-10-31T22:30:00-04:00', '2026-11-01T06:00:00-05:00'],
  ])('06:00 remains local 06:00 across DST from %s', (reference, expected) => {
    expect(getQuietHoursHoldUntil(routine, {}, 'America/New_York', new Date(reference))).toEqual(
      new Date(expected)
    );
  });
  test('invalid or missing timezone falls back to Vietnam instead of bypassing the policy', () => {
    for (const zone of [null, undefined, '', 'invalid/zone']) {
      expect(resolveNotificationTimezone(zone)).toBe('Asia/Ho_Chi_Minh');
      expect(hold(routine, {}, '23:00:00', zone)).not.toBeNull();
    }
  });
  test('invalid reference time fails closed before any push', () => {
    expect(() => getQuietHoursHoldUntil(routine, {}, null, 'invalid')).toThrow(
      'Invalid notification reference time'
    );
  });
});
