const { t, getLang } = require('../i18n');
const {
  doctorTaskRequestSchema,
  patientRatingRequestSchema,
  privacyRequestSchema,
  doctorRecommendationRequestSchema,
  patientMessageRequestSchema,
  screenRemoteCareSuitability,
  normalizeSpecialty,
} = require('../services/integrations/doctor-task.policy');
const {
  enqueueDoctorTask,
  submitPatientRating,
  submitPrivacyRequest,
  requestDoctorRecommendations,
  requestDoctorSpecialties,
  requestDoctorTaskStatus,
  listPrivacyReceipts,
} = require('../services/integrations/doctor-task.service');
const {
  listMessages,
  listPatientTasks,
  sendPatientMessage,
} = require('../services/integrations/doctor-messaging.service');
const { enqueueCrmEvent } = require('../services/integrations/crm-event.service');

const loadPatientProjection = async (pool, userId) => {
  const result = await pool.query(
    `SELECT u.id, u.full_name, u.display_name, u.consent_accepted_at, u.consent_version,
            u.updated_at AS profile_version, p.age AS age_group, p.gender
       FROM users u
       LEFT JOIN user_onboarding_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId]
  );
  return result.rows[0] || null;
};

const requestDoctorTask = async (pool, req, res) => {
  const parsed = doctorTaskRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('error.invalid_data', getLang(req)),
      details: parsed.error.issues,
    });
  }

  const patient = await loadPatientProjection(pool, req.user.id);
  if (!patient) return res.status(404).json({ ok: false, error: 'Patient not found.' });
  const screening = screenRemoteCareSuitability(parsed.data);
  if (!screening.suitable_for_remote_care) {
    return res.status(422).json({
      ok: false,
      error:
        'Dấu hiệu có thể cần cấp cứu và không phù hợp để chờ tư vấn từ xa. Hãy gọi 115 hoặc đến cơ sở y tế gần nhất.',
      code: 'REMOTE_CARE_EMERGENCY_BLOCKED',
      data: screening,
    });
  }

  // The consultation form contains the explicit, versioned consent for this
  // data processing purpose. Older accounts may only have the device-local
  // consent flag and therefore have no consent row on the server yet. Persist
  // this consent here before creating the task so the checkbox is meaningful
  // across devices and the existing server-side guard remains effective.
  if (!patient.consent_accepted_at || patient.consent_version !== parsed.data.consent_version) {
    await pool.query(
      `UPDATE users
          SET consent_accepted_at = NOW(), consent_version = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL`,
      [parsed.data.consent_version, patient.id]
    );
    await enqueueCrmEvent(
      pool,
      'consent.updated',
      {
        user_id: String(patient.id),
        consent_type: 'privacy_policy',
        status: 'accepted',
        version: parsed.data.consent_version,
      },
      { event_id: `consent.updated:privacy_policy:${patient.id}:${parsed.data.consent_version}` },
    );
  }

  const result = await enqueueDoctorTask(pool, { user: patient, input: parsed.data });
  // The CRM owns the service-order projection. Queue the request alongside
  // the Doctor task so CRM can link the order to the same app user before the
  // Doctor sends back accepted/started/completed lifecycle events.
  await enqueueCrmEvent(
    pool,
    'service.requested',
    {
      user_id: String(patient.id),
      app_user_id: String(patient.id),
      app_order_id: result.task_id,
      service_code: parsed.data.service_code,
      source_channel: parsed.data.source_channel,
      specialty: normalizeSpecialty(parsed.data.specialty),
      service_flow: parsed.data.service_flow,
      priority: parsed.data.priority,
      summary: parsed.data.summary,
      consent_status: 'accepted',
      consent_version: parsed.data.consent_version,
      patient_display_name: patient.display_name || patient.full_name || null,
      patient_age_group: patient.age_group == null ? null : String(patient.age_group),
      patient_gender: patient.gender || null,
      profile_version: patient.profile_version ? new Date(patient.profile_version).toISOString() : null,
      doctor_ref: parsed.data.preferred_doctor_id || null,
      medical_record_ref: parsed.data.medical_record_ref || null,
      expires_at: null,
    },
    { event_id: `service.requested:${result.task_id}`, correlation_id: result.task_id },
  );
  return res.status(202).json({ ok: true, data: result });
};

const submitDoctorRating = async (pool, req, res) => {
  const parsed = patientRatingRequestSchema.safeParse(req.body);
  const taskId = String(req.params.taskId || '').trim();
  if (!parsed.success || !taskId || taskId.length > 160) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid patient rating request.',
      details: parsed.success ? undefined : parsed.error.issues,
    });
  }
  const result = await submitPatientRating(pool, {
    userId: req.user.id,
    taskId,
    input: parsed.data,
  });
  return res.status(200).json({ ok: true, data: result });
};

const requestDoctorPrivacy = async (pool, req, res) => {
  const parsed = privacyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid privacy request.',
      details: parsed.error.issues,
    });
  }
  const result = await submitPrivacyRequest(pool, { userId: req.user.id, input: parsed.data });
  return res.status(200).json({ ok: true, data: result });
};

const getDoctorPrivacyReceipts = async (pool, req, res) =>
  res.json({ ok: true, data: await listPrivacyReceipts(pool, req.user.id) });

const recommendDoctor = async (_pool, req, res) => {
  const parsed = doctorRecommendationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Doctor recommendation request.',
      details: parsed.error.issues,
    });
  }
  const result = await requestDoctorRecommendations({ input: parsed.data });
  return res.status(200).json({ ok: true, data: result });
};

const listDoctorSpecialties = async (_pool, req, res) => {
  const tenantId = String(req.body?.tenant_id || '').trim();
  if (!tenantId || tenantId.length > 120) {
    return res.status(400).json({ ok: false, error: 'A valid tenant_id is required.' });
  }
  return res.json({ ok: true, data: await requestDoctorSpecialties({ tenantId }) });
};

const listDoctorTasks = async (pool, req, res) => {
  const tenantId = String(req.query.tenant_id || '').trim();
  if (!tenantId || tenantId.length > 120) {
    return res.status(400).json({ ok: false, error: 'A valid tenant_id is required.' });
  }
  return res.json({ ok: true, data: await listPatientTasks(pool, req.user.id, tenantId) });
};

const listDoctorMessages = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const tenantId = String(req.query.tenant_id || '').trim();
  if (!taskId || taskId.length > 160 || !tenantId || tenantId.length > 120) {
    return res
      .status(400)
      .json({ ok: false, error: 'A valid task id and tenant_id are required.' });
  }
  const data = await listMessages(pool, tenantId, taskId, req.user.id);
  let taskStatus = null;
  try {
    taskStatus = await requestDoctorTaskStatus({
      input: { tenant_id: tenantId, task_id: taskId, app_user_id: String(req.user.id) },
    });
  } catch {
    // Conversation history remains available during a temporary Doctor outage.
  }
  return res.json({ ok: true, data: { ...data, task_status: taskStatus } });
};

const createDoctorMessage = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const parsed = patientMessageRequestSchema.safeParse(req.body);
  if (!taskId || taskId.length > 160 || !parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Doctor message.',
      details: parsed.success ? undefined : parsed.error.issues,
    });
  }
  const data = await sendPatientMessage(pool, {
    userId: req.user.id,
    taskId,
    input: parsed.data,
  });
  return res.status(data.duplicate ? 200 : 201).json({ ok: true, data });
};

module.exports = {
  requestDoctorTask,
  submitDoctorRating,
  requestDoctorPrivacy,
  recommendDoctor,
  listDoctorSpecialties,
  listDoctorTasks,
  listDoctorMessages,
  createDoctorMessage,
  getDoctorPrivacyReceipts,
};
