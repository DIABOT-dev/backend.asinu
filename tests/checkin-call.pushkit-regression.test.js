jest.mock('../src/services/notification/apns.voip.service', () => ({
  sendVoipNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/notification/fcm.notification.service', () => ({
  sendFcmNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest
    .fn()
    .mockResolvedValue({ ok: true, data: { data: [{ status: 'ok' }] } }),
}));

const service = require('../src/services/checkin-call/checkin-call.service');
const { sendVoipNotification } = require('../src/services/notification/apns.voip.service');
const { sendFcmNotification } = require('../src/services/notification/fcm.notification.service');
const { sendPushNotification } = require('../src/services/notification/push.notification.service');

function deliveryPool(kind, channels = {}) {
  const delivery = {
    id: 'delivery',
    episode_id: 'episode',
    attempt_id: 'attempt',
    target_user_id: 7,
    state: 'PENDING',
    tries: 0,
    kind,
    severity: 'URGENT',
    lang: 'vi',
    episode_state: 'URGENT_BROADCAST',
    attempt_state: 'RINGING',
    target_role: 'FAMILY',
    config: { family_ring_seconds: 60 },
    voip_push_token: 'voip-device',
    voip_push_environment: 'production',
    ...channels,
  };
  const db = {
    query: jest.fn(async (sql) => ({ rows: sql.includes('SELECT d.*') ? [delivery] : [] })),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(async (sql) =>
      sql.includes('SELECT d.id') ? { rows: [{ id: delivery.id }], rowCount: 1 } : { rows: [] }
    ),
    connect: jest.fn(async () => db),
  };
  return { pool, db };
}

beforeEach(() => jest.clearAllMocks());

test('a new iOS call is still delivered once through APNs VoIP', async () => {
  const { pool } = deliveryPool('INCOMING_CALL', { push_token: 'ExpoPushToken[device]' });
  await service.dispatchDeliveries(pool);
  expect(sendVoipNotification).toHaveBeenCalledTimes(1);
  expect(sendVoipNotification).toHaveBeenCalledWith(
    'voip-device',
    expect.objectContaining({
      kind: 'INCOMING_CALL',
      episodeId: 'episode',
      attemptId: 'attempt',
    }),
    expect.objectContaining({ action: 'INCOMING_CALL', environment: 'production' })
  );
  expect(sendPushNotification).not.toHaveBeenCalled();
});

test.each(['URGENT_REPEAT', 'FALLBACK'])(
  '%s is a regular notification, never a VoIP push',
  async (kind) => {
    const { pool } = deliveryPool(kind, { push_token: 'ExpoPushToken[device]' });
    await service.dispatchDeliveries(pool);
    expect(sendVoipNotification).not.toHaveBeenCalled();
    expect(sendPushNotification).toHaveBeenCalledWith(
      ['ExpoPushToken[device]'],
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ kind })
    );
    const update = pool.query.mock.calls.find(([sql]) => sql.includes('last_error = $3'));
    expect(update[1][1]).toBe('SENT');
  }
);

test('a regular reminder cannot pretend to reach a VoIP-only iPhone', async () => {
  const { pool } = deliveryPool('URGENT_REPEAT');
  await service.dispatchDeliveries(pool);
  expect(sendVoipNotification).not.toHaveBeenCalled();
  expect(sendPushNotification).not.toHaveBeenCalled();
  const update = pool.query.mock.calls.find(([sql]) => sql.includes('last_error = $3'));
  expect(update[1][1]).toBe('FAILED');
  expect(update[1][2]).toBe('NO_REACHABLE_PUSH_TOKEN');
});

test('Android urgent repeats retain their existing FCM call behavior', async () => {
  const { pool } = deliveryPool('URGENT_REPEAT', { fcm_token: 'android-device' });
  await service.dispatchDeliveries(pool);
  expect(sendFcmNotification).toHaveBeenCalledWith(
    'android-device',
    expect.any(String),
    expect.any(String),
    expect.objectContaining({ kind: 'URGENT_REPEAT' }),
    { incomingCall: true }
  );
  expect(sendVoipNotification).not.toHaveBeenCalled();
});

test('declining an attempt cannot send an END_CALL VoIP push to iOS', async () => {
  const db = {
    query: jest.fn(async (sql) => {
      if (sql.includes('SELECT * FROM checkin_call_episodes'))
        return { rows: [{ id: 'episode', user_id: 7, state: 'CONTACT_USER' }] };
      if (sql.includes('SELECT * FROM checkin_call_attempts'))
        return { rows: [{ state: 'RINGING' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(async (sql) => {
      if (sql.startsWith('SELECT episode_id')) return { rows: [{ episode_id: 'episode' }] };
      if (sql.includes('SELECT a.id AS attempt_id'))
        return {
          rows: [
            {
              attempt_id: 'attempt',
              fcm_token: 'android-device',
              voip_push_token: 'ios-device',
              voip_push_environment: 'production',
              lang: 'vi',
            },
          ],
        };
      return { rows: [] };
    }),
    connect: jest.fn(async () => db),
  };
  await expect(service.decline(pool, 'attempt', 7)).resolves.toEqual({ ok: true });
  expect(sendVoipNotification).not.toHaveBeenCalled();
  expect(sendFcmNotification).toHaveBeenCalledWith(
    'android-device',
    expect.any(String),
    '',
    expect.objectContaining({ action: 'END_CALL', attemptId: 'attempt' }),
    { incomingCall: true }
  );
});
