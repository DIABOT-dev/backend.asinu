const manifest = require('../src/config/notification-sounds.json');
const { notificationSoundConfig } = require('../src/services/notification/notification-sound.config');
const { sendPushNotification } = require('../src/services/notification/push.notification.service');

describe('Warm notification pack', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const cases = [
    ...Object.entries(manifest.types).map(([type, group]) => [{ type }, group]),
    [{ type: 'early_signal', severity: 'urgent' }, 'alert'],
    [{ type: 'early_signal', severity: 'URGENT' }, 'alert'],
    [{ type: 'early_signal', severity: 'attention' }, 'reminder'],
    [{ type: 'checkin_call', kind: 'INCOMING_CALL', severity: 'UNKNOWN' }, 'incoming'],
    [{ type: 'checkin_call', kind: 'INCOMING_CALL', severity: 'MILD' }, 'incoming'],
    [{ type: 'checkin_call', kind: 'INCOMING_CALL', severity: 'URGENT' }, 'alert'],
    [{ type: 'checkin_call', kind: 'URGENT_REPEAT' }, 'alert'],
    [{ type: 'checkin_call', kind: 'FALLBACK', severity: 'UNKNOWN' }, 'missed'],
    [{ type: 'checkin_call', kind: 'FALLBACK', severity: 'URGENT' }, 'alert'],
    [{ type: 'checkin_call', kind: 'MISSED_CALL' }, 'missed'],
    [{ type: 'checkin_call' }, 'incoming'],
    [{ type: 'new_type' }, 'reminder'],
    [{ type: '__proto__' }, 'reminder'],
    [{ type: 'constructor' }, 'reminder'],
    [{ type: 'new_type', requiresImmediate: true }, 'alert'],
    [{ type: 'new_type', alertType: 'emergency' }, 'alert'],
    [{}, 'reminder'],
  ];
  test.each(cases)('routes %j to the %s warm sound/channel', async (data, group) => {
    global.fetch = jest.fn(async () => ({
      ok: true, json: async () => ({ data: [{ status: 'ok', id: 'sound-test' }] }),
    }));
    await expect(sendPushNotification(['ExpoPushToken[sound-test]'], 'test', 'test', data))
      .resolves.toMatchObject({ ok: true });
    const config = manifest.groups[group];
    const message = JSON.parse(global.fetch.mock.calls[0][1].body)[0];
    expect(message).toMatchObject({
      data,
      channelId: config.channelId,
      sound: manifest.sounds[config.sound].ios,
      priority: config.priority,
    });
    expect(notificationSoundConfig(data).group).toBe(group);
    expect(message.sound).not.toBe(manifest.sounds.ringback.ios);
  });
  test('keeps specialist quick reply and health alert actions', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true, json: async () => ({ data: [{ status: 'ok', id: 'sound-test' }] }),
    }));
    await sendPushNotification(['ExpoPushToken[test]'], 'test', 'test', { type: 'doctor_message', task_id: '42' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)[0]).toMatchObject({
      categoryId: 'doctor_message', threadId: 'doctor-42', sound: 'asinu_notification.caf',
    });
    await sendPushNotification(['ExpoPushToken[test]'], 'test', 'test', { type: 'emergency' });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)[0]).toMatchObject({
      categoryId: 'health_alert', sound: 'asinu_emergency.caf',
    });
  });
});
