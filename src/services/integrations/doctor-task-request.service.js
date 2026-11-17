'use strict';

const { screenRemoteCareSuitability, normalizeSpecialty } = require('./doctor-task.policy');
const { enqueueDoctorTask } = require('./doctor-task.service');
const { enqueueCrmEvent } = require('./crm-event.service');
const { evaluateConsultationScreening } = require('./doctor-screening.service');
const { t } = require('../../i18n');
const { reserveConsultationCredit } = require('../payment/consultation-credit.service');

async function loadPatientProjection(pool, userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.display_name, u.language_preference,
            u.consent_accepted_at, u.consent_version,
            u.updated_at AS profile_version, p.age AS age_group, p.gender,
            p.birth_year, p.medical_conditions
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

  if (!input.clinical_intake?.screening_answers) return { kind: 'CONSULTATION_SCREENING_REQUIRED' };
  const assessment = evaluateConsultationScreening(
    {
      summary: input.summary,
      answers: input.clinical_intake.screening_answers,
      locale: input.clinical_intake.screening_locale || 'vi',
    },
    patient
  );
  if (!assessment.suitable_for_remote_care) {
    return { kind: 'CONSULTATION_SCREENING_REQUIRED', screening: assessment };
  }
  const record = assessment.recorded_answers
    .map((answer) => `${answer.question}: ${answer.answers.join('; ')}`)
    .join('\n');
  const riskLabel = t(
    `doctor.screening.risk.${assessment.risk_level}`,
    input.clinical_intake.screening_locale || 'vi'
  );
  const summary = `${input.summary.trim()}\n\n${assessment.message}\n${record}\n${riskLabel}`;
  if (summary.length > 5000) {
    const error = new Error('Consultation description is too long.');
    error.statusCode = 400;
    error.code = 'INVALID_SCREENING_ANSWER';
    throw error;
  }
  input = {
    ...input,
    summary,
    priority: assessment.risk_level === 'high' ? 'high' : 'normal',
    clinical_intake: { ...input.clinical_intake, ...assessment.intake },
    screening_result: {
      emergency: false,
      suitable_for_remote_care: true,
      reason: `consultation_screened_${assessment.risk_level}`,
      screened_at: assessment.screened_at,
      screening_version: assessment.screening_version,
    },
  };

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const activePatient = await db.query(
      'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE',
      [userId]
    );
    if (!activePatient.rows[0]) {
      await db.query('ROLLBACK');
      return { kind: 'PATIENT_NOT_FOUND' };
    }
    if (input.previous_task_id) {
      const previous = await db.query(
        `SELECT payload FROM doctor_task_outbox WHERE tenant_id=$1
        AND payload->'payload'->>'task_id'=$2 AND payload->'payload'->>'app_user_id'=$3`,
        [input.tenant_id, input.previous_task_id, String(userId)]
      );
      if (!previous.rows[0])
        throw Object.assign(new Error('The previous consultation was not found.'), {
          statusCode: 404,
          code: 'DOCTOR_TASK_NOT_FOUND',
        });
      const { requestDoctorTaskStatus } = require('./doctor-task.service');
      const status = await requestDoctorTaskStatus({
        input: {
          tenant_id: input.tenant_id,
          app_user_id: String(userId),
          task_id: input.previous_task_id,
        },
      });
      if (status.status !== 'completed')
        throw Object.assign(new Error('Complete the previous consultation first.'), {
          statusCode: 409,
          code: 'DOCTOR_PREVIOUS_TASK_OPEN',
        });
    }
    // The form contains versioned consent. Persist it before creating the task
    // so the checkbox remains meaningful across devices and CRM projections.
    if (!patient.consent_accepted_at || patient.consent_version !== input.consent_version) {
      await db.query(
        `UPDATE users
          SET consent_accepted_at = NOW(), consent_version = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL`,
        [input.consent_version, patient.id]
      );
      await enqueueCrmEvent(
        db,
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

    const credit = await reserveConsultationCredit(db, userId, input.tenant_id, input.task_id);
    if (['consumed', 'released'].includes(credit.state)) {
      const original = await db.query(
        `SELECT 1 FROM doctor_task_outbox WHERE tenant_id=$1
        AND payload->'payload'->>'task_id'=$2 AND payload->'payload'->>'app_user_id'=$3`,
        [input.tenant_id, input.task_id, String(userId)]
      );
      if (!original.rows[0])
        throw Object.assign(
          new Error(
            t('doctor.consultation_closed', input.clinical_intake.screening_locale || 'vi')
          ),
          { statusCode: 409, code: 'DOCTOR_TASK_CLOSED' }
        );
    }
    input = { ...input, credit_state: credit.state === 'none' ? 'none' : 'reserved' };
    const result = await enqueueDoctorTask(db, { user: patient, input });
    // Queue the CRM service-order projection beside the Doctor task.
    await enqueueCrmEvent(
      db,
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
        dispatch_owner: 'app',
        credit_state: input.credit_state,
        previous_task_id: input.previous_task_id || null,
        consent_status: 'accepted',
        consent_version: input.consent_version,
        profile_version: patient.profile_version
          ? new Date(patient.profile_version).toISOString()
          : null,
        doctor_ref: input.preferred_doctor_id || null,
        medical_record_ref: input.medical_record_ref || null,
        expires_at: null,
      },
      { event_id: `service.requested:${result.task_id}`, correlation_id: result.task_id }
    );
    if (credit.householdId)
      await require('./crm-domain-events.service').enqueueHouseholdEntitlements(
        db,
        credit.householdId
      );
    await db.query('COMMIT');
    if (credit.householdId) {
      const { invalidateHouseholdEntitlements } = require('../payment/entitlement.service');
      await invalidateHouseholdEntitlements(pool, credit.householdId);
    }
    return { kind: 'CREATED', result: { ...result, credit } };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

module.exports = { requestDoctorTask, loadPatientProjection };
