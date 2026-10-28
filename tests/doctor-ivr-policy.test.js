const { defaults, policySchema, nextCallTime } = require('../src/services/doctor-ivr/ivr.policy');
const { transcriptionResult } = require('../src/services/doctor-ivr/stt-quality');
describe('IVR SRS delivery policy and speech quality', () => {
  test('question metrics group identical wording and choices across generated IDs, without mixing tenants or distinct questions', () => {
    process.env.DOCTOR_IVR_ENCRYPTION_KEY = 'ab'.repeat(32);
    const { questionFingerprint } = require('../src/services/doctor-ivr/ivr.policy');
    const first = {
      id: 'q1',
      text: 'Bác có thấy mệt không?',
      options: [
        { id: 'a1', label: 'Có', type: 'option' },
        { id: 'a2', label: 'Không', type: 'option' },
      ],
    };
    const another = {
      ...first,
      id: 'q_generated',
      options: first.options.map((o) => ({ ...o, id: 'new_' + o.id, red_flag: true })),
    };
    assertHash(questionFingerprint('clinic-a', first));
    expect(questionFingerprint('clinic-a', first)).toBe(questionFingerprint('clinic-a', another));
    expect(questionFingerprint('clinic-b', first)).not.toBe(questionFingerprint('clinic-a', first));
    expect(questionFingerprint('clinic-a', { ...first, text: 'Bác ngủ có ngon không?' })).not.toBe(
      questionFingerprint('clinic-a', first)
    );
    function assertHash(value) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
      expect(value).not.toContain('mệt');
    }
  });
  test('the audit diff records changed risk labels, deletions and reordering without inventing edits', () => {
    const { questionSetChanges } = require('../src/services/doctor-ivr/question-set.diff');
    const before = {
      title: 'Hỏi thêm',
      greeting: '',
      closing: '',
      est_duration_s: 90,
      questions: [
        { id: 'q1', text: 'Câu một', options: [{ label: 'Có', red_flag: false }] },
        { id: 'q2', text: 'Câu hai' },
      ],
    };
    expect(questionSetChanges(before, before)).toEqual([]);
    const after = {
      ...before,
      questions: [{ ...before.questions[0], options: [{ label: 'Có', red_flag: true }] }],
    };
    const changes = questionSetChanges(before, after);
    expect(changes.find((v) => v.question_id === 'q1')).toMatchObject({
      before: before.questions[0],
      after: after.questions[0],
    });
    expect(changes.find((v) => v.question_id === 'q2').after).toBeNull();
    expect(changes.find((v) => v.field === 'question_order')).toEqual({
      field: 'question_order',
      before: ['q1', 'q2'],
      after: ['q1'],
    });
  });
  test.each([
    ['2026-10-27T23:59:00+07:00', '2026-10-28T00:00:00.000Z'],
    ['2026-10-27T06:59:00+07:00', '2026-10-27T00:00:00.000Z'],
    ['2026-10-27T07:00:00+07:00', '2026-10-27T00:00:00.000Z'],
    ['2026-10-27T20:59:00+07:00', '2026-10-27T13:59:00.000Z'],
    ['2026-10-27T21:00:00+07:00', '2026-10-28T00:00:00.000Z'],
  ])('never schedules a call outside local 07:00–21:00: %s', (input, expected) => {
    expect(nextCallTime(input, defaults()).toISOString()).toBe(expected);
  });
  test('uses patient timezone, including daylight saving transitions', () => {
    const policy = { ...defaults(), timezone: 'America/New_York' };
    expect(nextCallTime('2026-11-01T04:59:00Z', policy).toISOString()).toBe(
      '2026-11-01T12:00:00.000Z'
    );
  });
  test.each([
    { call_retries: 3 },
    { retry_minutes: 29 },
    { call_start_hour: 6 },
    { call_end_hour: 22 },
    { timezone: 'Unknown/Unknown' },
    { response_timeout_seconds: 0 },
  ])('rejects settings that break SRS guardrails: %j', (patch) => {
    expect(policySchema.safeParse({ ...defaults(), ...patch }).success).toBe(false);
  });
  test('does not invent STT confidence when provider supplies only text', () => {
    expect(transcriptionResult({ text: 'Câu trả lời' })).toEqual({
      text: 'Câu trả lời',
      confidence: null,
      confidence_source: null,
      needs_review: true,
    });
  });
  test('derives a labeled estimate from actual provider log probabilities', () => {
    const result = transcriptionResult({
      text: 'Câu trả lời',
      logprobs: [{ logprob: -1 }, { logprob: -1 }],
    });
    expect(result.confidence).toBeCloseTo(Math.exp(-1));
    expect(result.confidence_source).toBe('model_likelihood_estimate');
    expect(result.confidence).toBeLessThan(0.6);
  });
  test('marks provider no-speech recordings for review without discarding the transcript', () => {
    const result = transcriptionResult({
      text: 'Giữ để bác sĩ đối chiếu',
      segments: [{ avg_logprob: -0.1, no_speech_prob: 0.9, tokens: [1, 2] }],
    });
    expect(result.confidence).toBeCloseTo(Math.exp(-0.1));
    expect(result.needs_review).toBe(true);
    expect(result.text).toBe('Giữ để bác sĩ đối chiếu');
  });
});

describe('native IVR capabilities are bound to their own push channel and token', () => {
  const { tokenHash, compatibleDeviceTokens } = require('../src/services/doctor-ivr/ivr.devices');
  test('an Android upgrade cannot opt an older iOS token into doctor calls', () => {
    expect(
      compatibleDeviceTokens({
        fcm_token: 'new-android',
        voip_push_token: 'old-ios',
        doctor_ivr_fcm_hash: tokenHash('new-android'),
      })
    ).toEqual({ fcm: 'new-android', voip: null });
  });
  test('an iOS upgrade cannot opt an older Android token into doctor calls', () => {
    expect(
      compatibleDeviceTokens({
        fcm_token: 'old-android',
        voip_push_token: 'new-ios',
        doctor_ivr_voip_hash: tokenHash('new-ios'),
      })
    ).toEqual({ fcm: null, voip: 'new-ios' });
  });
  test('rotated push tokens cannot reuse another registration capability', () => {
    expect(
      compatibleDeviceTokens({ fcm_token: 'rotated', doctor_ivr_fcm_hash: tokenHash('previous') })
    ).toEqual({ fcm: null, voip: null });
    expect(compatibleDeviceTokens({ doctor_ivr_calls: true, fcm_token: 'legacy' })).toEqual({
      fcm: null,
      voip: null,
    });
  });
});
