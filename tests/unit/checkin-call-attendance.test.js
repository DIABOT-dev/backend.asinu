const { attendance } = require('../../src/services/early-signal/attendance');

describe('check-in attendance is based on the protected person, not family actions', () => {
  const times = { scheduled_at: '2026-10-05T01:00:00Z', grace_until: '2026-10-05T07:00:00Z' };
  test.each([
    'RESOLVED',
    'MILD_FAMILY_ESCALATION',
    'URGENT_BROADCAST',
    'URGENT_ACKNOWLEDGED',
    'EXHAUSTED_URGENT',
  ])('%s without a response is not an on-time check-in', (state) => {
    expect(attendance({ ...times, state })).toBe('missed');
  });
  test('a late response stays late even after somebody confirms', () => {
    expect(attendance({ ...times, state: 'RESOLVED', responded_at: '2026-10-05T07:01:00Z' })).toBe(
      'late'
    );
  });
  test('an actual on-time check-in is recognized', () => {
    expect(attendance({ ...times, state: 'RESOLVED', checked_in_at: '2026-10-05T06:59:00Z' })).toBe(
      'on_time'
    );
  });
  test('unsent and cancelled schedules are not completed check-ins', () => {
    expect(attendance({ ...times, state: 'SCHEDULED' })).toBe('pending');
    expect(attendance({ ...times, state: 'CANCELLED' })).toBe('cancelled');
  });
  test('manual check-in cancelling a missed-check-in call is still an actual response', () => {
    expect(
      attendance({ ...times, state: 'CANCELLED', checked_in_at: '2026-10-05T07:01:00Z' })
    ).toBe('late');
    expect(attendance({ ...times, state: 'CANCELLED', responded_at: '2026-10-05T06:59:00Z' })).toBe(
      'on_time'
    );
  });
});
