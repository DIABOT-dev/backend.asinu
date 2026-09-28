const service = require('../src/services/checkin-call/checkin-call.service');
const audio = require('../src/services/checkin-call/audio.service');

describe('check-in call provider failure handling', () => {
  const originalApiKey = process.env.VIENEU_API_KEY;
  const originalTimeout = process.env.VIENEU_TIMEOUT_MS;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.VIENEU_API_KEY;
    else process.env.VIENEU_API_KEY = originalApiKey;
    if (originalTimeout === undefined) delete process.env.VIENEU_TIMEOUT_MS;
    else process.env.VIENEU_TIMEOUT_MS = originalTimeout;
    global.fetch = originalFetch;
  });

  test('recognizes invalid FCM, APNs and Expo tokens without clearing transient failures', () => {
    expect(
      service._test.invalidPushTokenChannels(
        { ok: false, status: 404, error: 'Requested entity was not found' },
        { ok: false, status: 410, error: 'Unregistered' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } }
      )
    ).toEqual({ fcm: true, apns: true, expo: true });
    expect(
      service._test.invalidPushTokenChannels(
        { ok: false, status: 503, error: 'FCM timeout' },
        { ok: false, status: 500, error: 'APNS_TIMEOUT' },
        { status: 'error', details: { error: 'MessageTooBig' } }
      )
    ).toEqual({ fcm: false, apns: false, expo: false });
  });

  test('returns a controlled 503 when a cached TTS asset is missing and VieNeu is not configured', async () => {
    delete process.env.VIENEU_API_KEY;
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(audio.getAudio(pool, 'user_prompt', 'vi')).rejects.toMatchObject({
      statusCode: 503,
      i18nKey: 'checkinCall.error.audio_unavailable',
    });
  });

  test('turns a slow VieNeu request into a controlled 503', async () => {
    process.env.VIENEU_API_KEY = 'test-key';
    process.env.VIENEU_TIMEOUT_MS = '1';
    global.fetch = jest.fn(async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(audio.getAudio(pool, 'user_prompt', 'vi')).rejects.toMatchObject({
      statusCode: 503,
      message: 'VieNeu timed out',
    });
    expect(audio.synthesisTimeoutMs()).toBe(1000);
  });
});
