const { getSecret, keyringEnabled } = require('../../security/openbao-keyring.cjs');
('use strict');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const logger = require('../../lib/logger');
const { compatibleDeviceTokens } = require('./ivr.devices');
const { inspectRecording } = require('./recording');
const { isAudioBuffer } = require('../../middleware/upload.middleware');
const { questionSpeech, spokenQuestion } = require('./question-speech');
const { audioVersion, synthesizeText } = require('../checkin-call/audio.service');
const { questionSetChanges } = require('./question-set.diff');
const { patientPolicy, nextEvening, nextCallTime, questionFingerprint } = require('./ivr.policy');
const { reportFlags, asksForMoreInformation } = require('./content-quality');
const { draftPatientReply, intakeAnswers } = require('./reply-drafting');
const { uploadBuffer, deleteAsset } = require('../media/cloudinary-upload.service');
const { authenticatedAssetUrl, requirePrivateDeliveryConfig } = require('../media/private-media.service');
const {
  validateQuestionSet,
  nextQuestion,
  materializeGeneratedQuestions,
} = require('./question-set.schema');
const { assertTenantAllowed } = require('../integrations/doctor-task.service');
const {
  loadOwnedTask,
  insertIvrQuestionMessage,
} = require('../integrations/doctor-messaging.service');
const { broadcastChatEvent, broadcastIvrInvitationChange } = require('../integrations/doctor-chat-realtime');
const { hasAiConsent: mayProcessAi, withAiUser } = require('../ai/ai-consent.service');
const { callTextAi } = require('../ai/ai.service');
const { getWhisperTranscription } = require('../ai/providers/openai');
const { isAiTimeout } = require('../ai/checkin-wait-policy.service');
const { loadDoctorClinicalContext } = require('../integrations/doctor-context.service');
const {
  resolveCommunicationStyle,
  communicationConflict,
} = require('../integrations/doctor-communication-style');
const {
  generationSystem,
  questionSetOutputInstruction,
  initialQuestionCountInstruction,
  supplementQuestionCountInstruction,
  questionGenerationFeedback,
  repairSystem,
  guidedRepairSystem,
  compoundRepairTargets,
  guidedQuestionRepairTargets,
  applyQuestionTextRepairs,
  applyGuidedQuestionRepairs,
  buildQuestionGenerationContext,
  supplementRequestInstruction,
  supplementRevisionInstruction,
  supplementRevisionInput,
} = require('./question-generation');
const error = (code, message, statusCode = 409) =>
  Object.assign(new Error(message), { code, statusCode });
const enabled = () => process.env.DOCTOR_IVR_ENABLED === 'true';
const answerAudioPrefix = 'answer:';
const MAX_SUPPLEMENT_ROUNDS = 3;
const SUPPLEMENT_GENERATION_TIMEOUT_MS = 90_000;
const patientAudioJobs = new Map();
function key() {
  const value = keyringEnabled()
    ? getSecret('doctor-ivr')
    : process.env.DOCTOR_IVR_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw error('IVR_NOT_CONFIGURED', 'IVR encryption is not configured.', 503);
  return Buffer.from(value, 'hex');
}
function seal(user, kind, value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`${user}:${kind}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
function reveal(user, kind, value) {
  if (value == null) return null;
  const data = Buffer.from(value, 'base64url'),
    decipher = crypto.createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${user}:${kind}`));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
  );
}
function assertEnabled() {
  if (!enabled()) throw error('IVR_DISABLED', 'Tính năng thu thập thông tin chưa được bật.', 404);
  key();
}
async function transaction(pool, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
async function scope(pool, input) {
  assertEnabled();
  assertTenantAllowed(input.tenant_id);
  const user = Number(input.app_user_id);
  if (!Number.isSafeInteger(user) || user < 1 || !input.task_id)
    throw error('IVR_INVALID_SCOPE', 'Thông tin ca không hợp lệ.', 400);
  const task = await loadOwnedTask(pool, input.tenant_id, input.task_id, user);
  const owner = (
    await pool.query('SELECT id, language_preference FROM users WHERE id=$1 AND deleted_at IS NULL', [user])
  ).rows[0];
  if (!owner) throw error('IVR_NOT_FOUND', 'Không tìm thấy phiên.', 404);
  const privacy = (
    await pool.query(
      "SELECT action FROM doctor_privacy_request_receipts WHERE user_id=$1 AND tenant_id=$2 AND action IN ('grant_consent','withdraw_consent','anonymize','delete') AND status IN ('processing','completed') ORDER BY created_at DESC LIMIT 1",
      [user, input.tenant_id]
    )
  ).rows[0];
  if (privacy && privacy.action !== 'grant_consent')
    throw error('IVR_CONSENT_WITHDRAWN', 'Quyền chia sẻ hồ sơ đã được thu hồi.', 403);
  return {
    user,
    task,
    tenant: input.tenant_id,
    taskId: input.task_id,
    language: owner.language_preference === 'en' ? 'en' : 'vi',
  };
}
async function audit(db, s, actor, type, detail = {}, sessionId = null) {
  await db.query(
    'INSERT INTO doctor_ivr_events(id,session_id,tenant_id,task_id,user_id,actor,event_type,detail_enc) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
    [
      crypto.randomUUID(),
      sessionId,
      s.tenant_id || s.tenant,
      s.task_id || s.taskId,
      s.user_id || s.user,
      actor,
      type,
      seal(s.user_id || s.user, 'event', detail),
    ]
  );
}
async function getSession(db, id, user, lock = false) {
  const row = (
    await db.query(
      `SELECT s.*,q.content_enc,q.version,q.source,q.created_by FROM doctor_ivr_sessions s JOIN doctor_ivr_question_sets q ON q.id=s.question_set_id WHERE s.id=$1 AND s.user_id=$2 ${lock ? 'FOR UPDATE OF s' : ''}`,
      [id, user]
    )
  ).rows[0];
  if (!row) throw error('IVR_NOT_FOUND', 'Không tìm thấy phiên.', 404);
  return row;
}
function mediaSignature(id, expires, actor) {
  return crypto
    .createHmac('sha256', key())
    .update(`ivr-audio:${id}:${expires}:${actor}`)
    .digest('hex');
}
function audioUrl(id, actor) {
  const expires = Math.floor(Date.now() / 1000) + 900;
  return `/api/doctor/ivr/media/${id}?expires=${expires}&actor=${encodeURIComponent(actor)}&signature=${mediaSignature(id, expires, actor)}`;
}
async function loadActiveAnswers(db, s, actor) {
  const { rows } = await db.query(
    `SELECT id, question_id, option_id, answer_type, audio_enc IS NOT NULL AS has_audio,
           audio_duration_s, transcript_enc, stt_confidence, stt_status, stt_needs_review,
           is_red_flag, skip_reason, answered_at
      FROM doctor_ivr_answers WHERE session_id=$1 AND active ORDER BY answered_at`,
    [s.id]
  );
  return rows.map((a) => ({
    id: a.id,
    question_id: a.question_id,
    option_id: a.option_id,
    answer_type: a.answer_type,
    audio_url: a.has_audio && actor ? audioUrl(a.id, actor) : null,
    audio_duration_s: a.audio_duration_s == null ? null : Number(a.audio_duration_s),
    transcript: reveal(s.user_id, 'transcript', a.transcript_enc),
    stt_confidence: a.stt_confidence == null ? null : Number(a.stt_confidence),
    stt_confidence_source: a.stt_confidence == null ? null : 'model_likelihood_estimate',
    stt_status: a.stt_status,
    needs_review:
      a.answer_type === 'voice' &&
      a.has_audio &&
      (a.stt_status === 'failed' ||
        (a.stt_status === 'done' &&
          (a.stt_needs_review || a.stt_confidence === null || Number(a.stt_confidence) < 0.6))),
    is_red_flag: a.is_red_flag,
    skip_reason: a.skip_reason,
    answered_at: a.answered_at,
  }));
}

async function serialize(db, s, { doctor = false, actor = String(s.user_id) } = {}) {
  const content = reveal(s.user_id, 'question-set', s.content_enc);
  const reply = reveal(s.user_id, 'reply', s.reply_enc);
  const answers = await loadActiveAnswers(db, s, actor);
  const report = (await db.query('SELECT * FROM doctor_ivr_reports WHERE session_id=$1', [s.id]))
    .rows[0];
  const reportValue = doctor && report ? reveal(s.user_id, 'report', report.report_enc) : null;
  if (reportValue) {
    const history = (
      await db.query(
        "SELECT detail_enc FROM doctor_ivr_events WHERE session_id=$1 AND event_type='red_flag.detected' ORDER BY created_at",
        [s.id]
      )
    ).rows.map((e) => reveal(s.user_id, 'event', e.detail_enc));
    Object.assign(reportValue, reportFlags(history, answers, content));
  }
  if (reportValue)
    reportValue.has_late_updates = answers.some(
      (a) =>
        a.answer_type === 'voice' &&
        a.transcript &&
        reportValue.answers?.find((v) => v.question_id === a.question_id)?.answer !== a.transcript
    );
  const patientContent = {
    ...content,
    questions: content.questions.map((q) => ({
      ...q,
      speech_text: questionSpeech(content, q.id),
      options: q.options.map(
        ({ red_flag: _redFlag, suggested_red_flag: _suggestedRedFlag, ...o }) => o
      ),
    })),
  };
  return {
    safety_notice: answers.some((a) => a.is_red_flag)
      ? s.policy?.safety_message || String(process.env.DOCTOR_IVR_SAFETY_MESSAGE || '')
      : null,
    response_timeout_seconds: s.policy?.response_timeout_seconds || 10,
    id: s.id,
    task_id: s.task_id,
    question_set_id: s.question_set_id,
    version: s.version,
    doctor_name: s.doctor_name,
    status: s.status,
    channel: s.channel,
    current_question_id: s.current_question_id,
    revision: s.revision,
    updated_at: s.updated_at,
    sent_at: s.sent_at,
    expires_at: s.expires_at,
    started_at: s.started_at,
    completed_at: s.completed_at,
    remind_at: s.remind_at,
    is_supplement: s.is_supplement,
    content: doctor ? content : patientContent,
    answers,
    report: doctor && report ? { ...reportValue, ai_status: report.ai_status } : null,
    doctor_reply: typeof reply === 'string' ? reply : null,
    ...(reply?.public_id ? {
      doctor_reply_video: { url: replyVideoUrl(reply.public_id) },
    } : {}),
    replied_at: s.replied_at,
  };
}
async function readIvrPatientProfile(pool, userId) {
  const { rows: [profile] } = await pool.query(
    'SELECT birth_year, age, gender, date_of_birth::text AS date_of_birth FROM user_onboarding_profiles WHERE user_id=$1',
    [userId]
  );
  return profile;
}
function assertTaskOpen(task) {
  if (['completed', 'cancelled', 'expired', 'emergency_referred', 'forwarded'].includes(
    task.lifecycle_status
  ))
    throw error('IVR_TASK_CLOSED', 'Ca tư vấn đã kết thúc.');
}

async function taskIvrSessions(db, { tenant, taskId, user }) {
  const { rows } = await db.query(
    'SELECT id, is_supplement, status FROM doctor_ivr_sessions WHERE tenant_id=$1 AND task_id=$2 AND user_id=$3 ORDER BY created_at DESC,id DESC',
    [tenant, taskId, user]
  );
  return rows;
}

const deliveredSessions = (sessions) =>
  sessions.filter((session) => !['cancelled', 'unreachable'].includes(session.status));

const supplementCount = (sessions) => sessions.filter((session) => session.is_supplement).length;

const canStartSupplement = (sessions) =>
  ['reported', 'expired'].includes(sessions[0]?.status) &&
  supplementCount(sessions) < MAX_SUPPLEMENT_ROUNDS &&
  !sessions.some((session) => ['replied', 'closed'].includes(session.status));

function assertReplySession(latest, sessionId) {
  if (!latest || latest.id !== sessionId)
    throw error('IVR_NEWER_SESSION', 'Cần xem câu trả lời của lượt mới nhất.');
  if (!['reported', 'expired'].includes(latest.status))
    throw error('IVR_REPORT_NOT_READY', 'Chưa có báo cáo để trả lời.');
}

function replyVideoUrl(publicId) {
  try {
    return authenticatedAssetUrl(publicId, 'video', 'authenticated', 'video/mp4');
  } catch {
    return null;
  }
}

function readReplyVideo({ mime_type: mimeType, video_base64: base64 }) {
  const bytes = Buffer.from(base64, 'base64');
  const validHeader = mimeType === 'video/mp4'
    ? bytes.subarray(4, 8).toString('ascii') === 'ftyp'
    : bytes.subarray(0, 4).toString('hex') === '1a45dfa3';
  if (!validHeader || bytes.length < 12 || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== base64)
    throw error('IVR_INVALID_REPLY_VIDEO', 'Video không hợp lệ hoặc lớn hơn 10 MB.', 400);
  return bytes;
}

async function uploadReplyVideo(bytes) {
  try {
    requirePrivateDeliveryConfig();
    return await uploadBuffer(bytes, {
      folder: 'asinu/consultation-replies',
      resource_type: 'video',
      type: 'authenticated',
      format: 'mp4',
      transformation: { video_codec: 'h264', audio_codec: 'aac' },
      media_metadata: true,
      timeout: 60_000,
    });
  } catch {
    throw error('IVR_REPLY_VIDEO_UNAVAILABLE', 'Chưa gửi được video. Vui lòng thử lại.', 503);
  }
}

async function serializeIntake(pool, s, actor, sessions) {
  return Promise.all(
    sessions.map(async ({ id }) =>
      serialize(pool, await getSession(pool, id, s.user), { doctor: true, actor })
    )
  );
}

async function loadConsultationIvrIntake(pool, scope) {
  if (!enabled()) return [];
  const sessions = deliveredSessions(await taskIvrSessions(pool, scope));
  const history = await Promise.all(sessions.toReversed().map(async ({ id, is_supplement }) => {
    const session = await getSession(pool, id, scope.user);
    const answers = await loadActiveAnswers(pool, session);
    return {
      is_supplement,
      answers: intakeAnswers({
        content: reveal(scope.user, 'question-set', session.content_enc),
        answers,
      }),
    };
  }));
  return history.filter((session) => session.answers.length);
}

async function listQuestionSets(pool, { tenant, taskId, user }) {
  const { rows } = await pool.query(
    `SELECT q.id, q.version, q.status, q.source, q.content_enc,
            saved.detail_enc AS saved_event, prior.event_type AS prior_type,
            prior.detail_enc AS prior_event
       FROM doctor_ivr_question_sets q
       LEFT JOIN LATERAL (
         SELECT e.detail_enc
           FROM doctor_ivr_events e
          WHERE e.tenant_id=q.tenant_id AND e.task_id=q.task_id AND e.user_id=q.user_id
            AND e.actor=q.created_by AND e.event_type='question_set.saved'
            AND e.created_at=q.created_at AND q.status='draft'
          ORDER BY e.id DESC LIMIT 1
       ) saved ON true
       LEFT JOIN LATERAL (
         SELECT e.event_type, e.detail_enc
           FROM doctor_ivr_events e
          WHERE e.tenant_id=q.tenant_id AND e.task_id=q.task_id AND e.user_id=q.user_id
            AND e.created_at<q.created_at AND saved.detail_enc IS NOT NULL
            AND e.event_type IN ('question_set.generated','question_set.saved','question_set.approved')
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1
       ) prior ON true
      WHERE q.tenant_id=$1 AND q.task_id=$2 AND q.user_id=$3
      ORDER BY q.version DESC`,
    [tenant, taskId, user]
  );
  return rows.flatMap((row) => {
    const content = reveal(user, 'question-set', row.content_enc);
    const save = reveal(user, 'event', row.saved_event);
    // Older versions persisted a generated draft as the first save after
    // generation. Keep its records for audit, but omit it from saved drafts.
    if (
      row.prior_type === 'question_set.generated' &&
      save?.version === row.version &&
      save.explicit !== true &&
      isDeepStrictEqual(reveal(user, 'event', row.prior_event)?.content, content)
    )
      return [];
    return [{
      id: row.id,
      version: row.version,
      status: row.status,
      source: row.source,
      content,
      ...(typeof save?.supplement === 'boolean' ? { is_supplement: save.supplement } : {}),
    }];
  });
}

async function doctorOperation(pool, input) {
  const requestStartedAt = Date.now();
  if (input.operation === 'list' && !enabled()) return { enabled: false };
  const s = await scope(pool, input),
    actor = String(input.doctor_id || '');
  if (!actor) throw error('IVR_INVALID_DOCTOR', 'Thiếu bác sĩ phụ trách.', 400);
  const op = input.operation,
    data = input.data || {};
  const sessionLock = `ivr:${s.tenant}:${s.taskId}`;
  if (op === 'recording') {
    // The signed Doctor request has already checked the current clinician assignment.
    const entry = (await pool.query(
      `SELECT a.audio_enc,a.mime_type,session.* FROM doctor_ivr_answers a
       JOIN doctor_ivr_sessions session ON session.id=a.session_id
       WHERE a.id=$1 AND a.active AND a.answer_type='voice' AND a.audio_enc IS NOT NULL
         AND session.tenant_id=$2 AND session.task_id=$3 AND session.user_id=$4`,
      [data.answer_id, s.tenant, s.taskId, s.user]
    )).rows[0];
    if (!entry) throw error('IVR_NOT_FOUND', 'Không tìm thấy ghi âm.', 404);
    await audit(pool, entry, actor, 'audio.listened', {}, entry.id);
    return {
      audio_data: Buffer.from(reveal(s.user, 'audio', entry.audio_enc), 'base64'),
      mime_type: entry.mime_type,
    };
  }
  if (op === 'list') {
    const profile = await readIvrPatientProfile(pool, s.user);
    const sets = await listQuestionSets(pool, s);
    const sessions = await taskIvrSessions(pool, s);
    const delivered = deliveredSessions(sessions);
    return {
      enabled: true,
      patient_address: resolveCommunicationStyle({ profile }).patient_address,
      capabilities: {
        app: true,
        call: process.env.DOCTOR_IVR_CALL_ENABLED === 'true',
        confidence: 'model_likelihood_estimate',
      },
      question_sets: sets,
      supplement_rounds: {
        used: supplementCount(delivered),
        limit: MAX_SUPPLEMENT_ROUNDS,
        can_start: canStartSupplement(delivered),
      },
      sessions: await serializeIntake(pool, s, actor, sessions),
      templates: (
        await pool.query(
          'SELECT id,name,specialty,content_enc,owner_id,is_shared FROM doctor_ivr_templates WHERE tenant_id=$1 AND (owner_id=$2 OR is_shared) ORDER BY created_at DESC',
          [s.tenant, actor]
        )
      ).rows.map((t) => ({
        id: t.id,
        name: t.name,
        specialty: t.specialty,
        content: reveal(t.owner_id, 'template', t.content_enc),
        is_shared: t.is_shared,
      })),
    };
  }
  if (op === 'preview') {
    if (!(await mayProcessAi(pool, s.user)))
      throw error('AI_CONSENT_REQUIRED', 'Người bệnh chưa đồng ý xử lý AI.', 403);
    try {
      const spoken = spokenQuestion(data, data.greeting || (data.fixed ? 'Cuối cùng,' : ''));
      return await withAiUser(pool, s.user, () =>
        synthesizeText(spoken, 'vi', { timeoutMs: 25000 })
      );
    } catch (cause) {
      if (cause.code === 'AI_CONSENT_REQUIRED') throw cause;
      throw error('IVR_PREVIEW_UNAVAILABLE', 'Chưa phát được giọng Tuấn Anh.', 503);
    }
  }
  assertTaskOpen(s.task);
  if (op === 'draft_reply') {
    if (!(await mayProcessAi(pool, s.user)))
      throw error('AI_CONSENT_REQUIRED', 'Người bệnh chưa đồng ý xử lý AI.', 403);
    const sessions = deliveredSessions(await taskIvrSessions(pool, s));
    assertReplySession(sessions[0], data.session_id);
    const [context, profile, rounds] = await Promise.all([
      loadDoctorClinicalContext(pool, input),
      readIvrPatientProfile(pool, s.user),
      serializeIntake(pool, s, actor, sessions.toReversed()),
    ]);
    const addressProfile = profile ?? context.profile;
    const address = resolveCommunicationStyle({ profile: addressProfile }).patient_address;
    let reply;
    try {
      reply = await withAiUser(pool, s.user, () =>
        draftPatientReply(context, rounds, { address, addressProfile, revision: data.revision })
      );
    } catch (cause) {
      if (cause?.code === 'AI_CONSENT_REQUIRED') throw cause;
      if (cause?.code === 'IVR_INVALID_REPLY_DRAFT') {
        throw error(
          'IVR_INVALID_REPLY_DRAFT',
          'AI chưa tạo được bản nháp hợp lệ. Bạn có thể thử lại hoặc tự nhập câu trả lời.',
          502
        );
      }
      throw error('IVR_REPLY_DRAFT_UNAVAILABLE', 'Chưa soạn được câu trả lời. Vui lòng thử lại.', 502);
    }
    const current = await scope(pool, input);
    assertTaskOpen(current.task);
    assertReplySession(deliveredSessions(await taskIvrSessions(pool, current))[0], data.session_id);
    await audit(pool, current, actor, 'reply.drafted', {
      rounds: rounds.length,
      revised: Boolean(data.revision),
    }, data.session_id);
    return { reply };
  }
  if (op === 'dictate') {
    if (!(await mayProcessAi(pool, s.user)))
      throw error('AI_CONSENT_REQUIRED', 'Người bệnh chưa đồng ý xử lý AI.', 403);
    const audio = data.audio_base64;
    if (
      !['audio/webm', 'audio/mp4'].includes(data.mime_type) ||
      typeof audio !== 'string' ||
      !audio.length ||
      audio.length > 700_000 ||
      audio.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(audio)
    )
      throw error('IVR_INVALID_DICTATION', 'Bản ghi không hợp lệ hoặc quá dài.', 400);
    const bytes = Buffer.from(audio, 'base64');
    if (!isAudioBuffer(bytes))
      throw error('IVR_INVALID_DICTATION', 'Bản ghi không hợp lệ hoặc quá dài.', 400);
    const fileName = data.mime_type === 'audio/webm' ? 'dictation.webm' : 'dictation.m4a';
    let transcript;
    try {
      transcript = await withAiUser(pool, s.user, () =>
        getWhisperTranscription(bytes, fileName, 'vi')
      );
    } catch (cause) {
      if (cause.code === 'AI_CONSENT_REQUIRED') throw cause;
      throw error(
        'IVR_DICTATION_UNAVAILABLE',
        'Chưa chuyển được lời nói thành văn bản. Vui lòng thử lại.',
        502
      );
    }
    if (typeof transcript !== 'string' || !transcript.trim())
      throw error(
        'IVR_DICTATION_EMPTY',
        'Chưa nghe rõ lời nói. Vui lòng nói lại hoặc nhập nội dung.',
        422
      );
    return { text: transcript.trim() };
  }
  if (op === 'generate') {
    const request =
      typeof data.supplement_request === 'string' ? data.supplement_request.trim() : '';
    if (
      data.supplement_request !== undefined &&
      (data.supplement !== true || !request || request.length > 1200)
    )
      throw error(
        'IVR_INVALID_SUPPLEMENT_REQUEST',
        'Nhập điều cần hỏi bổ sung, tối đa 1.200 ký tự.',
        400
      );
    let revision;
    if (data.supplement_revision !== undefined) {
      const parsed = supplementRevisionInput.safeParse(data.supplement_revision);
      if (
        data.supplement !== true ||
        !parsed.success ||
        (!request && !parsed.data.questions.length && !parsed.data.feedback)
      )
        throw error('IVR_INVALID_SUPPLEMENT_REVISION', 'Cần nội dung câu hỏi bổ sung hoặc góp ý để AI soạn lại.', 400);
      revision = parsed.data;
    }
    if (data.replace_session_id !== undefined && !revision)
      throw error('IVR_INVALID_SUPPLEMENT_REVISION', 'Cần nội dung câu hỏi bổ sung hoặc góp ý để AI soạn lại.', 400);
    if (!(await mayProcessAi(pool, s.user)))
      throw error('AI_CONSENT_REQUIRED', 'Người bệnh chưa đồng ý xử lý AI.', 403);
    const [context, profile] = await Promise.all([
      loadDoctorClinicalContext(pool, input),
      readIvrPatientProfile(pool, s.user),
    ]);
    const addressProfile = profile ?? context.profile;
    const style = resolveCommunicationStyle({ profile: addressProfile });
    const address = style.patient_address[0].toLocaleUpperCase('vi') + style.patient_address.slice(1);
    const usePatientAddress = (text) =>
      typeof text === 'string'
        ? text.replace(/\banh\s*\/\s*chị(?!\p{L}|\/)/giu, (word) =>
            word[0] === 'A' ? address : style.patient_address
          )
        : text;
    const recent = (
      await pool.query(
        "SELECT payload->'payload'->>'summary' summary FROM doctor_task_outbox WHERE payload->'payload'->>'app_user_id'=$1 AND tenant_id=$2 AND payload->'payload'->>'task_id'<>$3 ORDER BY created_at DESC LIMIT 3",
        [String(s.user), s.tenant, s.taskId]
      )
    ).rows;
    const previousIntake = [];
    if (data.supplement) {
      const previous = deliveredSessions(await taskIvrSessions(pool, s));
      if (data.replace_session_id !== undefined) {
        const current = previous[0];
        if (current?.id !== data.replace_session_id || !current.is_supplement)
          throw error('IVR_SESSION_CHANGED', 'Phiên này đã thay đổi. Hãy mở lại bộ câu hỏi.');
        if (!['draft', 'sent'].includes(current.status))
          throw error('IVR_SESSION_ACTIVE', 'Phiên đã bắt đầu, không được thay bộ câu hỏi.');
        previous.shift();
      }
      if (supplementCount(previous) >= MAX_SUPPLEMENT_ROUNDS)
        throw error('IVR_SUPPLEMENT_LIMIT', `Mỗi ca có tối đa ${MAX_SUPPLEMENT_ROUNDS} lượt hỏi bổ sung.`);
      if (!canStartSupplement(previous))
        throw error('IVR_SUPPLEMENT_NOT_READY', 'Chỉ bổ sung sau khi lượt trước kết thúc.');
      const history = await serializeIntake(pool, s, actor, previous.toReversed());
      for (const state of history) {
        previousIntake.push({
          follow_up_reason: state.report?.follow_up_reason,
          answers: intakeAnswers(state),
        });
      }
    }
    const generationContext = buildQuestionGenerationContext({
      context,
      addressProfile,
      address,
      recent,
      previousIntake,
      supplement: !!data.supplement,
    });
    const { known_facts: knownFacts } = generationContext;
    const guidedSupplement = Boolean(request || revision);
    const generationOptions = { guidedSupplement };
    const system = generationSystem +
      (data.supplement ? supplementQuestionCountInstruction : initialQuestionCountInstruction) +
      (data.supplement && !guidedSupplement ? '\nMỗi focus xuất hiện một lần.' : '') +
      (guidedSupplement ? supplementRequestInstruction : '') +
      (revision ? supplementRevisionInstruction : '') +
      questionSetOutputInstruction;
    const generationTokenBudget = data.supplement ? 3600 : 1200;
    let last, previousDraft, accepted;
    const repairs = [];
    const configuredTimeout = Number(process.env.DOCTOR_IVR_QUESTION_TIMEOUT_MS);
    const questionTimeout =
      Number.isSafeInteger(configuredTimeout) &&
      configuredTimeout >= 10000 &&
      configuredTimeout <= 30000
        ? configuredTimeout
        : 10000;
    const timeout = data.supplement === true ? SUPPLEMENT_GENERATION_TIMEOUT_MS : questionTimeout;
    const deadline = requestStartedAt + timeout;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const targets = !last ? [] : guidedSupplement
        ? guidedQuestionRepairTargets(previousDraft, last, address)
        : compoundRepairTargets(previousDraft, address, generationOptions);
      // A guided draft can use its remaining time for one last targeted repair.
      if (attempt === 3 && (!guidedSupplement || !targets.length)) break;
      const remainingMs = deadline - Date.now();
      // Generation and repairs share one deadline.
      if (remainingMs < 500) break;
      try {
        const result = await withAiUser(pool, s.user, () =>
          callTextAi({
            provider: process.env.DOCTOR_IVR_QUESTION_PROVIDER || 'openai',
            model: process.env.DOCTOR_IVR_QUESTION_MODEL || undefined,
            strictProvider: true,
            system: targets.length ? (guidedSupplement ? guidedRepairSystem : repairSystem) : system,
            prompt: JSON.stringify({
              ...generationContext,
              ...(request ? { supplement_request: request } : {}),
              ...(revision ? { supplement_revision: revision } : {}),
              previous_error: last ? questionGenerationFeedback(last) : undefined,
              ...(targets.length
                ? {
                    repair_targets: targets,
                    kept_questions: previousDraft.questions.filter(
                      (_question, index) => !targets.some((target) => target.index === index)
                    ),
                  }
                : { previous_draft: previousDraft }),
            }),
            jsonMode: true,
            temperature: 0.2,
            maxTokens: targets.length
              ? guidedSupplement
                ? Math.min(generationTokenBudget, 500 + targets.length * 400)
                : 100 + targets.length * 100
              : generationTokenBudget,
            timeoutMs: remainingMs,
            maxRetries: 0,
          })
        );
        if (Date.now() >= deadline) break;
        const generated = JSON.parse(
          result.content.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
        );
        if (guidedSupplement && generated?.follow_up_duration_exceeded === true)
          throw error(
            'IVR_SUPPLEMENT_DURATION_LIMIT',
            `Các ý cần hỏi vượt thời lượng ${generationContext.max_duration_seconds / 60} phút. Vui lòng rút gọn nội dung bổ sung.`,
            422
          );
        if (targets.length) {
          const repaired = guidedSupplement
            ? applyGuidedQuestionRepairs(previousDraft, targets, generated)
            : applyQuestionTextRepairs(previousDraft, targets, generated);
          const replacements = new Map(generated.replacements.map((item) => [item.index, item]));
          repairs.push(
            ...targets.map((target) => ({
              attempt: attempt + 1,
              index: target.index,
              before: target.question?.text ?? target.text,
              after: guidedSupplement
                ? replacements.get(target.index).questions.map(({ text }) => text).join(' ')
                : repaired.questions[target.index].text,
              reason: target.reason,
            }))
          );
          previousDraft = repaired;
        } else previousDraft = generated;
        if (
          !guidedSupplement &&
          knownFacts.onset_known &&
          previousDraft.questions?.some((q) => q.focus === 'onset')
        )
          throw new Error(
            'Thời điểm bắt đầu đã có trong lời kể. Không dùng focus onset; thay bằng điều còn thiếu.'
          );
        const value = materializeGeneratedQuestions(previousDraft, address, generationOptions);
        value.greeting = usePatientAddress(value.greeting);
        value.closing = usePatientAddress(value.closing);
        value.questions = value.questions.map((q) => ({ ...q, text: usePatientAddress(q.text) }));
        if (value.questions.some((q) => communicationConflict(q.text, style)))
          throw new Error('Xưng hô với người bệnh theo address và dùng nhất quán trong bộ câu hỏi.');
        if (
          value.questions.some(
            (q) =>
              q.unit &&
              /đau/iu.test(q.text) &&
              /thang (?:điểm|(?:từ )?0)|bao nhiêu điểm|chấm.{0,12}điểm/iu.test(q.text)
          )
        )
          throw new Error(
            'Hỏi mức đau bằng lời dễ chọn, dùng Đau nhẹ, Đau vừa, Đau nhiều. Không hỏi tự chấm điểm.'
          );
        const repeatedOnset =
          !guidedSupplement &&
          knownFacts.onset_known &&
          value.questions.find((q) =>
            /từ (?:khi nào|bao giờ)|bắt đầu.*(?:khi nào|bao giờ)|bao lâu (?:rồi|nay)/iu.test(q.text)
          );
        if (repeatedOnset)
          throw new Error(
            `Câu đã biết thời điểm bắt đầu: ${repeatedOnset.text}. Thay bằng một thông tin còn thiếu.`
          );
        const repeatedMedication =
          !guidedSupplement &&
          knownFacts.daily_medication_known &&
          value.questions.find(
            (q) =>
              /có.*(?:dùng|sử dụng).*thuốc.*(?:không|chưa)/iu.test(q.text) &&
              !/giảm đau|thuốc ho|thuốc ngủ|kháng sinh|mới|thay đổi/iu.test(q.text)
          );
        if (repeatedMedication)
          throw new Error(
            `Đã có thông tin dùng thuốc hằng ngày: ${repeatedMedication.text}. Không hỏi lại Có/Không.`
          );
        for (const q of value.questions || [])
          for (const o of q.options || [])
            if (o.red_flag) {
              o.suggested_red_flag = true;
              o.red_flag = false;
            }
        const content = validateQuestionSet(value, { supplement: !!data.supplement });
        accepted = {
          attempt: attempt + 1,
          provider: result.provider,
          model: result.model,
          repairs,
          content,
        };
        break;
      } catch (e) {
        last = e;
        if (['AI_CONSENT_REQUIRED', 'IVR_SUPPLEMENT_DURATION_LIMIT'].includes(e.code)) throw e;
        if (isAiTimeout(e)) break;
        const issues = e.issues?.slice(0, 6).map(({ code, path }) => ({ code, path }));
        logger.warn('doctor_ivr.question_generation_rejected', {
          attempt: attempt + 1,
          supplement: data.supplement === true,
          reason: e.code === 'IVR_INVALID_QUESTION_SET' && e.reason ? e.reason : e.code || e.name,
          questionIndex: e.questionIndex,
          issues,
        });
      }
    }
    if (accepted) {
      const current = await scope(pool, input);
      assertTaskOpen(current.task);
      await audit(pool, current, actor, 'question_set.generated', accepted);
      return { content: accepted.content };
    }
    if (isAiTimeout(last) || deadline - Date.now() < 500)
      throw error('IVR_GENERATION_TIMEOUT', 'AI chưa hoàn tất bộ câu hỏi trong thời gian chờ.', 504);
    if (guidedSupplement && last?.reason === 'duration_limit')
      throw error('IVR_SUPPLEMENT_DURATION_LIMIT', 'Nội dung đọc quá dài cho phiên 5 phút.', 422);
    throw error(
      'IVR_GENERATION_FAILED',
      'Chưa tạo được bộ câu hỏi hợp lệ. Hãy thử lại hoặc tự soạn.',
      502
    );
  }
  if (op === 'save' || op === 'approve') {
    if (op === 'approve' && !(await mayProcessAi(pool, s.user)))
      throw error(
        'AI_CONSENT_REQUIRED',
        'Người bệnh cần đồng ý xử lý AI trên Asinu trước khi gửi phiên.',
        403
      );
    const content = validateQuestionSet(data.content, { supplement: !!data.supplement });
    const channel = data.channel === undefined ? 'app' : data.channel;
    if (!['app', 'call', 'both'].includes(channel))
      throw error('IVR_INVALID_CHANNEL', 'Kênh gửi chưa hợp lệ.', 400);
    if (op === 'approve' && channel !== 'app' && process.env.DOCTOR_IVR_CALL_ENABLED !== 'true')
      throw error('IVR_CALL_UNAVAILABLE', 'Kênh gọi chưa được bật trên hệ thống này.', 400);
    if (op === 'approve' && channel !== 'app') {
      const device = (
        await pool.query(
          'SELECT doctor_ivr_calls,voip_push_token,fcm_token,doctor_ivr_fcm_hash,doctor_ivr_voip_hash FROM users WHERE id=$1',
          [s.user]
        )
      ).rows[0];
      const tokens = compatibleDeviceTokens(device);
      if (!device?.doctor_ivr_calls || !(tokens.voip || tokens.fcm))
        throw error(
          'IVR_CALL_DEVICE_NOT_READY',
          'Người bệnh cần mở bản Asinu hỗ trợ cuộc gọi bác sĩ và cho phép nhận cuộc gọi.',
          409
        );
      if (!content.greeting.startsWith('Cuộc gọi có thể được ghi âm.'))
        content.greeting = `Cuộc gọi có thể được ghi âm. ${content.greeting}`;
      Object.assign(content, validateQuestionSet(content, { supplement: !!data.supplement }));
    }
    const result = await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionLock]);
      const current = (
        await db.query(
          "SELECT * FROM doctor_ivr_sessions WHERE tenant_id=$1 AND task_id=$2 AND status IN ('draft','sent','in_progress','completed') FOR UPDATE",
          [s.tenant, s.taskId]
        )
      ).rows[0];
      if (current && current.status !== 'sent' && current.status !== 'draft')
        throw error('IVR_SESSION_ACTIVE', 'Phiên đã bắt đầu, không được thay bộ câu hỏi.');
      if (data.replace_session_id && current?.id !== data.replace_session_id)
        throw error('IVR_SESSION_CHANGED', 'Phiên này đã thay đổi. Hãy mở lại bộ câu hỏi.');
      const prior = deliveredSessions(await taskIvrSessions(db, s));
      if (!data.supplement && prior.length && !current)
        throw error('IVR_SUPPLEMENT_REQUIRED', 'Chọn soạn lượt bổ sung sau phiên đầu.');
      if (current && current.is_supplement !== Boolean(data.supplement))
        throw error('IVR_SESSION_ACTIVE', 'Đang có lượt câu hỏi chưa hoàn tất.');
      if (data.supplement) {
        const earlier = prior.filter((session) => session.id !== current?.id);
        if (earlier.some((row) => ['replied', 'closed'].includes(row.status)))
          throw error('IVR_SUPPLEMENT_TOO_LATE', 'Bác sĩ đã gửi kết quả cuối.');
        if (supplementCount(earlier) >= MAX_SUPPLEMENT_ROUNDS)
          throw error('IVR_SUPPLEMENT_LIMIT', `Mỗi ca có tối đa ${MAX_SUPPLEMENT_ROUNDS} lượt hỏi bổ sung.`);
        if ((current && !data.replace_session_id) || !canStartSupplement(earlier))
          throw error('IVR_SUPPLEMENT_NOT_READY', 'Chỉ bổ sung sau khi lượt trước kết thúc.');
      }
      if (current && op === 'approve') {
        await db.query(
          "UPDATE doctor_ivr_sessions SET status='cancelled',updated_at=NOW() WHERE id=$1",
          [current.id]
        );
        await audit(db, s, actor, 'session.cancelled', { reason: 'new_version' }, current.id);
      }
      const version = Number(
        (
          await db.query(
            'SELECT COALESCE(MAX(version),0)+1 n FROM doctor_ivr_question_sets WHERE tenant_id=$1 AND task_id=$2',
            [s.tenant, s.taskId]
          )
        ).rows[0].n
      );
      const id = crypto.randomUUID();
      await db.query(
        'INSERT INTO doctor_ivr_question_sets(id,tenant_id,task_id,user_id,version,status,source,content_enc,created_by,approved_by,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10::text IS NULL THEN NULL ELSE NOW() END)',
        [
          id,
          s.tenant,
          s.taskId,
          s.user,
          version,
          op === 'approve' ? 'approved' : 'draft',
          data.source || 'manual',
          seal(s.user, 'question-set', content),
          actor,
          op === 'approve' ? actor : null,
        ]
      );
      const previousEvent = (
        await db.query(
          "SELECT detail_enc FROM doctor_ivr_events WHERE tenant_id=$1 AND task_id=$2 AND user_id=$3 AND event_type IN ('question_set.generated','question_set.saved','question_set.approved') ORDER BY created_at DESC,id DESC LIMIT 1",
          [s.tenant, s.taskId, s.user]
        )
      ).rows[0];
      const previousContent = previousEvent
        ? reveal(s.user, 'event', previousEvent.detail_enc)?.content
        : null;
      await audit(db, s, actor, `question_set.${op === 'approve' ? 'approved' : 'saved'}`, {
        version,
        ...(op === 'save' ? { explicit: true, supplement: !!data.supplement } : {}),
        content,
        changes: questionSetChanges(previousContent, content),
      });
      if (op === 'save') return { question_set_id: id, version };
      const sessionId = crypto.randomUUID();
      const policy = await patientPolicy(db, s.tenant, s.user);
      await db.query(
        "INSERT INTO doctor_ivr_sessions(id,question_set_id,tenant_id,task_id,user_id,doctor_id,doctor_name,status,current_question_id,is_supplement,channel,policy) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11)",
        [
          sessionId,
          id,
          s.tenant,
          s.taskId,
          s.user,
          actor,
          String(input.doctor_name || 'Bác sĩ'),
          content.questions[0].id,
          !!data.supplement,
          channel,
          policy,
        ]
      );
      await audit(db, s, actor, 'session.preparing', {}, sessionId);
      const message = await insertIvrQuestionMessage(db, {
        tenantId: s.tenant,
        taskId: s.taskId,
        userId: s.user,
        sessionId,
        language: s.language,
      });
      return {
        question_set_id: id,
        version,
        session_id: sessionId,
        status: 'draft',
        message_id: message.id,
      };
    });
    if (result.message_id)
      broadcastChatEvent({
        tenantId: s.tenant,
        taskId: s.taskId,
        type: 'chat.message.changed',
        data: { task_id: s.taskId, message_id: String(result.message_id), action: 'created' },
      });
    return result;
  }
  if (op === 'template') {
    const content = validateQuestionSet(data.content, { supplement: !!data.supplement });
    // Private templates are encrypted per physician; strip patient-specific introductions.
    content.greeting = '';
    content.closing = '';
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO doctor_ivr_templates(id,tenant_id,owner_id,name,specialty,content_enc,source_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        s.tenant,
        actor,
        String(data.name || content.title).slice(0, 160),
        input.specialty || null,
        seal(actor, 'template', content),
        s.user,
      ]
    );
    return { id };
  }
  if (op === 'cancel') {
    const row = await getSession(pool, data.session_id, s.user);
    if (row.tenant_id !== s.tenant || row.task_id !== s.taskId)
      throw error('IVR_NOT_FOUND', 'Không tìm thấy phiên.', 404);
    const cancelled = await pool.query(
      "UPDATE doctor_ivr_sessions SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status IN ('draft','sent') RETURNING id",
      [row.id]
    );
    if (!cancelled.rowCount) throw error('IVR_ALREADY_STARTED', 'Không thể hủy phiên đã bắt đầu.');
    await audit(pool, row, actor, 'session.cancelled', {}, row.id);
    broadcastIvrInvitationChange(s.tenant, s.taskId, row.id);
    return { ok: true };
  }
  if (op === 'reply' || op === 'reply_video') {
    const video = op === 'reply_video' ? readReplyVideo(data) : null;
    const text = typeof data.reply === 'string' ? data.reply.trim() : '';
    if (!video) {
      if (!text) throw error('IVR_INVALID_REPLY', 'Cần nội dung trả lời.', 400);
      if (asksForMoreInformation(text))
        throw error(
          'IVR_REPLY_NEEDS_FOLLOW_UP',
          'Kết quả cuối không được yêu cầu người bệnh trả lời thêm. Hãy gửi phiên bổ sung hoặc trao đổi trong hội thoại trước.',
          400
        );
    }
    let uploaded;
    try {
      return await transaction(pool, async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionLock]);
        const row = await getSession(db, data.session_id, s.user, true);
        if (row.task_id !== s.taskId || row.tenant_id !== s.tenant)
          throw error('IVR_NOT_FOUND', 'Không tìm thấy phiên.', 404);
        if (row.status === 'replied' || row.status === 'closed') {
          const sent = reveal(s.user, 'reply', row.reply_enc);
          if (video ? sent?.request_id === data.request_id : sent === text)
            return { id: row.id, duplicate: true };
          throw error('IVR_REPLY_ALREADY_SENT', 'Kết quả tư vấn đã được gửi.');
        }
        assertReplySession(deliveredSessions(await taskIvrSessions(db, s))[0], row.id);
        let reply = text;
        if (video) {
          uploaded = await uploadReplyVideo(video);
          const hasAudio = uploaded.has_audio === true || Boolean(uploaded.audio?.codec || uploaded.audio_codec);
          if (!uploaded.public_id || uploaded.format !== 'mp4' || !uploaded.width ||
              !hasAudio || !Number.isFinite(uploaded.duration) || uploaded.duration <= 0 || uploaded.duration > 185 ||
              !replyVideoUrl(uploaded.public_id))
            throw error('IVR_INVALID_REPLY_VIDEO', 'Cần video có hình và tiếng, tối đa 3 phút.', 400);
          assertTaskOpen((await scope(db, input)).task);
          await db.query(
            `INSERT INTO doctor_patient_files
              (user_id, name, mime_type, size_bytes, secure_url, public_id, resource_type, delivery_type, source_task_id, uploaded_by)
             VALUES ($1,'Video trả lời tư vấn.mp4','video/mp4',$2,$3,$4,'video','authenticated',$5,$6)`,
            [s.user, uploaded.bytes, uploaded.secure_url, uploaded.public_id, s.taskId, actor]
          );
          reply = { public_id: uploaded.public_id, request_id: data.request_id };
        }
        await db.query(
          "UPDATE doctor_ivr_sessions SET status='replied',reply_enc=$2,replied_at=NOW(),updated_at=NOW() WHERE id=$1",
          [row.id, seal(s.user, 'reply', reply)]
        );
        await audit(db, row, actor, 'session.replied', video ? { reply_type: 'video' } : { reply }, row.id);
        return { id: row.id };
      });
    } catch (cause) {
      if (uploaded?.public_id) {
        // A failed COMMIT can have an unknown outcome. Keep assets referenced by a committed file.
        try {
          const saved = await pool.query('SELECT 1 FROM doctor_patient_files WHERE user_id=$1 AND public_id=$2', [s.user, uploaded.public_id]);
          if (!saved.rowCount) await deleteAsset(uploaded.public_id, 'video', 'authenticated');
        } catch {
          // Preserve the original error and allow the specialist to retry.
        }
      }
      throw cause;
    }
  }
  throw error('IVR_INVALID_OPERATION', 'Thao tác không hợp lệ.', 400);
}
async function patientList(pool, user, tenant, taskId) {
  await scope(pool, { tenant_id: tenant, task_id: taskId, app_user_id: user });
  const rows = (
    await pool.query(
      'SELECT id FROM doctor_ivr_sessions WHERE user_id=$1 AND tenant_id=$2 AND task_id=$3 ORDER BY created_at DESC LIMIT 10',
      [user, tenant, taskId]
    )
  ).rows;
  return {
    enabled: true,
    sessions: await Promise.all(
      rows.map(async (row) => serialize(pool, await getSession(pool, row.id, user)))
    ),
  };
}
async function patientGet(pool, user, id) {
  assertEnabled();
  const row = await getSession(pool, id, user);
  await scope(pool, { tenant_id: row.tenant_id, task_id: row.task_id, app_user_id: user });
  return serialize(pool, row);
}
async function patientAction(pool, user, id, input, file = null) {
  assertEnabled();
  const initial = await getSession(pool, id, user);
  const taskScope = await scope(pool, {
    tenant_id: initial.tenant_id,
    task_id: initial.task_id,
    app_user_id: user,
  });
  if (
    ['completed', 'cancelled', 'expired', 'emergency_referred', 'forwarded'].includes(
      taskScope.task.lifecycle_status
    ) &&
    input.action !== 'ack'
  )
    throw error('IVR_TASK_CLOSED', 'Ca tư vấn đã kết thúc.');
  return transaction(pool, async (db) => {
    const s = await getSession(db, id, user, true),
      content = reveal(user, 'question-set', s.content_enc);
    if (input.action === 'answer' && /^[0-9a-f-]{36}$/iu.test(input.request_id || '')) {
      const duplicate = (
        await db.query(
          'SELECT id FROM doctor_ivr_answers WHERE session_id=$1 AND client_request_id=$2',
          [id, input.request_id]
        )
      ).rows[0];
      if (duplicate) {
        if (file) {
          const answer = (
            await db.query('SELECT * FROM doctor_ivr_answers WHERE id=$1 FOR UPDATE', [
              duplicate.id,
            ])
          ).rows[0];
          if (answer.stt_status === 'awaiting_upload') {
            if (!['in_progress', 'completed', 'expired', 'reported'].includes(s.status))
              throw error('IVR_SESSION_ENDED', 'Phiên không còn nhận ghi âm.');
            if (file.buffer.length > 3 * 1024 * 1024)
              throw error('IVR_AUDIO_TOO_LARGE', 'File quá lớn.', 413);
            const question = content.questions.find((q) => q.id === answer.question_id),
              option = question?.options.find((o) => o.id === answer.option_id);
            const duration = await inspectRecording(file.buffer, option?.max_record_s || 30);
            await db.query(
              "UPDATE doctor_ivr_answers SET audio_enc=$2,mime_type=$3,audio_duration_s=$4,stt_status='pending' WHERE id=$1",
              [
                answer.id,
                seal(user, 'audio', file.buffer.toString('base64')),
                file.mimetype,
                duration,
              ]
            );
            await audit(
              db,
              s,
              String(user),
              'audio.uploaded',
              { question_id: answer.question_id },
              id
            );
          }
        }
        return serialize(db, s);
      }
    }
    if (input.action === 'ack') {
      if (s.status === 'closed') return serialize(db, s);
      if (s.status !== 'replied') throw error('IVR_REPLY_NOT_READY', 'Bác sĩ chưa trả lời.');
      await db.query(
        "UPDATE doctor_ivr_sessions SET status='closed',patient_ack_at=NOW(),updated_at=NOW() WHERE id=$1",
        [id]
      );
      await audit(db, s, String(user), 'session.closed', {}, id);
      return serialize(db, await getSession(db, id, user));
    }
    if (
      !['sent', 'in_progress'].includes(s.status) ||
      !s.expires_at ||
      Date.now() >= new Date(s.expires_at).getTime()
    )
      throw error('IVR_SESSION_ENDED', 'Phiên không còn nhận câu trả lời.');
    if (input.action === 'snooze') {
      if (s.reminder_count >= 3)
        throw error('IVR_REMINDER_LIMIT', 'Đã dùng hết số lần nhắc cho phiên này.', 400);
      if (s.status !== 'sent') throw error('IVR_ALREADY_STARTED', 'Phiên đã bắt đầu.');
      const delay = Number(input.minutes);
      if (![15, 60].includes(delay) && input.minutes !== 'tonight')
        throw error('IVR_INVALID_REMINDER', 'Lịch nhắc không hợp lệ.', 400);
      let when = Date.now() + delay * 60000;
      if (input.minutes === 'tonight') {
        when = nextEvening(new Date(), s.policy?.timezone || 'Asia/Ho_Chi_Minh').getTime();
      }
      if (when >= new Date(s.expires_at).getTime())
        throw error('IVR_REMINDER_TOO_LATE', 'Lịch nhắc nằm sau thời hạn phiên.', 400);
      await db.query('UPDATE doctor_ivr_sessions SET remind_at=$2,updated_at=NOW() WHERE id=$1', [
        id,
        new Date(when),
      ]);
      const policy = { ...require('./ivr.policy').defaults(), ...s.policy };
      await db.query(
        "UPDATE doctor_ivr_call_attempts SET scheduled_at=$2 WHERE session_id=$1 AND status='queued'",
        [id, nextCallTime(new Date(when), policy)]
      );
      return serialize(db, await getSession(db, id, user));
    }
    if (input.action === 'start') {
      await db.query(
        "UPDATE doctor_ivr_call_attempts SET status='cancelled',finished_at=NOW() WHERE session_id=$1 AND status IN ('queued','ringing','dispatching')",
        [id]
      );
      await db.query(
        "UPDATE doctor_ivr_sessions SET status='in_progress',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1",
        [id]
      );
      return serialize(db, await getSession(db, id, user));
    }
    if (input.action === 'answer') {
      if (!/^[0-9a-f-]{36}$/iu.test(input.request_id || ''))
        throw error('IVR_INVALID_REQUEST_ID', 'Thiếu mã gửi câu trả lời.', 400);
      const duplicate = (
        await db.query(
          'SELECT id FROM doctor_ivr_answers WHERE session_id=$1 AND client_request_id=$2',
          [id, input.request_id]
        )
      ).rows[0];
      if (duplicate) return serialize(db, s);
    }
    if (Number(input.revision) !== s.revision)
      throw error('IVR_STALE_REVISION', 'Tiến độ đã thay đổi, hãy tải lại phiên.');
    if (input.action === 'back') {
      const path = [...s.path],
        previous = path.pop();
      if (!previous) throw error('IVR_NO_PREVIOUS', 'Đây là câu đầu tiên.');
      await db.query(
        'UPDATE doctor_ivr_answers SET active=FALSE WHERE session_id=$1 AND question_id=$2',
        [id, previous]
      );
      await db.query(
        'UPDATE doctor_ivr_sessions SET current_question_id=$2,path=$3,revision=revision+1,updated_at=NOW() WHERE id=$1',
        [id, previous, JSON.stringify(path)]
      );
      await audit(db, s, String(user), 'session.back', { question_id: previous }, id);
      return serialize(db, await getSession(db, id, user));
    }
    if (input.action !== 'answer') throw error('IVR_INVALID_ACTION', 'Thao tác không hợp lệ.', 400);
    if (input.question_id !== s.current_question_id)
      throw error('IVR_WRONG_QUESTION', 'Câu hỏi không khớp tiến độ hiện tại.');
    const q = content.questions.find((item) => item.id === input.question_id),
      o = q.options.find((item) => item.id === input.option_id);
    const skip = ['no_response', 'no_speech', 'user_skip'].includes(input.skip_reason);
    if (!skip && !o) throw error('IVR_INVALID_ANSWER', 'Đáp án không hợp lệ.', 400);
    let audio = null,
      duration = null,
      type = skip ? 'skip' : 'option';
    if (o?.type === 'voice' && !skip) {
      if (input.recording_consent !== 'true' && input.recording_consent !== true)
        throw error('IVR_RECORDING_CONSENT_REQUIRED', 'Cần đồng ý ghi âm.', 403);
      if (!(await mayProcessAi(db, user)))
        throw error('AI_CONSENT_REQUIRED', 'Cần đồng ý xử lý AI.', 403);
      if (!file && input.voice_pending !== true)
        throw error('IVR_AUDIO_REQUIRED', 'Cần file ghi âm gốc.', 400);
      if (file && file.buffer.length > 3 * 1024 * 1024)
        throw error('IVR_AUDIO_TOO_LARGE', 'File ghi âm quá lớn.', 413);
      duration = file ? await inspectRecording(file.buffer, o.max_record_s) : null;
      audio = file ? seal(user, 'audio', file.buffer.toString('base64')) : null;
      type = 'voice';
    } else if (file) throw error('IVR_UNEXPECTED_AUDIO', 'Câu trả lời này không nhận ghi âm.', 400);
    const old = (
      await db.query('SELECT * FROM doctor_ivr_answers WHERE session_id=$1 AND question_id=$2', [
        id,
        q.id,
      ])
    ).rows[0];
    const answerId = old?.id || crypto.randomUUID();
    await audit(
      db,
      s,
      String(user),
      'answer.recorded',
      {
        question_id: q.id,
        option_id: skip ? null : o.id,
        previous: old ? { option_id: old.option_id, answer_type: old.answer_type } : null,
        red_flag: !!o?.red_flag,
      },
      id
    );
    await db.query(
      `INSERT INTO doctor_ivr_answers(id,session_id,question_id,option_id,answer_type,client_request_id,audio_enc,mime_type,audio_duration_s,transcript_enc,stt_status,is_red_flag,skip_reason,question_fingerprint)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT(session_id,question_id) DO UPDATE SET option_id=EXCLUDED.option_id,answer_type=EXCLUDED.answer_type,client_request_id=EXCLUDED.client_request_id,audio_enc=EXCLUDED.audio_enc,mime_type=EXCLUDED.mime_type,audio_duration_s=EXCLUDED.audio_duration_s,transcript_enc=NULL,stt_status=EXCLUDED.stt_status,stt_confidence=NULL,stt_needs_review=FALSE,stt_attempts=0,stt_started_at=NULL,is_red_flag=EXCLUDED.is_red_flag,skip_reason=EXCLUDED.skip_reason,question_fingerprint=EXCLUDED.question_fingerprint,active=TRUE,answered_at=NOW()`,
      [
        answerId,
        id,
        q.id,
        skip ? null : o.id,
        type,
        input.request_id,
        audio,
        file?.mimetype || null,
        duration,
        null,
        type === 'voice' ? (audio ? 'pending' : 'awaiting_upload') : 'none',
        !skip && !!o?.red_flag,
        skip ? input.skip_reason : null,
        questionFingerprint(s.tenant_id, q),
      ]
    );
    if (!skip && o.red_flag)
      await audit(db, s, 'system', 'red_flag.detected', { question_id: q.id, label: o.label }, id);
    const next = nextQuestion(content, q.id, skip ? null : o.id),
      path = [...s.path, q.id];
    await db.query(
      "UPDATE doctor_ivr_sessions SET status=$2,current_question_id=$3,path=$4,revision=revision+1,started_at=COALESCE(started_at,NOW()),completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1",
      [id, next ? 'in_progress' : 'completed', next, JSON.stringify(path)]
    );
    if (!next) await audit(db, s, 'system', 'session.completed', {}, id);
    return serialize(db, await getSession(db, id, user));
  });
}
async function questionAudio(pool, user, id, questionId) {
  assertEnabled();
  if (questionId.startsWith(answerAudioPrefix))
    throw error('IVR_NOT_FOUND', 'Không tìm thấy câu hỏi.', 404);
  const s = await getSession(pool, id, user);
  await scope(pool, { tenant_id: s.tenant_id, task_id: s.task_id, app_user_id: user });
  const item = (
    await pool.query(
      'SELECT audio_enc,mime_type FROM doctor_ivr_audio_cache WHERE question_set_id=$1 AND question_id=$2',
      [s.question_set_id, questionId]
    )
  ).rows[0];
  if (!item) throw error('IVR_AUDIO_PENDING', 'Âm thanh đang chuẩn bị.', 503);
  return { base64: reveal(user, 'tts', item.audio_enc), mimeType: item.mime_type };
}
async function answerAudio(pool, user, id, questionId, optionId) {
  assertEnabled();
  const session = await getSession(pool, id, user);
  await scope(pool, { tenant_id: session.tenant_id, task_id: session.task_id, app_user_id: user });
  const content = reveal(user, 'question-set', session.content_enc);
  const question = content.questions.find((item) => item.id === questionId);
  const option = question?.options.find((item) => item.id === optionId && item.type === 'option');
  const notFound = () => error('IVR_NOT_FOUND', 'Không tìm thấy âm thanh xác nhận.', 404);
  if (!option || !['in_progress', 'completed', 'reported', 'replied'].includes(session.status))
    throw notFound();
  if (session.current_question_id !== questionId) {
    const saved = await pool.query(
      "SELECT 1 FROM doctor_ivr_answers WHERE session_id=$1 AND question_id=$2 AND option_id=$3 AND active AND answer_type='option'",
      [id, questionId, optionId]
    );
    if (!saved.rowCount) throw notFound();
  }

  return patientAudio(pool, session, `Bạn đã chọn: ${option.label}`);
}
async function closingAudio(pool, user, id) {
  assertEnabled();
  const session = await getSession(pool, id, user);
  await scope(pool, { tenant_id: session.tenant_id, task_id: session.task_id, app_user_id: user });
  if (!['completed', 'reported', 'replied', 'closed'].includes(session.status))
    throw error('IVR_NOT_FOUND', 'Chưa có lời kết cho phiên này.', 404);
  const content = reveal(user, 'question-set', session.content_enc);
  const flagged = await pool.query(
    'SELECT 1 FROM doctor_ivr_answers WHERE session_id=$1 AND active AND is_red_flag LIMIT 1',
    [id]
  );
  const safety = flagged.rowCount
    ? session.policy?.safety_message || String(process.env.DOCTOR_IVR_SAFETY_MESSAGE || '')
    : '';
  return patientAudio(pool, session, [content.closing, safety].filter(Boolean).join(' '));
}
async function patientAudio(pool, session, spoken) {
  const user = session.user_id;
  const hash = crypto.createHash('sha256').update(audioVersion('vi')).update(spoken).digest('hex');
  const cacheId = `${answerAudioPrefix}${hash}`;
  const jobKey = `${user}:${hash}`;
  let job = patientAudioJobs.get(jobKey);
  if (!job) {
    job = (async () => {
      const cached = (
        await pool.query(
          'SELECT a.audio_enc,a.mime_type FROM doctor_ivr_audio_cache a JOIN doctor_ivr_question_sets q ON q.id=a.question_set_id WHERE q.user_id=$1 AND a.question_id=$2 LIMIT 1',
          [user, cacheId]
        )
      ).rows[0];
      if (cached) return cached;

      const audio = await withAiUser(pool, user, () =>
        synthesizeText(spoken, 'vi', { timeoutMs: 8000 })
      );
      const raw = audio.audio_data || audio.base64;
      const base64 = Buffer.isBuffer(raw) ? raw.toString('base64') : raw;
      if (typeof base64 !== 'string' || !base64)
        throw error('IVR_AUDIO_PENDING', 'Âm thanh chưa sẵn sàng.', 503);
      const item = {
        audio_enc: seal(user, 'tts', base64),
        mime_type: audio.mime_type || audio.mimeType || 'audio/mpeg',
      };
      await pool.query(
        'INSERT INTO doctor_ivr_audio_cache(question_set_id,question_id,audio_enc,mime_type,content_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [session.question_set_id, cacheId, item.audio_enc, item.mime_type, hash]
      );
      return item;
    })().finally(() => patientAudioJobs.delete(jobKey));
    patientAudioJobs.set(jobKey, job);
  }
  const item = await job;
  return { base64: reveal(user, 'tts', item.audio_enc), mimeType: item.mime_type };
}
async function media(pool, id, expires, signature, actor) {
  key();
  const timestamp = Number(expires),
    expected = mediaSignature(id, timestamp, String(actor || '')),
    received = String(signature || '');
  if (
    !Number.isInteger(timestamp) ||
    timestamp < Math.floor(Date.now() / 1000) ||
    timestamp > Math.floor(Date.now() / 1000) + 900 ||
    !/^[a-f0-9]{64}$/iu.test(received) ||
    !crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))
  )
    throw error('IVR_MEDIA_EXPIRED', 'Đường dẫn ghi âm hết hạn.', 403);
  const row = (
    await pool.query(
      'SELECT a.audio_enc,a.mime_type,s.* FROM doctor_ivr_answers a JOIN doctor_ivr_sessions s ON s.id=a.session_id WHERE a.id=$1',
      [id]
    )
  ).rows[0];
  if (!row || !row.audio_enc) throw error('IVR_NOT_FOUND', 'Không tìm thấy ghi âm.', 404);
  if (String(actor) === String(row.user_id)) {
    if (
      !(await pool.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [row.user_id]))
        .rows.length
    )
      throw error('IVR_NOT_FOUND', 'Không tìm thấy ghi âm.', 404);
  } else {
    const scoped = await scope(pool, {
      tenant_id: row.tenant_id,
      task_id: row.task_id,
      app_user_id: row.user_id,
    });
    if (scoped.task.doctor_ref && scoped.task.doctor_ref !== String(actor))
      throw error('IVR_NOT_ASSIGNED', 'Bác sĩ không còn phụ trách ca này.', 403);
  }
  await audit(pool, row, String(actor || 'signed-link'), 'audio.listened', {}, row.id);
  return {
    buffer: Buffer.from(reveal(row.user_id, 'audio', row.audio_enc), 'base64'),
    mime: row.mime_type,
  };
}
module.exports = {
  enabled,
  assertEnabled,
  seal,
  reveal,
  key,
  error,
  scope,
  audit,
  transaction,
  getSession,
  serialize,
  loadConsultationIvrIntake,
  doctorOperation,
  patientList,
  patientGet,
  patientAction,
  questionAudio,
  answerAudio,
  closingAudio,
  media,
};
