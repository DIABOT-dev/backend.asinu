const { _test } = require('../src/services/notification/apns.voip.service');

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

  test('builds a remote end-call payload with the same attempt identity', () => {
    expect(
      _test.buildPayload(
        { episodeId: 'episode-2', attemptId: 'attempt-2', kind: 'END_CALL' },
        'END_CALL'
      )
    ).toMatchObject({
      action: 'END_CALL',
      kind: 'END_CALL',
      episodeId: 'episode-2',
      attemptId: 'attempt-2',
    });
  });
});
