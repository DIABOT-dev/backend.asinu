const { t, getLang } = require('../i18n');
const {
  doctorTaskRequestSchema,
  patientRatingRequestSchema,
  privacyRequestSchema,
  doctorRecommendationRequestSchema,
  doctorDirectoryRequestSchema,
  doctorReviewsRequestSchema,
  patientMessageRequestSchema,
  messageActionSchema,
} = require('../services/integrations/doctor-task.policy');
const {
  submitPatientRating,
  submitPrivacyRequest,
  requestDoctorRecommendations,
  requestDoctorDirectory,
  requestDoctorDirectorySpecialties,
  requestDoctorReviews,
  requestDoctorSpecialties,
  requestDoctorClinics,
  listPrivacyReceipts,
} = require('../services/integrations/doctor-task.service');
const {
  listPatientTasks,
  messageAction,
} = require('../services/integrations/doctor-messaging.service');
const {
  requestDoctorTask: createDoctorTask,
} = require('../services/integrations/doctor-task-request.service');
const {
  listPatientConversation,
  sendPatientConversationMessage,
  sendPatientConversationAttachment,
  sendPatientConversationVoice,
} = require('../services/integrations/doctor-patient-conversation.service');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestDoctorTask = async (pool, req, res) => {
  const parsed = doctorTaskRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('error.invalid_data', getLang(req)),
      details: parsed.error.issues,
    });
  }

  const outcome = await createDoctorTask(pool, req.user.id, parsed.data);
  if (outcome.kind === 'PATIENT_NOT_FOUND') {
    return res.status(404).json({
      ok: false,
      error: t('error.patient_not_found', getLang(req)),
      code: 'PATIENT_NOT_FOUND',
    });
  }
  if (outcome.kind === 'REMOTE_CARE_EMERGENCY_BLOCKED') {
    return res.status(422).json({
      ok: false,
      error: t('doctor.remote_care_emergency_blocked', getLang(req)),
      code: 'REMOTE_CARE_EMERGENCY_BLOCKED',
      data: outcome.screening,
    });
  }
  return res.status(202).json({ ok: true, data: outcome.result });
};

const submitDoctorRating = async (pool, req, res) => {
  const parsed = patientRatingRequestSchema.safeParse(req.body);
  const taskId = String(req.params.taskId || '').trim();
  if (!parsed.success || !taskId || taskId.length > 160) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.invalid_rating_request', getLang(req)),
      code: 'INVALID_PATIENT_RATING_REQUEST',
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
      error: t('doctor.invalid_privacy_request', getLang(req)),
      code: 'INVALID_PRIVACY_REQUEST',
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
      error: t('doctor.invalid_recommendation_request', getLang(req)),
      code: 'INVALID_DOCTOR_RECOMMENDATION_REQUEST',
      details: parsed.error.issues,
    });
  }
  const result = await requestDoctorRecommendations({ input: parsed.data });
  return res.status(200).json({ ok: true, data: result });
};

const listDoctorDirectory = async (_pool, req, res) => {
  const parsed = doctorDirectoryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.invalid_recommendation_request', getLang(req)),
      code: 'INVALID_DOCTOR_DIRECTORY_REQUEST',
      details: parsed.error.issues,
    });
  }
  const result = await requestDoctorDirectory({ input: parsed.data });
  return res.status(200).json({ ok: true, data: result });
};

const listDoctorDirectorySpecialties = async (_pool, _req, res) =>
  res.json({ ok: true, data: await requestDoctorDirectorySpecialties() });

const listDoctorReviews = async (_pool, req, res) => {
  const parsed = doctorReviewsRequestSchema.safeParse({
    doctor_id: String(req.params.doctorId || '').trim(),
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('error.invalid_data', getLang(req)),
      code: 'INVALID_DOCTOR_REVIEWS_REQUEST',
      details: parsed.error.issues,
    });
  }
  return res.json({ ok: true, data: await requestDoctorReviews({ input: parsed.data }) });
};

const listDoctorSpecialties = async (_pool, req, res) => {
  const tenantId = String(req.body?.tenant_id || '').trim();
  if (!tenantId || tenantId.length > 120) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.tenant_required', getLang(req)),
      code: 'TENANT_REQUIRED',
    });
  }
  return res.json({ ok: true, data: await requestDoctorSpecialties({ tenantId }) });
};

const listDoctorClinics = async (_pool, _req, res) =>
  res.json({ ok: true, data: await requestDoctorClinics() });

const listDoctorTasks = async (pool, req, res) => {
  const tenantId = String(req.query.tenant_id || '').trim();
  if (!tenantId || tenantId.length > 120) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.tenant_required', getLang(req)),
      code: 'TENANT_REQUIRED',
    });
  }
  return res.json({ ok: true, data: await listPatientTasks(pool, req.user.id, tenantId) });
};

const listDoctorMessages = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const tenantId = String(req.query.tenant_id || '').trim();
  if (!taskId || taskId.length > 160 || !tenantId || tenantId.length > 120) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.task_tenant_required', getLang(req)),
      code: 'TASK_TENANT_REQUIRED',
    });
  }
  const data = await listPatientConversation(pool, tenantId, taskId, req.user.id);
  return res.json({ ok: true, data });
};

const sendTaskReadinessError = (error, req, res) => {
  if (error?.code !== 'DOCTOR_TASK_NOT_READY') return false;
  res.status(409).json({
    ok: false,
    error: t('doctor.task_not_ready', getLang(req)),
    code: error.code,
    retryable: true,
  });
  return true;
};

const createDoctorMessage = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const parsed = patientMessageRequestSchema.safeParse(req.body);
  if (!taskId || taskId.length > 160 || !parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.message_invalid', getLang(req)),
      code: 'INVALID_DOCTOR_MESSAGE',
      details: parsed.success ? undefined : parsed.error.issues,
    });
  }
  let data;
  try {
    data = await sendPatientConversationMessage(pool, {
      userId: req.user.id,
      taskId,
      input: parsed.data,
    });
  } catch (error) {
    if (sendTaskReadinessError(error, req, res)) return;
    throw error;
  }
  return res.status(data.duplicate ? 200 : 201).json({ ok: true, data });
};

const createDoctorAttachment = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const tenantId = String(req.query.tenant_id || req.body?.tenant_id || '').trim();
  const clientMessageId = String(req.headers['x-client-message-id'] || '').trim();
  if (
    !taskId ||
    taskId.length > 160 ||
    !tenantId ||
    tenantId.length > 120 ||
    !req.file ||
    !UUID_PATTERN.test(clientMessageId)
  ) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.attachment_required', getLang(req)),
      code: 'DOCTOR_ATTACHMENT_REQUIRED',
    });
  }
  let data;
  try {
    data = await sendPatientConversationAttachment(pool, {
      userId: req.user.id,
      taskId,
      tenantId,
      clientMessageId,
      file: req.file,
    });
  } catch (error) {
    if (sendTaskReadinessError(error, req, res)) return;
    throw error;
  }
  return res.status(data.duplicate ? 200 : 201).json({ ok: true, data });
};

const createDoctorVoice = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const tenantId = String(req.body?.tenant_id || req.query.tenant_id || '').trim();
  const clientMessageId = String(req.headers['x-client-message-id'] || '').trim();
  const durationMs = Number(req.body?.duration_ms || 0);
  if (
    !taskId ||
    taskId.length > 160 ||
    !tenantId ||
    tenantId.length > 120 ||
    !req.file ||
    !UUID_PATTERN.test(clientMessageId) ||
    !Number.isInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > 10 * 60 * 1000
  ) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.voice_required', getLang(req)),
      code: 'DOCTOR_VOICE_REQUIRED',
    });
  }
  let data;
  try {
    data = await sendPatientConversationVoice(pool, {
      userId: req.user.id,
      taskId,
      tenantId,
      clientMessageId,
      file: req.file,
      durationMs,
    });
  } catch (error) {
    if (sendTaskReadinessError(error, req, res)) return;
    throw error;
  }
  return res.status(data.duplicate ? 200 : 201).json({ ok: true, data });
};

const createDoctorMessageAction = async (pool, req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const tenantId = String(req.body?.tenant_id || req.query.tenant_id || '').trim();
  if (!taskId || taskId.length > 160 || !tenantId || tenantId.length > 120) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.task_required', getLang(req)),
      code: 'TASK_REQUIRED',
    });
  }
  const parsed = messageActionSchema.safeParse({ ...req.body, tenant_id: tenantId });
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: t('doctor.action_invalid', getLang(req)),
      code: 'INVALID_MESSAGE_ACTION',
      details: parsed.error.issues,
    });
  }
  const data = await messageAction(pool, {
    tenantId,
    taskId,
    userId: req.user.id,
    actorType: 'patient',
    actorRef: String(req.user.id),
    action: parsed.data.action,
    messageId: parsed.data.message_id,
    messageIds: parsed.data.message_ids,
    content: parsed.data.content,
    isTyping: parsed.data.is_typing,
  });
  return res.json({ ok: true, data });
};

module.exports = {
  requestDoctorTask,
  submitDoctorRating,
  requestDoctorPrivacy,
  recommendDoctor,
  listDoctorDirectory,
  listDoctorDirectorySpecialties,
  listDoctorReviews,
  listDoctorSpecialties,
  listDoctorClinics,
  listDoctorTasks,
  listDoctorMessages,
  createDoctorMessage,
  createDoctorAttachment,
  createDoctorVoice,
  createDoctorMessageAction,
  getDoctorPrivacyReceipts,
};
