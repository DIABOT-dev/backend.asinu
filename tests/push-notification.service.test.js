const { sendPushNotification } = require('../src/services/notification/push.notification.service');

describe('Expo push notification service', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('uses the alert channel for health alerts', async () => {
    global.fetch = jest.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }),
      requestBody: options.body,
    }));

    await expect(
      sendPushNotification(
        ['ExpoPushToken[health-alert-test]'],
        'Cảnh báo sức khỏe',
        'Chỉ số cần chú ý',
        { type: 'health_alert' }
      )
    ).resolves.toMatchObject({ ok: true });

    const message = JSON.parse(global.fetch.mock.calls[0][1].body)[0];
    expect(message).toMatchObject({
      channelId: 'asinu_alert_warm_v1',
      sound: 'asinu_emergency.caf',
      priority: 'high',
    });
  });

  test('reports an unregistered device token instead of claiming success', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'Device is not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    }));

    await expect(
      sendPushNotification(['ExpoPushToken[expired-token]'], 'Thông báo', 'Nội dung', {
        type: 'payment_failed',
      })
    ).resolves.toMatchObject({
      ok: false,
      invalidTokens: ['ExpoPushToken[expired-token]'],
    });
  });
  test.each([{}, { data: [] }, { data: [{}] }])(
    'does not report success for a malformed ticket response %j',
    async (result) => {
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => result }));
      await expect(
        sendPushNotification(['ExpoPushToken[fixture]'], 'x', 'x')
      ).resolves.toMatchObject({ ok: false });
    }
  );
});
