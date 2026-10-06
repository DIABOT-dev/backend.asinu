'use strict';

jest.mock('../../src/services/payment/entitlement.service', () => ({
  getEntitlement: jest.fn(),
}));
const entitlement = require('../../src/services/payment/entitlement.service');
const service = require('../../src/services/checkin-call/checkin-call.service');

function poolFor({ reachable = true, relatives = [8] } = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (sql.includes('FROM checkin_call_settings')) return { rows: [] };
      if (sql.includes('SELECT push_token, fcm_token, voip_push_token')) {
        return { rows: [{ push_token: reachable ? 'ExpoPushToken[test-only]' : null }] };
      }
      if (sql.includes('FROM user_connections c')) {
        expect(params).toEqual([7, 'accepted']);
        expect(sql).toContain("c.permissions->>'can_receive_alerts'");
        expect(sql).toContain("c.permissions->>'can_ack_escalation'");
        expect(sql).toContain('recipient.deleted_at IS NULL');
        return { rows: relatives.map((family_id) => ({ family_id })) };
      }
      if (sql.startsWith('INSERT INTO checkin_call_settings')) {
        return { rows: [{ user_id: params[0], enabled: params[1], checkin_time: params[2] }] };
      }
      throw new Error('Unexpected settings query');
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  entitlement.getEntitlement.mockResolvedValue({ callCenterEnabled: true });
});

test('an enabled draft still requires an active An Tam entitlement', async () => {
  entitlement.getEntitlement.mockResolvedValueOnce({ callCenterEnabled: false });
  const pool = poolFor();
  await expect(service.saveSettings(pool, 7, { enabled: true })).rejects.toMatchObject({
    statusCode: 403,
    i18nKey: 'error.an_tam_required',
  });
  expect(pool.query).not.toHaveBeenCalled();
});

test('enabling still requires a notification device for the user', async () => {
  const pool = poolFor({ reachable: false });
  await expect(service.saveSettings(pool, 7, { enabled: true })).rejects.toMatchObject({
    statusCode: 409,
    i18nKey: 'checkinCall.error.notifications_required',
  });
  expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});

test('a personal reminder can be enabled and saved with no eligible Care Circle relatives', async () => {
  const pool = poolFor({ relatives: [] });
  await expect(service.saveSettings(pool, 7, { enabled: true, checkin_time: '08:30' })).resolves.toMatchObject({
    user_id: 7,
    enabled: true,
    checkin_time: '08:30',
  });
  expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM user_connections c'))).toBe(false);
});

test('backend checks the personal notification device and persists the enabled schedule for the session user', async () => {
  const pool = poolFor();
  await expect(
    service.saveSettings(pool, 7, { enabled: true, checkin_time: '08:30' })
  ).resolves.toMatchObject({
    user_id: 7,
    enabled: true,
    checkin_time: '08:30',
  });
});

test('the warning never bypasses alert permissions when resolving actual recipients', async () => {
  const pool = poolFor({ relatives: [] });
  await expect(service.eligibleContacts(pool, 7)).resolves.toEqual([]);
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('a disabled configuration can be saved without reachable relatives or push tokens', async () => {
  const pool = poolFor({ reachable: false, relatives: [] });
  await expect(
    service.saveSettings(pool, 7, { enabled: false, checkin_time: '09:00' })
  ).resolves.toMatchObject({
    enabled: false,
    checkin_time: '09:00',
  });
  expect(pool.query).toHaveBeenCalledTimes(2);
});
