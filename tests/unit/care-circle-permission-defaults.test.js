'use strict';

const {
  normalizePermissions,
  updateConnectionPermissions,
} = require('../../src/services/care-circle/careCircle.service');

test.each([undefined, {}])('new invitation permissions %j enable viewing by default', (input) => {
  expect(normalizePermissions(input).can_view_logs).toBe(true);
});

test.each([false, 'false', 'true', 1, null])(
  'an explicit value %j cannot silently grant viewing',
  (value) => {
    expect(normalizePermissions({ can_view_logs: value }).can_view_logs).toBe(false);
  }
);

test('an explicit boolean true grants viewing', () => {
  expect(normalizePermissions({ can_view_logs: true }).can_view_logs).toBe(true);
});

test('updating other permissions does not re-enable existing revoked viewing', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await updateConnectionPermissions(pool, 'connection-id', 7, {
    can_receive_alerts: true,
    can_ack_escalation: true,
  });
  expect(JSON.parse(pool.query.mock.calls[0][1][0])).toEqual({
    can_view_logs: false,
    can_receive_alerts: true,
    can_ack_escalation: true,
  });
});
