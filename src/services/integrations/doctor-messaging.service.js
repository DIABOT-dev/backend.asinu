const {
  encryptHealthField,
  decryptHealthField,
  PREFIX,
} = require('../../security/health-field-encryption');
const { sendAndSave } = require('../notification/basic.notification.service');
const { assertTenantAllowed, deliverDoctorRequest } = require('./doctor-task.service');
const { verifyDoctorSignature, assertProfileRequest } = require('./doctor-profile.service');
const { uploadBuffer, deleteAsset } = require('../media/cloudinary-upload.service');
const {
  authenticatedAssetUrl,
  isSupportedPatientFile,
  requirePrivateDeliveryConfig,
  resourceTypeForMime,
} = require('../media/private-media.service');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');
const { isAudioBuffer } = require('../../middleware/upload.middleware');
const { broadcastChatEvent } = require('./doctor-chat-realtime');
const { t } = require('../../i18n');
const logger = require('../../lib/logger');
const crypto = require('crypto');
const { resolveDoctorAttachmentContent } = require('./doctor-attachment.service');
const { readConsultationInitialRequest } = require('./doctor-screening.service');

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const TERMINAL_LIFECYCLE_STATUSES = new Set([
  'cancelled',
  'expired',
  'failed',
  'emergency_referred',
  'forwarded',
]);
const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;
const TYPING_TTL_MS = 4 * 1000;
const typingRelayState = new Map();

const relayDoctorChatChange = ({
  tenantId,
  taskId,
  userId,
  action,
  messageId,
  messageIds,
  isTyping,
}) => {
  const eventId = `doctor.task.chat.changed:${taskId}:${crypto.randomUUID()}`;
  const envelope = {
    event_id: eventId,
    idempotency_key: eventId,
    event_type: 'doctor.task.chat.changed',
    occurred_at: new Date().toISOString(),
    source: 'asinu-backend',
    version: 1,
    tenant_id: tenantId,
    payload: {
      task_id: taskId,
      app_user_id: String(userId),
      action,
      ...(messageId ? { message_id: String(messageId) } : {}),
      ...(Array.isArray(messageIds) ? { message_ids: messageIds.map(String) } : {}),
      ...(typeof isTyping === 'boolean' ? { is_typing: isTyping } : {}),
    },
  };
  void deliverDoctorRequest('chat-events', envelope, eventId).catch((error) => {
    const log = action === 'typing' ? logger.debug : logger.warn;
    log('doctor_chat_direct_delivery_failed', {
      event_id: eventId,
      task_id: taskId,
      action,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  });
};

const RAW_MESSAGE_COLUMNS = `id, task_id, sender_type, sender_ref, message_type, content,
  client_message_id, created_at, delivered_at, read_at, read_by_type, read_by_ref,
  edited_at, deleted_at, deleted_by_type, deleted_by_ref, pinned_at, pinned_by_type,
  pinned_by_ref, user_id, reply_to_message_id`;

const messageProjection = `
  m.id, m.task_id, m.sender_type, m.sender_ref, m.message_type,
  CASE WHEN m.deleted_at IS NOT NULL OR d.message_id IS NOT NULL THEN NULL ELSE m.content END AS content,
  m.client_message_id, m.created_at, m.delivered_at, m.read_at, m.read_by_type,
  m.read_by_ref, m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by_type,
  m.pinned_by_ref, m.user_id, (m.deleted_at IS NOT NULL) AS is_deleted,
  (d.message_id IS NOT NULL) AS is_deleted_for_me,
  (m.edited_at IS NOT NULL) AS is_edited,
  (m.pinned_at IS NOT NULL) AS is_pinned,
  CASE WHEN m.deleted_at IS NULL AND d.message_id IS NULL THEN m.reply_to_message_id END AS reply_to_message_id,
  quoted.id AS quoted_id, quoted.sender_type AS quoted_sender_type, quoted.sender_ref AS quoted_sender_ref,
  quoted.message_type AS quoted_message_type, quoted.content AS quoted_content,
  CASE WHEN m.deleted_at IS NOT NULL OR d.message_id IS NOT NULL THEN '[]'::jsonb
       ELSE COALESCE((
         SELECT jsonb_agg(to_jsonb(grouped) ORDER BY grouped.emoji)
           FROM (SELECT emoji, count(*)::int AS count,
                        bool_or(actor_type = $4 AND actor_ref = $5) AS reacted_by_me
                   FROM doctor_task_message_reactions
                  WHERE message_id = m.id
                  GROUP BY emoji) grouped
       ), '[]'::jsonb)
  END AS reactions,
  CASE WHEN m.read_at IS NOT NULL THEN 'seen' ELSE 'sent' END AS delivery_status`;

const isDoctorTaskMessageable = ({ status, followUpUntil }, messageType, now = new Date()) => {
  if (!status || !status.length) return true;
  if (TERMINAL_LIFECYCLE_STATUSES.has(status)) {
    return (
      ['cancelled', 'expired'].includes(status) &&
      messageType === 'reply' &&
      Boolean(followUpUntil && new Date(followUpUntil).getTime() > now.getTime())
    );
  }
  if (status !== 'completed') return true;
  return (
    ['follow_up', 'voice'].includes(messageType) &&
    Boolean(followUpUntil && new Date(followUpUntil).getTime() > now.getTime())
  );
};

const ivrQuestionSender = 'doctor-ivr-worker';
const isSystemSender = (senderRef) =>
  senderRef === 'doctor-sla-worker' || senderRef === ivrQuestionSender;

const parseAttachment = (content) => {
  if (typeof content !== 'string' || !content.startsWith('[ASINU_ATTACHMENT]')) return null;
  try {
    return JSON.parse(content.slice('[ASINU_ATTACHMENT]'.length));
  } catch {
    return null;
  }
};

const parseVoice = (content) => {
  if (typeof content !== 'string' || !content.startsWith('[ASINU_VOICE]')) return null;
  try {
    return JSON.parse(content.slice('[ASINU_VOICE]'.length));
  } catch {
    return null;
  }
};

const privateMedia = (media) => {
  if (!media || typeof media !== 'object') return null;
  const resourceType = ['image', 'video', 'raw'].includes(media.resource_type)
    ? media.resource_type
    : resourceTypeForMime(media.mime_type);
  const {
    public_id: _publicId,
    resource_type: _resourceType,
    delivery_type: _deliveryType,
    secure_url: _secureUrl,
    ...safeMedia
  } = media;
  return {
    ...safeMedia,
    // Legacy public URLs are deliberately not returned. New records carry a
    // public_id and receive a signed authenticated delivery URL.
    url: authenticatedAssetUrl(media.public_id, resourceType, media.delivery_type, media.mime_type),
  };
};

const decryptedMessage = Symbol('decrypted-health-message');
const decryptMessage = (message) => {
  if (
    !message ||
    message[decryptedMessage] ||
    typeof message.content !== 'string' ||
    !message.content.startsWith(PREFIX)
  )
    return message;
  return {
    ...message,
    content: decryptHealthField(message.user_id, 'doctor_task_messages.content', message.content),
    [decryptedMessage]: true,
  };
};

const hydrateMessageMedia = (message) => {
  message = decryptMessage(message);
  if (!message || typeof message.content !== 'string') return message;
  if (message.sender_type === 'doctor' && message.sender_ref === ivrQuestionSender)
    return { ...message, ivr_session_id: message.client_message_id };
  const attachment = parseAttachment(message.content);
  if (attachment) {
    return {
      ...message,
      content: `[ASINU_ATTACHMENT]${JSON.stringify(privateMedia(attachment))}`,
    };
  }
  const voice = parseVoice(message.content);
  if (voice) {
    return {
      ...message,
      content: `[ASINU_VOICE]${JSON.stringify(privateMedia(voice))}`,
    };
  }
  return message;
};

const projectMessage = (row) => {
  if (!row) return null;
  const {
    quoted_id: id,
    quoted_sender_type: senderType,
    quoted_sender_ref: senderRef,
    quoted_message_type: messageType,
    quoted_content: quotedContent,
    ...message
  } = row;
  const projected = hydrateMessageMedia(message);
  if (!id || typeof quotedContent !== 'string') return { ...projected, reply_to: null };
  const { content } = decryptMessage({ user_id: row.user_id, content: quotedContent });
  const kind = content.startsWith('[ASINU_ATTACHMENT]')
    ? 'attachment'
    : content.startsWith('[ASINU_VOICE]')
      ? 'voice'
      : 'text';
  return {
    ...projected,
    reply_to: {
      id,
      sender_type: senderType === 'doctor' && isSystemSender(senderRef) ? 'system' : senderType,
      message_type: messageType,
      kind,
      content: kind === 'text' ? Array.from(content).slice(0, 180).join('') : null,
    },
  };
};

const messageViewerJoin = (viewerType, viewerRef) => ({
  sql: `LEFT JOIN doctor_task_message_deletions d
          ON d.tenant_id = m.tenant_id AND d.task_id = m.task_id AND d.message_id = m.id
         AND d.viewer_type = $4 AND d.viewer_ref = $5
        LEFT JOIN doctor_task_messages quoted
          ON quoted.id = m.reply_to_message_id AND quoted.tenant_id = m.tenant_id
         AND quoted.task_id = m.task_id AND quoted.user_id = m.user_id
         AND quoted.deleted_at IS NULL AND m.deleted_at IS NULL AND d.message_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM doctor_task_message_deletions hidden
            WHERE hidden.tenant_id = quoted.tenant_id AND hidden.task_id = quoted.task_id
              AND hidden.message_id = quoted.id AND hidden.viewer_type = $4 AND hidden.viewer_ref = $5
         )`,
  params: [viewerType, String(viewerRef)],
});

const selectMessage = async (pool, tenantId, taskId, messageId, viewerType, viewerRef) => {
  const join = messageViewerJoin(viewerType, viewerRef);
  const result = await pool.query(
    `SELECT ${messageProjection}
       FROM doctor_task_messages m
       ${join.sql}
      WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.id = $3`,
    [tenantId, taskId, messageId, ...join.params]
  );
  return projectMessage(result.rows[0]);
};

const loadOwnedTask = async (pool, tenantId, taskId, userId) => {
  const result = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id,
            payload->'payload'->>'summary' AS summary
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->>'event_type' = 'doctor.task.requested'
        AND payload->'payload'->>'task_id' = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId, taskId]
  );
  if (!result.rows[0] || result.rows[0].app_user_id !== String(userId)) {
    throw integrationError(
      404,
      'DOCTOR_TASK_NOT_FOUND',
      'The Doctor task was not found for this patient.'
    );
  }
  const lifecycle = await pool.query(
    `SELECT status, doctor_ref, payload->>'follow_up_until' AS follow_up_until
       FROM doctor_task_lifecycle_events
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT 1`,
    [tenantId, taskId]
  );
  return {
    ...result.rows[0],
    lifecycle_status: lifecycle.rows[0]?.status || null,
    doctor_ref: lifecycle.rows[0]?.doctor_ref || null,
    follow_up_until: lifecycle.rows[0]?.follow_up_until || null,
  };
};

const listMessages = async (
  pool,
  tenantId,
  taskId,
  userId,
  viewerType = 'patient',
  viewerRef = String(userId)
) => {
  assertTenantAllowed(tenantId);
  const task = await loadOwnedTask(pool, tenantId, taskId, userId);
  const join = messageViewerJoin(viewerType, viewerRef);
  const result = await pool.query(
    `SELECT ${messageProjection}
       FROM doctor_task_messages m
       ${join.sql}
      WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.user_id = $3
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 500`,
    [tenantId, taskId, userId, ...join.params]
  );
  const messages = result.rows.map((row) => {
    const message = projectMessage(row);
    return viewerType === 'patient' &&
      message.sender_type === 'doctor' &&
      isSystemSender(message.sender_ref)
      ? { ...message, sender_type: 'system' }
      : message;
  });
  const pinned = messages
    .filter((message) => message.is_pinned && !message.is_deleted && !message.is_deleted_for_me)
    .sort((a, b) => new Date(b.pinned_at) - new Date(a.pinned_at));
  return {
    task_id: taskId,
    summary: task.summary || null,
    initial_request: readConsultationInitialRequest(task.summary),
    messages,
    pinned_message: pinned[0] || null,
    typing: await listTyping(pool, tenantId, taskId, viewerType, viewerRef),
  };
};

const insertMessage = async (client, input) => {
  const inserted = await client.query(
    `INSERT INTO doctor_task_messages(
       tenant_id, task_id, user_id, sender_type, sender_ref,
       message_type, content, client_message_id, reply_to_message_id
     ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::uuid
        WHERE $9::uuid IS NULL OR EXISTS (
          SELECT 1 FROM doctor_task_messages target
           WHERE target.id = $9::uuid AND target.tenant_id = $1 AND target.task_id = $2
             AND target.user_id = $3 AND target.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM doctor_task_message_deletions hidden
                WHERE hidden.tenant_id = $1 AND hidden.task_id = $2 AND hidden.message_id = target.id
                  AND hidden.viewer_type = $4 AND hidden.viewer_ref = $5
             )
        )
     ON CONFLICT (tenant_id, task_id, client_message_id) DO NOTHING
     RETURNING ${RAW_MESSAGE_COLUMNS}`,
    [
      input.tenantId,
      input.taskId,
      input.userId,
      input.senderType,
      input.senderRef || null,
      input.messageType,
      encryptHealthField(input.userId, 'doctor_task_messages.content', input.content),
      input.clientMessageId,
      input.replyToMessageId ?? null,
    ]
  );
  if (inserted.rows[0]) return { ...decryptMessage(inserted.rows[0]), duplicate: false };
  const existing = await client.query(
    `SELECT ${RAW_MESSAGE_COLUMNS}
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND client_message_id = $3`,
    [input.tenantId, input.taskId, input.clientMessageId]
  );
  const message = decryptMessage(existing.rows[0]);
  if (!message && input.replyToMessageId) {
    throw integrationError(
      404,
      'MESSAGE_NOT_FOUND',
      'The message being replied to is unavailable.'
    );
  }
  if (
    !message ||
    message.sender_type !== input.senderType ||
    message.content !== input.content ||
    (message.reply_to_message_id ?? null) !== (input.replyToMessageId ?? null)
  ) {
    throw integrationError(
      409,
      'MESSAGE_IDEMPOTENCY_CONFLICT',
      'The message id was reused with different content.'
    );
  }
  return { ...message, duplicate: true };
};

const insertIvrQuestionMessage = (client, { tenantId, taskId, userId, sessionId, language }) =>
  insertMessage(client, {
    tenantId,
    taskId,
    userId,
    senderType: 'doctor',
    senderRef: ivrQuestionSender,
    messageType: 'question',
    content: t('notification.doctor_ivr_request_title', language),
    clientMessageId: sessionId,
  });

const sendPatientMessage = async (pool, { userId, taskId, input }) => {
  assertTenantAllowed(input.tenant_id);
  const task = await loadOwnedTask(pool, input.tenant_id, taskId, userId);
  if (
    !isDoctorTaskMessageable(
      { status: task.lifecycle_status, followUpUntil: task.follow_up_until },
      input.message_type
    )
  ) {
    throw integrationError(409, 'TASK_NOT_MESSAGEABLE', 'The consultation conversation is closed.');
  }
  const client = await pool.connect();
  let doctorEnvelope = null;
  try {
    await client.query('BEGIN');
    const message = await insertMessage(client, {
      tenantId: input.tenant_id,
      taskId,
      userId,
      senderType: 'patient',
      senderRef: String(userId),
      messageType: input.message_type,
      content: input.content,
      clientMessageId: input.client_message_id,
      replyToMessageId: input.reply_to_message_id,
    });
    if (!message.duplicate) {
      const eventId = `doctor.task.message.received:${message.id}`;
      const envelope = {
        event_id: eventId,
        idempotency_key: eventId,
        event_type: 'doctor.task.message.received',
        occurred_at: new Date(message.created_at).toISOString(),
        source: 'asinu-backend',
        version: 1,
        tenant_id: input.tenant_id,
        payload: {
          task_id: taskId,
          app_user_id: String(userId),
          message_id: String(message.id),
        },
      };
      doctorEnvelope = envelope;
      await client.query(
        `INSERT INTO doctor_task_outbox(event_id, idempotency_key, tenant_id, payload)
         VALUES ($1,$1,$2,$3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, input.tenant_id, JSON.stringify(envelope)]
      );
    }
    await client.query('COMMIT');
    // Push immediately to Doctor while retaining the durable outbox as a
    // retry path. A failed direct call must never make the patient's send
    // fail or create a duplicate message.
    if (doctorEnvelope) {
      void deliverDoctorRequest('messages', doctorEnvelope, doctorEnvelope.idempotency_key).catch(
        (error) => {
          logger.warn('doctor_message_direct_delivery_failed', {
            event_id: doctorEnvelope.event_id,
            task_id: taskId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      );
    }
    await rebuildPatientHealthTimeline(pool, userId);
    broadcastChatEvent({
      tenantId: input.tenant_id,
      taskId,
      type: 'chat.message.changed',
      data: { task_id: taskId, message_id: String(message.id), action: 'created' },
    });
    return message.reply_to_message_id
      ? {
          ...(await selectMessage(client, input.tenant_id, taskId, message.id, 'patient', userId)),
          duplicate: message.duplicate,
        }
      : message;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const sendPatientAttachment = async (pool, { userId, taskId, input, file }) => {
  assertTenantAllowed(input.tenant_id);
  await loadOwnedTask(pool, input.tenant_id, taskId, userId);
  if (
    !file?.buffer ||
    file.buffer.length > 10 * 1024 * 1024 ||
    !isSupportedPatientFile(file.buffer, file.mimetype)
  ) {
    throw integrationError(
      400,
      'INVALID_PATIENT_FILE',
      'A valid image or PDF up to 10 MB is required.'
    );
  }

  // Check the message key before touching Cloudinary. A mobile retry must not
  // create another file when the original message was already persisted.
  const findUploadedAttachment = async () => {
    const {
      rows: [row],
    } = await pool.query(
      `SELECT ${RAW_MESSAGE_COLUMNS}
         FROM doctor_task_messages
        WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND client_message_id = $4`,
      [input.tenant_id, taskId, userId, input.client_message_id]
    );
    if (!row) return null;
    const existing = decryptMessage(row);
    const attachment = parseAttachment(existing.content);
    if (
      existing.sender_type !== 'patient' ||
      existing.message_type !== input.message_type ||
      !attachment ||
      (existing.reply_to_message_id ?? null) !== (input.reply_to_message_id ?? null)
    ) {
      throw integrationError(
        409,
        'MESSAGE_IDEMPOTENCY_CONFLICT',
        'The message id was reused with different data.'
      );
    }
    return {
      ...hydrateMessageMedia(existing),
      duplicate: true,
      attachment: privateMedia(attachment),
    };
  };
  const existing = await findUploadedAttachment();
  if (existing) return existing;

  try {
    requirePrivateDeliveryConfig();
  } catch {
    throw integrationError(
      503,
      'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED',
      'Private file delivery is not configured.'
    );
  }
  const resourceType = resourceTypeForMime(file.mimetype);
  const uploaded = await uploadBuffer(file.buffer, {
    folder: process.env.CLOUDINARY_PATIENT_FILE_FOLDER || 'asinu/patient-files',
    resource_type: resourceType,
    type: 'authenticated',
    ...(resourceType === 'raw'
      ? { public_id: `${crypto.randomUUID()}.pdf` }
      : { use_filename: true, unique_filename: true }),
  });
  let attachment;
  const discardUpload = async () => {
    if (attachment) {
      await pool
        .query('DELETE FROM doctor_patient_files WHERE id = $1 AND user_id = $2', [
          attachment.id,
          userId,
        ])
        .catch(() => {});
    }
    if (uploaded.public_id) {
      await deleteAsset(uploaded.public_id, resourceType, 'authenticated').catch(() => {});
    }
  };
  try {
    const privateUrl = authenticatedAssetUrl(
      uploaded.public_id,
      resourceType,
      'authenticated',
      file.mimetype
    );
    if (!privateUrl)
      throw integrationError(
        503,
        'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED',
        'Private file delivery is not configured.'
      );
    const fileResult = await pool.query(
      `INSERT INTO doctor_patient_files
        (user_id, name, mime_type, size_bytes, secure_url, public_id, resource_type, delivery_type, source_task_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'authenticated',$8,$9)
       RETURNING id, name, mime_type, size_bytes, secure_url, public_id, resource_type, delivery_type, source_task_id, uploaded_by, created_at`,
      [
        userId,
        String(file.originalname).slice(0, 255),
        file.mimetype,
        file.buffer.length,
        privateUrl,
        uploaded.public_id,
        resourceType,
        taskId,
        String(userId),
      ]
    );
    attachment = fileResult.rows[0];
    const content = `[ASINU_ATTACHMENT]${JSON.stringify({
      id: String(attachment.id),
      name: attachment.name,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      public_id: attachment.public_id,
      resource_type: attachment.resource_type,
      delivery_type: attachment.delivery_type,
    })}`;
    const message = await sendPatientMessage(pool, {
      userId,
      taskId,
      input: { ...input, content },
    });
    if (message.duplicate) {
      // Two identical uploads can pass the pre-check concurrently. The
      // message unique constraint is the final authority; remove the losing
      // file and return the already-persisted attachment.
      await discardUpload();
      const existingAttachment = parseAttachment(message.content);
      return {
        ...hydrateMessageMedia(message),
        ...(existingAttachment ? { attachment: privateMedia(existingAttachment) } : {}),
      };
    }
    return {
      ...hydrateMessageMedia(message),
      attachment: privateMedia(attachment),
    };
  } catch (error) {
    // Reconcile a retry that overlapped a previous upload with the same key.
    const retained = await findUploadedAttachment().catch(() => null);
    const committedAttachment = retained && parseAttachment(retained.content);
    if (attachment && committedAttachment?.id === String(attachment.id)) {
      return retained;
    }
    await discardUpload();
    if (retained) return retained;
    throw error;
  }
};

const sendPatientVoice = async (pool, { userId, taskId, input, file, durationMs }) => {
  assertTenantAllowed(input.tenant_id);
  const task = await loadOwnedTask(pool, input.tenant_id, taskId, userId);
  if (
    !isDoctorTaskMessageable(
      { status: task.lifecycle_status, followUpUntil: task.follow_up_until },
      'voice'
    )
  ) {
    throw integrationError(409, 'TASK_NOT_MESSAGEABLE', 'The consultation conversation is closed.');
  }
  if (
    !file?.buffer ||
    file.size <= 0 ||
    file.size > 10 * 1024 * 1024 ||
    !isAudioBuffer(file.buffer)
  ) {
    throw integrationError(
      400,
      'INVALID_AUDIO_FILE',
      'A valid audio file up to 10 MB is required.'
    );
  }
  try {
    requirePrivateDeliveryConfig();
  } catch {
    throw integrationError(
      503,
      'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED',
      'Private file delivery is not configured.'
    );
  }
  const duration = Number(durationMs || 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 10 * 60 * 1000) {
    throw integrationError(400, 'INVALID_AUDIO_DURATION', 'Audio duration is invalid.');
  }
  const existingMessage = await pool.query(
    `SELECT ${RAW_MESSAGE_COLUMNS}
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND client_message_id = $4`,
    [input.tenant_id, taskId, userId, input.client_message_id]
  );
  if (existingMessage.rows[0]) {
    const existing = decryptMessage(existingMessage.rows[0]);
    if (
      existing.sender_type !== 'patient' ||
      existing.message_type !== 'voice' ||
      (existing.reply_to_message_id ?? null) !== (input.reply_to_message_id ?? null)
    ) {
      throw integrationError(
        409,
        'MESSAGE_IDEMPOTENCY_CONFLICT',
        'The message id was reused with different data.'
      );
    }
    const voice = parseVoice(existing.content);
    return {
      ...hydrateMessageMedia(existing),
      duplicate: true,
      ...(voice ? { voice: privateMedia(voice) } : {}),
    };
  }
  const uploaded = await uploadBuffer(file.buffer, {
    folder: process.env.CLOUDINARY_DOCTOR_VOICE_FOLDER || 'asinu/doctor-voice',
    resource_type: 'video',
    type: 'authenticated',
    use_filename: true,
    unique_filename: true,
  });
  try {
    const message = await sendPatientMessage(pool, {
      userId,
      taskId,
      input: {
        ...input,
        message_type: 'voice',
        content: `[ASINU_VOICE]${JSON.stringify({
          name: String(file.originalname || 'voice-message').slice(0, 255),
          mime_type: file.mimetype,
          size_bytes: file.size,
          duration_ms: Math.round(duration),
          public_id: uploaded.public_id,
          resource_type: 'video',
          delivery_type: 'authenticated',
          url: authenticatedAssetUrl(uploaded.public_id, 'video', 'authenticated', file.mimetype),
        })}`,
      },
    });
    if (message.duplicate && uploaded.public_id)
      await deleteAsset(uploaded.public_id, 'video', 'authenticated').catch(() => {});
    const voice = parseVoice(message.content);
    return {
      ...hydrateMessageMedia(message),
      ...(voice ? { voice: privateMedia(voice) } : {}),
    };
  } catch (error) {
    if (uploaded.public_id)
      await deleteAsset(uploaded.public_id, 'video', 'authenticated').catch(() => {});
    throw error;
  }
};

const listTyping = async (pool, tenantId, taskId, viewerType, _viewerRef) => {
  await pool.query('DELETE FROM doctor_task_typing_indicators WHERE expires_at <= NOW()');
  const result = await pool.query(
    `SELECT actor_type, actor_ref, expires_at
       FROM doctor_task_typing_indicators
      WHERE tenant_id = $1 AND task_id = $2 AND actor_type <> $3 AND expires_at > NOW()
      ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, taskId, viewerType]
  );
  const row = result.rows[0];
  return row
    ? { actor_type: row.actor_type, expires_at: row.expires_at, is_typing: true }
    : { actor_type: null, expires_at: null, is_typing: false };
};

const markMessagesRead = async (
  pool,
  { tenantId, taskId, userId, actorType, actorRef, messageIds }
) => {
  assertTenantAllowed(tenantId);
  await loadOwnedTask(pool, tenantId, taskId, userId);
  const ids = Array.isArray(messageIds) ? messageIds.slice(0, 100) : [];
  if (!ids.length) return { updated: 0 };
  const result = await pool.query(
    `UPDATE doctor_task_messages
        SET read_at = NOW(), read_by_type = $4, read_by_ref = $5
      WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3
        AND id = ANY($6::uuid[]) AND sender_type <> $4 AND read_at IS NULL
      RETURNING id`,
    [tenantId, taskId, userId, actorType, String(actorRef), ids]
  );
  return { updated: result.rowCount || 0 };
};

const setTyping = async (pool, { tenantId, taskId, userId, actorType, actorRef, isTyping }) => {
  assertTenantAllowed(tenantId);
  await loadOwnedTask(pool, tenantId, taskId, userId);
  if (isTyping) {
    await pool.query(
      `INSERT INTO doctor_task_typing_indicators(tenant_id, task_id, actor_type, actor_ref, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW() + ($5 * INTERVAL '1 millisecond'),NOW())
       ON CONFLICT (tenant_id, task_id, actor_type, actor_ref)
       DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [tenantId, taskId, actorType, String(actorRef), TYPING_TTL_MS]
    );
  } else {
    await pool.query(
      `DELETE FROM doctor_task_typing_indicators
        WHERE tenant_id = $1 AND task_id = $2 AND actor_type = $3 AND actor_ref = $4`,
      [tenantId, taskId, actorType, String(actorRef)]
    );
  }
  return listTyping(pool, tenantId, taskId, actorType, actorRef);
};

const loadRawMessage = async (pool, tenantId, taskId, messageId) => {
  const result = await pool.query(
    `SELECT ${RAW_MESSAGE_COLUMNS}
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND id = $3`,
    [tenantId, taskId, messageId]
  );
  return decryptMessage(result.rows[0] || null);
};

const assertOwnMessage = (message, actorType, actorRef) => {
  if (
    !message ||
    message.sender_type !== actorType ||
    String(message.sender_ref) !== String(actorRef)
  ) {
    throw integrationError(
      403,
      'MESSAGE_NOT_OWNED',
      'You can only edit or unsend your own messages.'
    );
  }
  if (message.deleted_at)
    throw integrationError(
      409,
      'MESSAGE_ALREADY_DELETED',
      'This message has already been removed.'
    );
  if (new Date(message.created_at).getTime() + MESSAGE_EDIT_WINDOW_MS < Date.now()) {
    throw integrationError(
      409,
      'MESSAGE_ACTION_EXPIRED',
      'This message can no longer be edited or unsent.'
    );
  }
};

const setMessageReaction = async (
  pool,
  { tenantId, taskId, userId, actorType, actorRef, messageId, reaction }
) => {
  const params = [tenantId, taskId, userId, messageId, actorType, String(actorRef)];
  const change =
    reaction === null
      ? `DELETE FROM doctor_task_message_reactions
        WHERE message_id IN (SELECT id FROM target) AND actor_type = $5 AND actor_ref = $6`
      : `INSERT INTO doctor_task_message_reactions(message_id, actor_type, actor_ref, emoji)
       SELECT id, $5, $6, $7 FROM target
       ON CONFLICT (message_id, actor_type, actor_ref) DO UPDATE SET emoji = EXCLUDED.emoji
        WHERE doctor_task_message_reactions.emoji IS DISTINCT FROM EXCLUDED.emoji`;
  if (reaction !== null) params.push(reaction);
  const {
    rows: [result],
  } = await pool.query(
    `WITH target AS (
       SELECT m.id FROM doctor_task_messages m
        WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.user_id = $3 AND m.id = $4
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM doctor_task_message_deletions d
             WHERE d.tenant_id = $1 AND d.task_id = $2 AND d.message_id = m.id
               AND d.viewer_type = $5 AND d.viewer_ref = $6
          )
        FOR UPDATE
     ), changed AS (
       ${change}
       RETURNING 1
     ) SELECT EXISTS (SELECT 1 FROM target) AS visible, EXISTS (SELECT 1 FROM changed) AS changed`,
    params
  );
  if (!result.visible) {
    throw integrationError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
  }
  return result.changed;
};

const messageAction = async (pool, input) => {
  const { tenantId, taskId, userId, actorType, actorRef, action, messageId } = input;
  assertTenantAllowed(tenantId);
  const task = await loadOwnedTask(pool, tenantId, taskId, userId);
  if (action === 'react') {
    if (!messageId || input.reaction === undefined) {
      throw integrationError(400, 'INVALID_MESSAGE_ACTION', 'A message and reaction are required.');
    }
    if (
      !isDoctorTaskMessageable(
        { status: task.lifecycle_status, followUpUntil: task.follow_up_until },
        'follow_up'
      )
    ) {
      throw integrationError(
        409,
        'TASK_NOT_MESSAGEABLE',
        'The consultation conversation is closed.'
      );
    }
    if (await setMessageReaction(pool, input)) {
      broadcastChatEvent({
        tenantId,
        taskId,
        type: 'chat.message.changed',
        data: { task_id: taskId, message_id: String(messageId), action },
      });
      if (actorType === 'patient')
        relayDoctorChatChange({ tenantId, taskId, userId, action, messageId });
    }
    return selectMessage(pool, tenantId, taskId, messageId, actorType, actorRef);
  }
  if (action === 'read') {
    const result = await markMessagesRead(pool, { ...input, actorType, actorRef });
    if (result.updated > 0) {
      broadcastChatEvent({
        tenantId,
        taskId,
        type: 'chat.message.changed',
        data: { task_id: taskId, action: 'read', message_ids: input.messageIds },
      });
      if (actorType === 'patient') {
        relayDoctorChatChange({
          tenantId,
          taskId,
          userId,
          action: 'read',
          messageIds: input.messageIds,
        });
      }
    }
    return result;
  }
  if (action === 'typing') {
    const result = await setTyping(pool, {
      ...input,
      actorType,
      actorRef,
      isTyping: input.isTyping === true,
    });
    broadcastChatEvent({
      tenantId,
      taskId,
      type: 'chat.typing.changed',
      data: {
        task_id: taskId,
        actor_type: actorType,
        is_typing: input.isTyping === true,
        expires_at: result.expires_at || null,
      },
    });
    if (actorType === 'patient') {
      const typingKey = `${tenantId}:${taskId}:${userId}`;
      const typingState = input.isTyping === true;
      const previous = typingRelayState.get(typingKey);
      const shouldRelay =
        !previous || previous.isTyping !== typingState || Date.now() - previous.relayedAt >= 1000;
      if (shouldRelay) {
        typingRelayState.set(typingKey, { isTyping: typingState, relayedAt: Date.now() });
        relayDoctorChatChange({
          tenantId,
          taskId,
          userId,
          action: 'typing',
          isTyping: typingState,
        });
      }
    }
    return result;
  }
  if (action === 'delete_for_me') {
    if (!messageId) throw integrationError(400, 'MESSAGE_ID_REQUIRED', 'A message id is required.');
    const target = await loadRawMessage(pool, tenantId, taskId, messageId);
    if (!target) throw integrationError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
    await pool.query(
      `INSERT INTO doctor_task_message_deletions(tenant_id, task_id, message_id, viewer_type, viewer_ref)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tenantId, taskId, messageId, actorType, String(actorRef)]
    );
  } else {
    if (!messageId) throw integrationError(400, 'MESSAGE_ID_REQUIRED', 'A message id is required.');
    const target = await loadRawMessage(pool, tenantId, taskId, messageId);
    if (!target) throw integrationError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
    if (action === 'edit' || action === 'unsend') {
      assertOwnMessage(target, actorType, actorRef);
      if (
        !isDoctorTaskMessageable(
          { status: task.lifecycle_status, followUpUntil: task.follow_up_until },
          target.message_type
        )
      ) {
        throw integrationError(
          409,
          'TASK_NOT_MESSAGEABLE',
          'The consultation conversation is closed.'
        );
      }
    }
    if (action === 'edit') {
      if (
        target.message_type === 'voice' ||
        parseAttachment(target.content) ||
        parseVoice(target.content)
      ) {
        throw integrationError(409, 'MESSAGE_NOT_EDITABLE', 'Only text messages can be edited.');
      }
      const content = String(input.content || '').trim();
      if (!content || content.length > 5000)
        throw integrationError(400, 'INVALID_MESSAGE_CONTENT', 'Message content is invalid.');
      await pool.query(
        `UPDATE doctor_task_messages SET content = $4, edited_at = NOW()
          WHERE tenant_id = $1 AND task_id = $2 AND id = $3`,
        [
          tenantId,
          taskId,
          messageId,
          encryptHealthField(userId, 'doctor_task_messages.content', content),
        ]
      );
    } else if (action === 'unsend') {
      await pool.query(
        `UPDATE doctor_task_messages
            SET deleted_at = NOW(), deleted_by_type = $4, deleted_by_ref = $5
          WHERE tenant_id = $1 AND task_id = $2 AND id = $3`,
        [tenantId, taskId, messageId, actorType, String(actorRef)]
      );
    } else if (action === 'pin' || action === 'unpin') {
      await pool.query(
        `UPDATE doctor_task_messages
            SET pinned_at = ${action === 'pin' ? 'NOW()' : 'NULL'},
                pinned_by_type = ${action === 'pin' ? '$4' : 'NULL'},
                pinned_by_ref = ${action === 'pin' ? '$5' : 'NULL'}
          WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL`,
        action === 'pin'
          ? [tenantId, taskId, messageId, actorType, String(actorRef)]
          : [tenantId, taskId, messageId]
      );
    } else {
      throw integrationError(400, 'INVALID_MESSAGE_ACTION', 'Unsupported message action.');
    }
  }
  await rebuildPatientHealthTimeline(pool, userId);
  broadcastChatEvent({
    tenantId,
    taskId,
    type: 'chat.message.changed',
    data: {
      task_id: taskId,
      message_id: String(messageId),
      action,
      message_ids: action === 'read' ? input.messageIds : undefined,
    },
  });
  if (actorType === 'patient' && action !== 'delete_for_me') {
    relayDoctorChatChange({ tenantId, taskId, userId, action, messageId });
  }
  return selectMessage(pool, tenantId, taskId, messageId, actorType, actorRef);
};

const listPatientTasks = async (pool, userId, tenantId) => {
  assertTenantAllowed(tenantId);
  const result = await pool.query(
    `SELECT o.tenant_id,
            payload->'payload'->>'task_id' AS task_id,
            lifecycle.status,
            lifecycle.follow_up_until,
            payload->'payload'->>'summary' AS summary,
            COALESCE((o.payload->>'occurred_at')::timestamptz, o.created_at::timestamptz) AS created_at,
            CASE
              WHEN latest.deleted_at IS NOT NULL OR latest.deleted_for_me IS NOT NULL THEN NULL
              ELSE latest.content
            END AS latest_message,
            latest.sender_type AS latest_sender_type,
            latest.created_at AS latest_message_at
       FROM doctor_task_outbox o
       LEFT JOIN LATERAL (
         SELECT m.content, m.sender_type, m.created_at, m.deleted_at, d.message_id AS deleted_for_me
           FROM doctor_task_messages m
           LEFT JOIN doctor_task_message_deletions d
             ON d.tenant_id = m.tenant_id AND d.task_id = m.task_id AND d.message_id = m.id
            AND d.viewer_type = 'patient' AND d.viewer_ref = $1::text
          WHERE m.tenant_id = o.tenant_id
            AND m.task_id = o.payload->'payload'->>'task_id'
            AND m.user_id = $1::integer
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT e.status AS status,
                e.payload->>'follow_up_until' AS follow_up_until
           FROM doctor_task_lifecycle_events e
          WHERE e.tenant_id = o.tenant_id
            AND e.task_id = o.payload->'payload'->>'task_id'
          ORDER BY e.occurred_at DESC, e.created_at DESC
          LIMIT 1
       ) lifecycle ON TRUE
      WHERE o.tenant_id = $2
        AND o.payload->>'event_type' = 'doctor.task.requested'
        AND o.payload->'payload'->>'app_user_id' = $1::text
      ORDER BY COALESCE(latest.created_at::timestamptz, o.created_at::timestamptz) DESC
      LIMIT 100`,
    [userId, tenantId]
  );
  return {
    tasks: result.rows.map((task) => ({
      ...task,
      latest_message: task.latest_message
        ? hydrateMessageMedia({ content: task.latest_message, user_id: userId }).content
        : task.latest_message,
    })),
  };
};

const queryDoctorMessages = async (pool, req, input) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  return listMessages(
    pool,
    tenantId,
    taskId,
    appUserId,
    'doctor',
    input.viewer_ref || input.sender_ref || 'doctor'
  );
};

const sendDoctorMessage = async (pool, req, input) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  const task = await loadOwnedTask(pool, tenantId, taskId, appUserId);
  if (
    !isDoctorTaskMessageable(
      { status: task.lifecycle_status, followUpUntil: task.follow_up_until },
      input.message_type
    )
  ) {
    throw integrationError(409, 'TASK_NOT_MESSAGEABLE', 'The consultation conversation is closed.');
  }
  const content = await resolveDoctorAttachmentContent(pool, {
    content: input.content,
    appUserId,
    taskId,
    senderRef: input.sender_ref,
  });
  const message = await insertMessage(pool, {
    tenantId,
    taskId,
    userId: appUserId,
    senderType: 'doctor',
    senderRef: input.sender_ref,
    messageType: input.message_type,
    content,
    clientMessageId: input.client_message_id,
    replyToMessageId: input.reply_to_message_id,
  });
  if (!message.duplicate) {
    const user = await pool.query(
      `SELECT id, push_token, COALESCE(language_preference, 'vi') AS language
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [appUserId]
    );
    if (user.rows[0]) {
      const lang = user.rows[0].language === 'en' ? 'en' : 'vi';
      const systemMessage = isSystemSender(input.sender_ref);
      const doctorName =
        !systemMessage && typeof input.sender_name === 'string' ? input.sender_name.trim() : '';
      const voice = parseVoice(input.content);
      const attachment = parseAttachment(content);
      const preview = voice
        ? t('push.doctor_voice_preview', lang)
        : attachment
          ? t('push.doctor_attachment_preview', lang)
          : content.slice(0, 180);
      const messagePreview = doctorName
        ? t('push.doctor_message_preview', lang, { name: doctorName, preview })
        : preview;
      await sendAndSave(
        pool,
        user.rows[0],
        'doctor_message',
        t(systemMessage ? 'push.doctor_system_message_title' : 'push.doctor_message_title', lang),
        messagePreview,
        {
          type: 'doctor_message',
          task_id: taskId,
          tenant_id: tenantId,
          message_id: String(message.id),
        },
        'high',
        {
          // Do not put the patient's health details on the device lock screen.
          pushBody: systemMessage
            ? t('push.doctor_system_lockscreen', lang)
            : doctorName
              ? t('push.doctor_lockscreen_named', lang, { name: doctorName })
              : t('push.doctor_lockscreen_generic', lang),
        }
      );
    }
    broadcastChatEvent({
      tenantId,
      taskId,
      type: 'chat.message.changed',
      data: { task_id: taskId, message_id: String(message.id), action: 'created' },
    });
  }
  await rebuildPatientHealthTimeline(pool, appUserId);
  if (message.reply_to_message_id) {
    return {
      ...(await selectMessage(pool, tenantId, taskId, message.id, 'doctor', input.sender_ref)),
      duplicate: message.duplicate,
    };
  }
  return parseAttachment(content) ? hydrateMessageMedia(message) : message;
};

const sendDoctorVoice = async (pool, req, input) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  if (typeof input.content_base64 !== 'string' || input.content_base64.length > 14 * 1024 * 1024) {
    throw integrationError(
      400,
      'INVALID_AUDIO_FILE',
      'A valid audio file up to 10 MB is required.'
    );
  }
  const buffer = Buffer.from(input.content_base64, 'base64');
  if (
    !buffer.length ||
    buffer.length > 10 * 1024 * 1024 ||
    input.size_bytes !== buffer.length ||
    typeof input.mime_type !== 'string' ||
    !input.mime_type.startsWith('audio/') ||
    !isAudioBuffer(buffer)
  ) {
    throw integrationError(
      400,
      'INVALID_AUDIO_FILE',
      'A valid audio file up to 10 MB is required.'
    );
  }
  try {
    requirePrivateDeliveryConfig();
  } catch {
    throw integrationError(
      503,
      'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED',
      'Private file delivery is not configured.'
    );
  }
  const duration = Number(input.duration_ms || 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 10 * 60 * 1000) {
    throw integrationError(400, 'INVALID_AUDIO_DURATION', 'Audio duration is invalid.');
  }
  const uploaded = await uploadBuffer(buffer, {
    folder: process.env.CLOUDINARY_DOCTOR_VOICE_FOLDER || 'asinu/doctor-voice',
    resource_type: 'video',
    type: 'authenticated',
    use_filename: true,
    unique_filename: true,
  });
  try {
    const message = await sendDoctorMessage(pool, req, {
      tenant_id: tenantId,
      app_user_id: appUserId,
      task_id: taskId,
      sender_ref: input.sender_ref,
      sender_name: input.sender_name,
      message_type: 'voice',
      client_message_id: input.client_message_id,
      reply_to_message_id: input.reply_to_message_id,
      content: `[ASINU_VOICE]${JSON.stringify({
        name: String(input.file_name || 'voice-message').slice(0, 255),
        mime_type: input.mime_type || 'audio/webm',
        size_bytes: buffer.length,
        duration_ms: Math.round(duration),
        public_id: uploaded.public_id,
        resource_type: 'video',
        delivery_type: 'authenticated',
        url: authenticatedAssetUrl(
          uploaded.public_id,
          'video',
          'authenticated',
          input.mime_type || 'audio/webm'
        ),
      })}`,
    });
    if (message.duplicate && uploaded.public_id)
      await deleteAsset(uploaded.public_id, 'video', 'authenticated').catch(() => {});
    const voice = parseVoice(message.content);
    return {
      ...hydrateMessageMedia(message),
      ...(voice ? { voice: privateMedia(voice) } : {}),
    };
  } catch (error) {
    if (uploaded.public_id)
      await deleteAsset(uploaded.public_id, 'video', 'authenticated').catch(() => {});
    throw error;
  }
};

const doctorMessageAction = async (pool, req, input) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  return messageAction(pool, {
    tenantId,
    taskId,
    userId: appUserId,
    actorType: 'doctor',
    actorRef: input.actor_ref || input.sender_ref || 'doctor',
    action: input.action,
    messageId: input.message_id,
    content: input.content,
    messageIds: input.message_ids,
    isTyping: input.is_typing,
    reaction: input.reaction,
  });
};

module.exports = {
  loadOwnedTask,
  listMessages,
  insertIvrQuestionMessage,
  listPatientTasks,
  sendPatientMessage,
  sendPatientAttachment,
  sendPatientVoice,
  messageAction,
  queryDoctorMessages,
  sendDoctorMessage,
  sendDoctorVoice,
  doctorMessageAction,
  isDoctorTaskMessageable,
};
