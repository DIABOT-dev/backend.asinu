const { isPatientDeletionRace } = require('../src/services/integrations/doctor-lifecycle.service');

describe('Doctor lifecycle privacy deletion race', () => {
  test('recognizes lifecycle FK failures caused by a deleted patient', () => {
    expect(
      isPatientDeletionRace({
        code: '23503',
        constraint: 'doctor_task_lifecycle_events_app_user_id_fkey',
      })
    ).toBe(true);
    expect(
      isPatientDeletionRace({
        code: '23503',
        constraint: 'doctor_patient_medical_records_user_id_fkey',
      })
    ).toBe(true);
  });

  test('does not hide unrelated database integrity failures', () => {
    expect(isPatientDeletionRace({ code: '23503', constraint: 'other_foreign_key' })).toBe(false);
    expect(isPatientDeletionRace({ code: '23505', constraint: 'doctor_task_lifecycle_events_app_user_id_fkey' })).toBe(false);
  });
});
