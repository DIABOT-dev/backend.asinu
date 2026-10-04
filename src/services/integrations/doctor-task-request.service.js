'use strict';

const { screenRemoteCareSuitability, normalizeSpecialty } = require('./doctor-task.policy');
const { enqueueDoctorTask } = require('./doctor-task.service');
const { enqueueCrmEvent } = require('./crm-event.service');

async function loadPatientProjection(pool, userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.display_name, u.language_preference,
            u.consent_accepted_at, u.consent_version,
            u.updated_at AS profile_version, p.age AS age_group, p.gender
       FROM users u
       LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId]
  );
  return rows[0] || null;
}

async function requestDoctorTask(pool, userId, input) {
  const patient = await loadPatientProjection(pool, userId);
  if (!patient) return { kind: 'PATIENT_NOT_FOUND' };

  const screening = screenRemoteCareSuitability(input);
  if (!screening.suitable_for_remote_care) {
    return { kind: 'REMOTE_CARE_EMERGENCY_BLOCKED', screening };
  }

  // The form contains versioned consent. Persist it before creating the task
  // so the checkbox remains meaningful across devices and CRM projections.
  if (!patient.consent_accepted_at || patient.consent_version !== input.consent_version) {
    await pool.query(
      `UPDATE users
          SET consent_accepted_at = NOW(), consent_version = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL`,
      [input.consent_version, patient.id]
    );
    await enqueueCrmEvent(
      pool,
      'consent.updated',
      {
        user_id: String(patient.id),
        consent_type: 'privacy_policy',
        status: 'accepted',
        version: input.consent_version,
      },
      { event_id: `consent.updated:privacy_policy:${patient.id}:${input.consent_version}` }
    );
  }

  const result = await enqueueDoctorTask(pool, { user: patient, input });
  // Queue the CRM service-order projection beside the Doctor task.
  await enqueueCrmEvent(
    pool,
    'service.requested',
    {
      user_id: String(patient.id),
      app_user_id: String(patient.id),
      app_order_id: result.task_id,
      tenant_id: input.tenant_id,
      service_code: input.service_code,
      source_channel: input.source_channel,
      specialty: normalizeSpecialty(input.specialty),
      service_flow: input.service_flow,
      priority: input.priority,
      summary: input.summary,
      consent_status: 'accepted',
      consent_version: input.consent_version,
      patient_display_name: patient.display_name || patient.full_name || null,
      patient_age_group: patient.age_group == null ? null : String(patient.age_group),
      patient_gender: patient.gender || null,
      profile_version: patient.profile_version
        ? new Date(patient.profile_version).toISOString()
        : null,
      doctor_ref: input.preferred_doctor_id || null,
      medical_record_ref: input.medical_record_ref || null,
      expires_at: null,
    },
    { event_id: `service.requested:${result.task_id}`, correlation_id: result.task_id }
  );
  return { kind: 'CREATED', result };
}

module.exports = { requestDoctorTask };
