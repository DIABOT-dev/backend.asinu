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
const { verifyDeclineCapability } = require('../src/services/checkin-call/native-action.service');

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

test('Android receives an ISO original deadline and an attempt-scoped action, never persisted in the inbox', async () => {
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-action-secret';
  try {
    const attempt = 'bca2c9da-26fe-44a3-ac05-3f8dd75bc9e0';
    const deadline = new Date(Date.now() + 60_000);
    const { pool } = deliveryPool('INCOMING_CALL', { fcm_token: 'android', attempt_id: attempt, ring_deadline: deadline });
    await service.dispatchDeliveries(pool);
    const payload = sendFcmNotification.mock.calls[0][3];
    expect(payload.ringDeadline).toBe(deadline.toISOString());
    expect(verifyDeclineCapability(attempt, payload.declineCapability)).toBe(7);
    expect(sendVoipNotification.mock.calls[0][1]).not.toHaveProperty('declineCapability');
    const inbox = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
    expect(JSON.parse(inbox[1][3])).not.toHaveProperty('declineCapability');
  } finally {
    if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original;
  }
});

test.each(['CONNECTED', 'WAITING_CONFIRMATION', 'NO_ANSWER'])('late native decline cannot change %s or end the accepted call', async state => {
  const db = {
    query: jest.fn(async sql => ({ rows: sql.includes('SELECT * FROM checkin_call_episodes')
      ? [{ id: 'episode', user_id: 7, state: 'CONTACT_USER' }]
      : sql.includes('SELECT * FROM checkin_call_attempts') ? [{ state }] : [] })),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(async () => ({ rows: [{ episode_id: 'episode' }] })),
    connect: jest.fn(async () => db),
  };
  await service.decline(pool, 'attempt', 7, { ringingOnly: true });
  expect(db.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  expect(sendFcmNotification).not.toHaveBeenCalled();
});

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
