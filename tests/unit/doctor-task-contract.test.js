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
  doctorAiAssistSchema,
  screenRemoteCareSuitability,
} = require('../../src/services/integrations/doctor-task.policy');
const {
  isDoctorTaskMessageable,
} = require('../../src/services/integrations/doctor-messaging.service');

describe('ASINU -> Doctor task contract', () => {
  const input = {
    tenant_id: 'clinic-demo',
    specialty: 'general',
    service_flow: 'clinical',
    priority: 'high',
    summary: 'Người dùng yêu cầu được bác sĩ tư vấn.',
    clinical_intake: {
      symptom_onset: 'today',
      progression: 'stable',
      severity: 'mild',
      emergency_confirmation: true,
    },
    consent_version: 'v1.0.0',
    task_id: 'doctor-task:42:retry-safe',
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

  test('blocks emergency red flags from the remote-care workflow', () => {
    expect(
      screenRemoteCareSuitability({ summary: 'Bệnh nhân đau ngực dữ dội và khó thở dữ dội.' })
    ).toMatchObject({
      emergency: true,
      suitable_for_remote_care: false,
      reason: 'emergency_red_flag',
    });
    expect(screenRemoteCareSuitability(input)).toMatchObject({
      emergency: false,
      suitable_for_remote_care: true,
    });
    expect(
      screenRemoteCareSuitability({
        summary: 'Đau đầu nhẹ, không có dấu hiệu cấp cứu và không khó thở dữ dội.',
        clinical_intake: input.clinical_intake,
      })
    ).toMatchObject({ emergency: false, suitable_for_remote_care: true });
  });

  test('builds a bounded patient projection', () => {
    expect(buildPatientRef({ id: 7, full_name: 'Patient', phone: '0123456789' })).toEqual({
      app_user_id: '7',
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
        confirmation: 'CONFIRM_DOCTOR_DATA_REQUEST',
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
    expect(
      doctorAiAssistSchema.safeParse({
        tenant_id: 'clinic-demo',
        task_id: 'task-1',
        app_user_id: '42',
        task_summary: 'Review the latest blood-pressure trend.',
        touchpoint: 'auto_triage',
        locale: 'en',
      }).success
    ).toBe(true);
  });

  test('keeps the ASINU message boundary closed after terminal Doctor lifecycle states', () => {
    const now = new Date('2026-09-14T10:00:00.000Z');
    expect(isDoctorTaskMessageable({ status: 'cancelled' }, 'follow_up', now)).toBe(false);
    expect(isDoctorTaskMessageable({ status: 'expired' }, 'follow_up', now)).toBe(false);
    expect(
      isDoctorTaskMessageable(
        { status: 'completed', followUpUntil: '2026-09-14T10:00:01.000Z' },
        'follow_up',
        now
      )
    ).toBe(true);
    expect(
      isDoctorTaskMessageable(
        { status: 'completed', followUpUntil: '2026-09-14T10:00:01.000Z' },
        'question',
        now
      )
    ).toBe(false);
    expect(
      isDoctorTaskMessageable({ status: 'completed', followUpUntil: null }, 'follow_up', now)
    ).toBe(false);
  });
});
