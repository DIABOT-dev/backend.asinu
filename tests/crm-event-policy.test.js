const { buildCrmEnvelope } = require('../src/services/integrations/crm-event.service');
const {
  projectCrmPayload,
  stripContactPii,
} = require('../src/services/integrations/crm-event.policy');

describe('CRM event boundary', () => {
  test('projects health events to the contract allowlist', () => {
    expect(
      projectCrmPayload('health_log.created', {
        user_id: 'user-1',
        status: 'created',
        glucose: 7.2,
        medical_record: 'should-not-leave-asinu',
      })
    ).toEqual({
      user_id: 'user-1',
      status: 'created',
    });
  });

  test('keeps contact fields only for user profile events', () => {
    expect(
      buildCrmEnvelope('user.created', {
        userId: 'user-1',
        phone: '+84901234567',
        email: 'user@example.com',
        medicalRecord: 'should-not-leave-asinu',
      }).payload
    ).toEqual({
      user_id: 'user-1',
      phone: '+84901234567',
      email: 'user@example.com',
    });
  });

  test('projects check-in call operations without raw triage or medical details', () => {
    expect(
      projectCrmPayload('checkin_call.exhausted', {
        user_id: 'user-1',
        episode_id: 'episode-1',
        severity: 'URGENT',
        reason: 'MAX_DURATION',
        body_location: 'chest',
        symptom: 'shortness_of_breath',
        transcript: 'raw voice text',
      })
    ).toEqual({
      user_id: 'user-1',
      episode_id: 'episode-1',
      severity: 'URGENT',
      reason: 'MAX_DURATION',
    });
  });

  test('removes raw contact PII after successful delivery while preserving hashes', () => {
    expect(
      stripContactPii({
        nested: {
          phone: '+84901234567',
          emailAddress: 'user@example.com',
          phone_sha256: 'hash-value',
        },
      })
    ).toEqual({
      nested: { phone_sha256: 'hash-value' },
    });
  });
});
