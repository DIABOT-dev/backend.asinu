const crypto = require('crypto');
const { assertTenantAllowed } = require('./doctor-task.service');
const { assertProfileRequest } = require('./doctor-profile.service');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
};

const hashClinicalContext = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

const buildDataQuality = (context) => {
  const missing = [];
  const conflicts = [];
  if (!context.profile.birth_year) missing.push('Chưa có năm sinh của bệnh nhân.');
  if (!context.profile.gender) missing.push('Chưa có giới tính của bệnh nhân.');
  if (!Array.isArray(context.profile.allergies) || !context.profile.allergies.length)
    missing.push('Chưa có thông tin dị ứng hoặc xác nhận không dị ứng.');
  if (!(context.medications || []).length)
    missing.push('Chưa có danh sách thuốc đang dùng hoặc xác nhận không dùng thuốc.');
  const medicationDoses = new Map();
  for (const medication of context.medications || []) {
    const key = String(medication.med_name || '').trim().toLocaleLowerCase('vi');
    if (!key) continue;
    const dose = String(medication.dose_text || '').trim();
    if (medicationDoses.has(key) && medicationDoses.get(key) !== dose)
      conflicts.push(`Thuốc ${medication.med_name} có nhiều thông tin liều khác nhau.`);
    medicationDoses.set(key, dose);
  }
  for (const measurement of context.blood_pressure || []) {
    if (Number(measurement.systolic) <= Number(measurement.diastolic))
      conflicts.push(`Chỉ số huyết áp lúc ${measurement.occurred_at} có tâm thu không lớn hơn tâm trương.`);
  }
  return { missing_data: [...new Set(missing)], conflicts: [...new Set(conflicts)] };
};

const loadDoctorClinicalContext = async (pool, input) => {
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  assertTenantAllowed(tenantId);
  const task = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id
       FROM doctor_task_outbox
      WHERE tenant_id = $1 AND payload->>'event_type' = 'doctor.task.requested'
        AND payload->'payload'->>'task_id' = $2 LIMIT 1`,
    [tenantId, taskId]
  );
  if (!task.rows[0] || task.rows[0].app_user_id !== appUserId) {
    throw integrationError(404, 'DOCTOR_TASK_NOT_FOUND', 'The Doctor task was not found.');
  }
  const [profile, bloodPressure, glucose, medication, symptoms, records, checkins, messages] =
    await Promise.all([
      pool.query(
        `SELECT p.birth_year, p.gender, p.daily_medication,
                COALESCE(p.medical_conditions, '[]'::jsonb) AS conditions,
                COALESCE(p.chronic_symptoms, '[]'::jsonb) AS chronic_symptoms,
                COALESCE(p.raw_profile->'allergies', '[]'::jsonb) AS allergies
           FROM user_onboarding_profiles p WHERE p.user_id = $1`,
        [appUserId]
      ),
      pool.query(
        `SELECT logs.systolic, logs.diastolic, logs.pulse, 'mmHg' AS unit, common.occurred_at
           FROM logs_common common JOIN blood_pressure_logs logs ON logs.log_id = common.id
          WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 30`,
        [appUserId]
      ),
      pool.query(
        `SELECT logs.value, logs.unit, logs.context, logs.meal_tag, common.occurred_at
           FROM logs_common common JOIN glucose_logs logs ON logs.log_id = common.id
          WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 30`,
        [appUserId]
      ),
      pool.query(
        `SELECT logs.med_name, logs.dose_text, logs.frequency_text, common.occurred_at
           FROM logs_common common JOIN medication_logs logs ON logs.log_id = common.id
          WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 30`,
        [appUserId]
      ),
      pool.query(
        `SELECT symptom_name, severity, occurred_date FROM symptom_logs
          WHERE user_id = $1 ORDER BY occurred_date DESC LIMIT 30`,
        [appUserId]
      ),
      pool.query(
        `SELECT record_type, diagnosis, summary, treatment, recorded_at
           FROM doctor_patient_medical_records WHERE user_id = $1
          ORDER BY recorded_at DESC LIMIT 30`,
        [appUserId]
      ),
      pool.query(
        `SELECT id, session_date, initial_status, current_status, flow_state,
                triage_summary, triage_severity, emergency_triggered, resolved_at, updated_at
           FROM health_checkins WHERE user_id = $1 ORDER BY session_date DESC LIMIT 12`,
        [appUserId]
      ),
      pool.query(
        `SELECT id, sender_type, sender_ref, message_type, content, created_at
           FROM doctor_task_messages
          WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 12`,
        [tenantId, taskId, appUserId]
      ),
    ]);
  const timelineMarkdown = await rebuildPatientHealthTimeline(pool, appUserId);
  const conversation = messages.rows
    .reverse()
    .map((message) => ({
      id: String(message.id),
      role: message.sender_type === 'patient' ? 'patient' : 'doctor',
      message: message.content,
      message_type: message.message_type,
      created_at: new Date(message.created_at).toISOString(),
    }));
  const latestPatientMessage =
    [...conversation].reverse().find((message) => message.role === 'patient') || null;
  const context = {
    profile: profile.rows[0] || {},
    blood_pressure: bloodPressure.rows,
    glucose: glucose.rows,
    medications: medication.rows,
    symptoms: symptoms.rows,
    medical_records: records.rows,
    checkins: checkins.rows,
    conversation,
    latest_patient_message: latestPatientMessage,
    health_timeline_markdown: timelineMarkdown,
  };
  const quality = buildDataQuality(context);
  const hashInput = {
    ...context,
    health_timeline_markdown: undefined,
    task_summary: input.task_summary || '',
    policy_version: input.clinical_support?.policy_version || '',
  };
  return {
    ...context,
    ...quality,
    context_version: latestPatientMessage?.id || '0',
    context_hash: hashClinicalContext(hashInput),
  };
};

module.exports = { buildDataQuality, hashClinicalContext, loadDoctorClinicalContext };
