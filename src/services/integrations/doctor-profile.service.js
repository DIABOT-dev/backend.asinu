const crypto = require('crypto');

const DOCTOR_SECRET = process.env.DOCTOR_ASINU_INTEGRATION_SECRET || '';
const MAX_SKEW_SECONDS = Number(process.env.DOCTOR_INTEGRATION_MAX_SKEW_SECONDS || 300);
const DEFAULT_TENANT_ID = process.env.DOCTOR_DEFAULT_TENANT_ID || 'clinic-demo';
const ALLOWED_TENANT_IDS = new Set(
  (process.env.DOCTOR_ALLOWED_TENANT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const isAllowedTenant = (tenantId) => {
  if (ALLOWED_TENANT_IDS.size > 0) return ALLOWED_TENANT_IDS.has(tenantId);
  return tenantId === DEFAULT_TENANT_ID;
};

const verifyDoctorSignature = (req) => {
  if (!DOCTOR_SECRET)
    throw integrationError(
      503,
      'DOCTOR_PROFILE_NOT_CONFIGURED',
      'Doctor profile integration is not configured.'
    );
  const timestamp = Number(req.headers['x-doctor-timestamp']);
  const received = String(req.headers['x-doctor-signature'] || '').replace(/^sha256=/i, '');
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}));
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SKEW_SECONDS
  ) {
    throw integrationError(
      401,
      'DOCTOR_PROFILE_SIGNATURE_EXPIRED',
      'Doctor profile signature is expired.'
    );
  }
  const expected = crypto
    .createHmac('sha256', DOCTOR_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  if (
    !received ||
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw integrationError(
      401,
      'DOCTOR_PROFILE_SIGNATURE_INVALID',
      'Doctor profile signature is invalid.'
    );
  }
};

const assertProfileRequest = (body) => {
  const tenantId = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';
  const appUserId = String(body?.app_user_id || '').trim();
  const taskId = typeof body?.task_id === 'string' ? body.task_id.trim() : '';
  if (!tenantId || !appUserId || !taskId) {
    throw integrationError(
      400,
      'INVALID_DOCTOR_PROFILE_REQUEST',
      'tenant_id, app_user_id and task_id are required.'
    );
  }
  if (!isAllowedTenant(tenantId)) {
    throw integrationError(
      403,
      'DOCTOR_TENANT_NOT_ALLOWED',
      'The requested Doctor tenant is not allowed.'
    );
  }
  return { tenantId, appUserId, taskId };
};

const loadPatientProfile = async (pool, req) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(req.body);
  const task = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->'payload'->>'task_id' = $2
      LIMIT 1`,
    [tenantId, taskId]
  );
  if (!task.rows[0] || task.rows[0].app_user_id !== appUserId) {
    throw integrationError(
      404,
      'DOCTOR_TASK_NOT_FOUND',
      'The requested Doctor task was not found.'
    );
  }

  const result = await pool.query(
    `SELECT u.id,
            p.gender, p.age, p.birth_year, p.date_of_birth,
            COALESCE(p.medical_conditions, '[]'::jsonb) AS medical_conditions,
            COALESCE(p.chronic_symptoms, '[]'::jsonb) AS chronic_symptoms,
            COALESCE(p.raw_profile, '{}'::jsonb) AS raw_profile,
            COALESCE(p.updated_at, u.updated_at, u.created_at) AS profile_version
       FROM users u
       LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [appUserId]
  );
  const patient = result.rows[0];
  if (!patient) throw integrationError(404, 'PATIENT_NOT_FOUND', 'Patient not found.');

  let age = null;
  if (patient.date_of_birth) {
    const birthDate = new Date(patient.date_of_birth);
    if (!Number.isNaN(birthDate.getTime())) {
      age = Math.max(0, new Date().getUTCFullYear() - birthDate.getUTCFullYear());
      const today = new Date();
      if (
        today.getUTCMonth() < birthDate.getUTCMonth() ||
        (today.getUTCMonth() === birthDate.getUTCMonth() &&
          today.getUTCDate() < birthDate.getUTCDate())
      )
        age -= 1;
    }
  } else if (patient.birth_year) {
    const birthYear = Number(patient.birth_year);
    if (
      Number.isInteger(birthYear) &&
      birthYear > 1900 &&
      birthYear <= new Date().getUTCFullYear()
    ) {
      age = new Date().getUTCFullYear() - birthYear;
    }
  }

  const records = await pool.query(
    `SELECT id, record_type, title, diagnosis, summary, treatment, notes,
            doctor_ref, source_task_id, recorded_at, created_at, updated_at
       FROM doctor_patient_medical_records
      WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 100`,
    [appUserId]
  );
  const files = await pool.query(
    `SELECT id, name, mime_type, size_bytes, secure_url, source_task_id,
            uploaded_by, created_at
       FROM doctor_patient_files
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [appUserId]
  );
  const consultationHistory = await pool.query(
    `WITH request_history AS (
      SELECT event_id,
             payload->>'event_type' AS event_type,
             payload->'payload'->>'task_id' AS task_id,
             COALESCE(payload->'payload'->>'status', 'queued') AS status,
             status AS delivery_status,
             payload->'payload'->>'service_code' AS service_code,
             payload->'payload'->>'specialty' AS specialty,
             payload->'payload'->>'service_flow' AS service_flow,
             payload->'payload'->>'priority' AS priority,
             payload->'payload'->>'summary' AS summary,
             COALESCE(payload->'payload'->>'doctor_name', payload->'payload'->>'doctor_ref', '—') AS doctor_name,
             COALESCE((payload->>'occurred_at')::timestamptz, created_at) AS date
        FROM doctor_task_outbox
       WHERE tenant_id = $1
         AND payload->>'event_type' = 'doctor.task.requested'
         AND payload->'payload'->>'app_user_id' = $2
    ), lifecycle_history AS (
      SELECT event_id, event_type, task_id, status, 'received' AS delivery_status,
             payload->>'service_code' AS service_code,
             payload->>'specialty' AS specialty,
             payload->>'service_flow' AS service_flow,
             payload->>'priority' AS priority,
             payload->>'summary' AS summary,
             COALESCE(doctor_ref, '—') AS doctor_name,
             occurred_at AS date
        FROM doctor_task_lifecycle_events
       WHERE tenant_id = $1 AND app_user_id = $2::integer
    )
    SELECT * FROM request_history
    UNION ALL
    SELECT * FROM lifecycle_history
    ORDER BY date DESC LIMIT 100`,
    [tenantId, appUserId]
  );
  const [bloodPressure, glucose, medications, symptoms] = await Promise.all([
    pool.query(
      `SELECT common.occurred_at, logs.systolic, logs.diastolic, logs.pulse, logs.unit
         FROM logs_common common
         JOIN blood_pressure_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1
        ORDER BY common.occurred_at DESC LIMIT 90`,
      [appUserId]
    ),
    pool.query(
      `SELECT common.occurred_at, logs.value, logs.unit, logs.context, logs.meal_tag
         FROM logs_common common
         JOIN glucose_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1
        ORDER BY common.occurred_at DESC LIMIT 90`,
      [appUserId]
    ),
    pool.query(
      `SELECT DISTINCT ON (LOWER(logs.med_name)) logs.med_name, logs.dose_text,
              logs.frequency_text, common.occurred_at
         FROM logs_common common
         JOIN medication_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1
        ORDER BY LOWER(logs.med_name), common.occurred_at DESC LIMIT 50`,
      [appUserId]
    ),
    pool.query(
      `SELECT symptom_name, severity, occurred_date
         FROM symptom_logs WHERE user_id = $1
        ORDER BY occurred_date DESC, id DESC LIMIT 50`,
      [appUserId]
    ),
  ]);

  const rawProfile =
    patient.raw_profile && typeof patient.raw_profile === 'object' ? patient.raw_profile : {};
  const allergies = Array.isArray(rawProfile.allergies)
    ? rawProfile.allergies.filter((item) => typeof item === 'string').slice(0, 50)
    : [];

  return {
    gender: patient.gender || null,
    age,
    consultation_history: consultationHistory.rows,
    medical_records: records.rows,
    medical_conditions: Array.isArray(patient.medical_conditions) ? patient.medical_conditions : [],
    chronic_symptoms: Array.isArray(patient.chronic_symptoms) ? patient.chronic_symptoms : [],
    allergies,
    medications: medications.rows,
    recent_symptoms: symptoms.rows,
    vitals: {
      blood_pressure: bloodPressure.rows.reverse(),
      glucose: glucose.rows.reverse(),
    },
    attachments: files.rows.map((file) => ({
      id: String(file.id),
      name: file.name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      size: `${Math.max(1, Math.round(Number(file.size_bytes) / 1024))} KB`,
      url: file.secure_url,
      source_task_id: file.source_task_id,
      uploaded_by: file.uploaded_by,
      created_at: file.created_at ? new Date(file.created_at).toISOString() : null,
    })),
    app_user_id: String(patient.id),
    profile_version: patient.profile_version
      ? new Date(patient.profile_version).toISOString()
      : null,
  };
};

const loadAuthorisedPatient = async (pool, body) => {
  const { tenantId, appUserId, taskId } = assertProfileRequest(body);
  const task = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id
       FROM doctor_task_outbox WHERE tenant_id = $1
        AND payload->'payload'->>'task_id' = $2 LIMIT 1`,
    [tenantId, taskId]
  );
  if (!task.rows[0] || task.rows[0].app_user_id !== appUserId) {
    throw integrationError(
      404,
      'DOCTOR_TASK_NOT_FOUND',
      'The requested Doctor task was not found.'
    );
  }
  return { tenantId, appUserId, taskId };
};

const createPatientFile = async (pool, req) => {
  verifyDoctorSignature(req);
  const { appUserId, taskId } = await loadAuthorisedPatient(pool, req.body);
  const { file_name, mime_type, size_bytes, content_base64, uploaded_by } = req.body || {};
  const content = typeof content_base64 === 'string' ? Buffer.from(content_base64, 'base64') : null;
  if (
    !file_name ||
    !mime_type ||
    !content ||
    content.length === 0 ||
    content.length > 10 * 1024 * 1024
  ) {
    throw integrationError(400, 'INVALID_PATIENT_FILE', 'A valid file up to 10 MB is required.');
  }
  if (Number(size_bytes) !== content.length) {
    throw integrationError(400, 'INVALID_PATIENT_FILE_SIZE', 'The file size is invalid.');
  }
  const { uploadBuffer } = require('../../services/media/cloudinary-upload.service');
  const uploaded = await uploadBuffer(content, {
    folder: process.env.CLOUDINARY_PATIENT_FILE_FOLDER || 'asinu/patient-files',
    resource_type: 'auto',
    use_filename: true,
    unique_filename: true,
  });
  const result = await pool.query(
    `INSERT INTO doctor_patient_files
      (user_id, name, mime_type, size_bytes, secure_url, public_id, source_task_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, mime_type, size_bytes, secure_url, source_task_id, uploaded_by, created_at`,
    [
      appUserId,
      String(file_name).slice(0, 255),
      mime_type,
      content.length,
      uploaded.secure_url,
      uploaded.public_id || null,
      taskId,
      uploaded_by || null,
    ]
  );
  return result.rows[0];
};

module.exports = {
  loadPatientProfile,
  createPatientFile,
  verifyDoctorSignature,
  assertProfileRequest,
};
