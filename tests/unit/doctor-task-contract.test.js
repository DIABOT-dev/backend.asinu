const {
  buildDoctorTaskEnvelope,
  buildPatientRef,
  doctorTaskRequestSchema,
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
});
