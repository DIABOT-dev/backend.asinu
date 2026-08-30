const { t, getLang } = require('../i18n');
const {
  doctorTaskRequestSchema,
  patientRatingRequestSchema,
  privacyRequestSchema,
  doctorRecommendationRequestSchema,
  patientMessageRequestSchema,
} = require('../services/integrations/doctor-task.policy');
const {
  enqueueDoctorTask,
  submitPatientRating,
  submitPrivacyRequest,
  requestDoctorRecommendations,
  requestDoctorTaskStatus,
} = require('../services/integrations/doctor-task.service');
const {
  listMessages,
  listPatientTasks,
  sendPatientMessage,
} = require('../services/integrations/doctor-messaging.service');

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
  if (!patient.consent_accepted_at || patient.consent_version !== parsed.data.consent_version) {
    return res.status(403).json({ ok: false, error: 'Doctor consultation consent is required.' });
  }

  const result = await enqueueDoctorTask(pool, { user: patient, input: parsed.data });
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
  listDoctorTasks,
  listDoctorMessages,
  createDoctorMessage,
};
