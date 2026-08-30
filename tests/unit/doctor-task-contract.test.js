const {
  buildDoctorTaskEnvelope,
  buildPatientRatingEnvelope,
  buildPrivacyRequestEnvelope,
  buildPatientRef,
  doctorRecommendationRequestSchema,
  doctorTaskRequestSchema,
  patientRatingRequestSchema,
  privacyRequestSchema,
  patientMessageRequestSchema,
  doctorMessageQuerySchema,
  doctorMessageSendSchema,
} = require('../../src/services/integrations/doctor-task.policy');

describe('ASINU -> Doctor task contract', () => {
  const input = {
    tenant_id: 'clinic-demo',
    specialty: 'general',
    service_flow: 'clinical',
    priority: 'high',
    summary: 'Người dùng yêu cầu được bác sĩ tư vấn.',
    consent_version: 'v1.0.0',
  };

  test('creates a tenant-scoped envelope from the authenticated user', () => {
    const envelope = buildDoctorTaskEnvelope({
      user: {
        id: 42,
        full_name: 'Nguyễn Văn A',
        age_group: '40-49',
        gender: 'Nam',
        profile_version: new Date('2026-08-22T10:00:00.000Z'),
      },
      input,
    });

    expect(envelope).toMatchObject({
      event_type: 'doctor.task.requested',
      source: 'asinu-backend',
      tenant_id: 'clinic-demo',
      payload: {
        app_user_id: '42',
        patient_ref: {
          app_user_id: '42',
          display_name: 'Nguyễn Văn A',
          age_group: '40-49',
          gender: 'Nam',
        },
        consent: { status: 'accepted', version: 'v1.0.0' },
      },
    });
    expect(envelope.payload.patient_ref.phone).toBeUndefined();
    expect(envelope.payload.patient_ref.email).toBeUndefined();
  });

  test('does not allow a caller to put arbitrary fields into the request', () => {
    expect(doctorTaskRequestSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
  });

  test('builds a bounded patient projection', () => {
    expect(buildPatientRef({ id: 7, full_name: 'Patient', phone: '0123456789' })).toEqual({
      app_user_id: '7',
      display_name: 'Patient',
      age_group: null,
      gender: null,
      profile_version: null,
    });
  });

  test('builds patient-owned rating events without exposing the user id in event metadata', () => {
    const ratingInput = patientRatingRequestSchema.parse({
      tenant_id: 'clinic-demo',
      score: 5,
      comment: 'Tư vấn rõ ràng',
      request_id: '10000000-0000-4000-8000-000000000001',
    });
    const envelope = buildPatientRatingEnvelope({
      userId: 42,
      taskId: 'task-1',
      input: ratingInput,
    });
    expect(envelope).toMatchObject({
      event_id: 'doctor.task.rating.submitted:10000000-0000-4000-8000-000000000001',
      tenant_id: 'clinic-demo',
      payload: { task_id: 'task-1', app_user_id: '42', score: 5 },
    });
    expect(envelope.event_id).not.toContain(':42:');
  });

  test('builds all supported privacy actions and keeps user identity inside the signed payload', () => {
    for (const action of ['withdraw_consent', 'export', 'anonymize', 'delete']) {
      const privacyInput = privacyRequestSchema.parse({
        tenant_id: 'clinic-demo',
        action,
        request_id: `20000000-0000-4000-8000-00000000000${
          ['withdraw_consent', 'export', 'anonymize', 'delete'].indexOf(action) + 1
        }`,
      });
      const envelope = buildPrivacyRequestEnvelope({ userId: 42, input: privacyInput });
      expect(envelope.payload).toMatchObject({ app_user_id: '42', action });
      expect(envelope.event_id).not.toContain('42');
    }
  });

  test('validates patient recommendation limits and rejects arbitrary fields', () => {
    expect(
      doctorRecommendationRequestSchema.safeParse({
        tenant_id: 'clinic-demo',
        specialty: 'general',
        service_flow: 'clinical',
        limit: 3,
      }).success
    ).toBe(true);
    expect(
      doctorRecommendationRequestSchema.safeParse({
        tenant_id: 'clinic-demo',
        specialty: 'general',
        service_flow: 'clinical',
        limit: 11,
      }).success
    ).toBe(false);
  });

  test('validates patient and signed Doctor message payloads', () => {
    const clientMessageId = '30000000-0000-4000-8000-000000000001';
    expect(
      patientMessageRequestSchema.safeParse({
        tenant_id: 'clinic-demo',
        content: 'Tôi đã đo lại huyết áp.',
        message_type: 'reply',
        client_message_id: clientMessageId,
      }).success
    ).toBe(true);
    expect(
      doctorMessageQuerySchema.safeParse({
        tenant_id: 'clinic-demo',
        task_id: 'task-1',
        app_user_id: '42',
      }).success
    ).toBe(true);
    expect(
      doctorMessageSendSchema.safeParse({
        tenant_id: 'clinic-demo',
        task_id: 'task-1',
        app_user_id: '42',
        sender_ref: 'doctor-1',
        content: 'Bạn vui lòng đo lại huyết áp.',
        message_type: 'question',
        client_message_id: clientMessageId,
      }).success
    ).toBe(true);
    expect(
      patientMessageRequestSchema.safeParse({
        tenant_id: 'clinic-demo',
        content: '',
        client_message_id: 'not-a-uuid',
      }).success
    ).toBe(false);
  });
});
