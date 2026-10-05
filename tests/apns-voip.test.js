const { _test, sendVoipNotification } = require('../src/services/notification/apns.voip.service');

describe('APNs VoIP payload', () => {
  test('uses sandbox unless production is explicit', () => {
    expect(_test.normalizeEnvironment()).toBe('sandbox');
    expect(_test.normalizeEnvironment('development')).toBe('sandbox');
    expect(_test.normalizeEnvironment('production')).toBe('production');
  });

  test('builds an incoming-call payload understood by the iOS native layer', () => {
    expect(
      _test.buildPayload({
        episodeId: 'episode-1',
        attemptId: 'attempt-1',
        severity: 'URGENT',
        ringSeconds: 60,
      })
    ).toMatchObject({
      aps: { 'content-available': 1 },
      type: 'checkin_call',
      checkinCall: true,
      action: 'INCOMING_CALL',
      kind: 'INCOMING_CALL',
      episodeId: 'episode-1',
      attemptId: 'attempt-1',
      severity: 'URGENT',
      ringSeconds: 60,
    });
  });

  test.each([
    [{ kind: 'END_CALL' }, 'END_CALL'],
    [{ kind: 'END_CALL' }, 'INCOMING_CALL'],
    [{ action: 'END_CALL' }, 'INCOMING_CALL'],
    [{ kind: 'URGENT_REPEAT' }, 'INCOMING_CALL'],
    [{}, 'URGENT_REPEAT'],
  ])('refuses VoIP control/reminder payload %j with action %s', (data, action) => {
    expect(() =>
      _test.buildPayload({ episodeId: 'episode-2', attemptId: 'attempt-2', ...data }, action)
    ).toThrow('VOIP_REQUIRES_INCOMING_CALL');
  });

  test.each([
    {},
    { episodeId: 'episode' },
    { attemptId: 'attempt' },
    { episodeId: ' ', attemptId: 'attempt' },
    { episodeId: 'episode', attemptId: 12 },
  ])('rejects missing/invalid call identity %j', (data) => {
    expect(() => _test.buildPayload(data)).toThrow('VOIP_REQUIRES_CALL_IDENTITY');
  });

  test('rejects END_CALL before contacting APNs or loading credentials', async () => {
    await expect(
      sendVoipNotification(
        'device-token',
        {
          episodeId: 'episode',
          attemptId: 'attempt',
          kind: 'END_CALL',
        },
        { action: 'END_CALL' }
      )
    ).resolves.toEqual({ ok: false, error: 'VOIP_REQUIRES_INCOMING_CALL' });
  });
});
