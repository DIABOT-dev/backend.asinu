const { sendAndSave } = require('../notification/basic.notification.service');
const { assertTenantAllowed, deliverDoctorRequest } = require('./doctor-task.service');
const { verifyDoctorSignature, assertProfileRequest } = require('./doctor-profile.service');
const { uploadBuffer, deleteAsset } = require('../media/cloudinary-upload.service');
const {
  authenticatedAssetUrl,
  requirePrivateDeliveryConfig,
  resourceTypeForMime,
} = require('../media/private-media.service');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');
const { isAudioBuffer } = require('../../middleware/upload.middleware');
const { broadcastChatEvent } = require('./doctor-chat-realtime');
const logger = require('../../lib/logger');
const crypto = require('crypto');

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
  pinned_by_ref`;

const messageProjection = `
  m.id, m.task_id, m.sender_type, m.sender_ref, m.message_type,
  CASE WHEN m.deleted_at IS NOT NULL OR d.message_id IS NOT NULL THEN NULL ELSE m.content END AS content,
  m.client_message_id, m.created_at, m.delivered_at, m.read_at, m.read_by_type,
  m.read_by_ref, m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by_type,
  m.pinned_by_ref, (m.deleted_at IS NOT NULL) AS is_deleted,
  (d.message_id IS NOT NULL) AS is_deleted_for_me,
  (m.edited_at IS NOT NULL) AS is_edited,
  (m.pinned_at IS NOT NULL) AS is_pinned,
  CASE WHEN m.read_at IS NOT NULL THEN 'seen' ELSE 'sent' END AS delivery_status`;

const isDoctorTaskMessageable = ({ status, followUpUntil }, messageType, now = new Date()) => {
  if (!status || !status.length) return true;
  if (TERMINAL_LIFECYCLE_STATUSES.has(status)) return false;
  if (status !== 'completed') return true;
  return (
    ['follow_up', 'voice'].includes(messageType) &&
    Boolean(followUpUntil && new Date(followUpUntil).getTime() > now.getTime())
  );
};

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
    url: authenticatedAssetUrl(media.public_id, resourceType, media.delivery_type),
  };
};

const hydrateMessageMedia = (message) => {
  if (!message || typeof message.content !== 'string') return message;
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

const messageViewerJoin = (viewerType, viewerRef) => ({
  sql: `LEFT JOIN doctor_task_message_deletions d
          ON d.tenant_id = m.tenant_id AND d.task_id = m.task_id AND d.message_id = m.id
         AND d.viewer_type = $4 AND d.viewer_ref = $5`,
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
  return hydrateMessageMedia(result.rows[0] || null);
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
    `SELECT status, payload->>'follow_up_until' AS follow_up_until
       FROM doctor_task_lifecycle_events
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT 1`,
    [tenantId, taskId]
  );
  return {
    ...result.rows[0],
    lifecycle_status: lifecycle.rows[0]?.status || null,
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
  const messages = result.rows.map(hydrateMessageMedia);
  const pinned = messages.filter((message) => message.is_pinned && !message.is_deleted);
  return {
    task_id: taskId,
    summary: task.summary || null,
    messages,
    pinned_message: pinned[pinned.length - 1] || null,
    typing: await listTyping(pool, tenantId, taskId, viewerType, viewerRef),
  };
};

const insertMessage = async (client, input) => {
  const inserted = await client.query(
    `INSERT INTO doctor_task_messages(
       tenant_id, task_id, user_id, sender_type, sender_ref,
       message_type, content, client_message_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, task_id, client_message_id) DO NOTHING
     RETURNING ${RAW_MESSAGE_COLUMNS}`,
    [
      input.tenantId,
      input.taskId,
      input.userId,
      input.senderType,
      input.senderRef || null,
      input.messageType,
      input.content,
      input.clientMessageId,
    ]
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], duplicate: false };
  const existing = await client.query(
    `SELECT ${RAW_MESSAGE_COLUMNS}
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND client_message_id = $3`,
    [input.tenantId, input.taskId, input.clientMessageId]
  );
  const message = existing.rows[0];
  if (!message || message.sender_type !== input.senderType || message.content !== input.content) {
    throw integrationError(
      409,
      'MESSAGE_IDEMPOTENCY_CONFLICT',
      'The message id was reused with different content.'
    );
  }
  return { ...message, duplicate: true };
};

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
    return message;
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
  if (!file?.buffer || file.size <= 0 || file.size > 10 * 1024 * 1024) {
    throw integrationError(400, 'INVALID_PATIENT_FILE', 'A valid image up to 10 MB is required.');
  }

  // Check the message key before touching Cloudinary. A mobile retry must not
  // create another file when the original message was already persisted.
  const existingMessage = await pool.query(
    `SELECT ${RAW_MESSAGE_COLUMNS}
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND client_message_id = $4`,
    [input.tenant_id, taskId, userId, input.client_message_id]
  );
  if (existingMessage.rows[0]) {
    const existing = existingMessage.rows[0];
    if (existing.sender_type !== 'patient' || existing.message_type !== input.message_type) {
      throw integrationError(
        409,
        'MESSAGE_IDEMPOTENCY_CONFLICT',
        'The message id was reused with different data.'
      );
    }
    const attachment = parseAttachment(existing.content);
    return {
      ...hydrateMessageMedia(existing),
      duplicate: true,
      ...(attachment ? { attachment: privateMedia(attachment) } : {}),
    };
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
  const uploaded = await uploadBuffer(file.buffer, {
    folder: process.env.CLOUDINARY_PATIENT_FILE_FOLDER || 'asinu/patient-files',
    resource_type: 'image',
    type: 'authenticated',
    use_filename: true,
    unique_filename: true,
  });
  const privateUrl = authenticatedAssetUrl(uploaded.public_id, 'image', 'authenticated');
  if (!privateUrl)
    throw integrationError(
      503,
      'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED',
      'Private file delivery is not configured.'
    );
  const fileResult = await pool.query(
    `INSERT INTO doctor_patient_files
      (user_id, name, mime_type, size_bytes, secure_url, public_id, resource_type, delivery_type, source_task_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'image','authenticated',$7,$8)
     RETURNING id, name, mime_type, size_bytes, secure_url, public_id, resource_type, delivery_type, source_task_id, uploaded_by, created_at`,
    [
      userId,
      String(file.originalname).slice(0, 255),
      file.mimetype,
      file.size,
      privateUrl,
      uploaded.public_id || null,
      taskId,
      String(userId),
    ]
  );
  const attachment = fileResult.rows[0];
  const content = `[ASINU_ATTACHMENT]${JSON.stringify({
    id: String(attachment.id),
    name: attachment.name,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    public_id: attachment.public_id,
    resource_type: attachment.resource_type,
    delivery_type: attachment.delivery_type,
    url: privateUrl,
  })}`;
  try {
    const message = await sendPatientMessage(pool, {
      userId,
      taskId,
      input: { ...input, content },
    });
    if (message.duplicate) {
      // Two identical uploads can pass the pre-check concurrently. The
      // message unique constraint is the final authority; remove the losing
      // file and return the already-persisted attachment.
      await pool
        .query('DELETE FROM doctor_patient_files WHERE id = $1 AND user_id = $2', [
          attachment.id,
          userId,
        ])
        .catch(() => {});
      if (uploaded.public_id)
        await deleteAsset(uploaded.public_id, 'image', 'authenticated').catch(() => {});
      const existingAttachment = parseAttachment(message.content);
      return {
        ...hydrateMessageMedia(message),
        ...(existingAttachment ? { attachment: privateMedia(existingAttachment) } : {}),
      };
    }
    return {
      ...hydrateMessageMedia(message),
      attachment: privateMedia({
        ...attachment,
        public_id: uploaded.public_id,
        resource_type: 'image',
        delivery_type: 'authenticated',
      }),
    };
  } catch (error) {
    await pool
      .query('DELETE FROM doctor_patient_files WHERE id = $1 AND user_id = $2', [
        attachment.id,
        userId,
      ])
      .catch(() => {});
    if (uploaded.public_id) {
      await deleteAsset(uploaded.public_id, 'image', 'authenticated').catch(() => {});
    }
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
    const existing = existingMessage.rows[0];
    if (existing.sender_type !== 'patient' || existing.message_type !== 'voice') {
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
          url: authenticatedAssetUrl(uploaded.public_id, 'video', 'authenticated'),
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
  return result.rows[0] || null;
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

const messageAction = async (pool, input) => {
  const { tenantId, taskId, userId, actorType, actorRef, action, messageId } = input;
  assertTenantAllowed(tenantId);
  const task = await loadOwnedTask(pool, tenantId, taskId, userId);
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
        [tenantId, taskId, messageId, content]
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
            COALESCE((o.payload->>'occurred_at')::timestamptz, o.created_at) AS created_at,
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
            AND m.user_id = $1
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
      ORDER BY COALESCE(latest.created_at, o.created_at) DESC
      LIMIT 100`,
    [userId, tenantId]
  );
  return {
    tasks: result.rows.map((task) => ({
      ...task,
      latest_message: task.latest_message
        ? hydrateMessageMedia({ content: task.latest_message }).content
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
  const message = await insertMessage(pool, {
    tenantId,
    taskId,
    userId: appUserId,
    senderType: 'doctor',
    senderRef: input.sender_ref,
    messageType: input.message_type,
    content: input.content,
    clientMessageId: input.client_message_id,
  });
  if (!message.duplicate) {
    const user = await pool.query(
      `SELECT id, push_token, COALESCE(language_preference, 'vi') AS language
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [appUserId]
    );
    if (user.rows[0]) {
      const isEnglish = user.rows[0].language === 'en';
      const doctorName = typeof input.sender_name === 'string' ? input.sender_name.trim() : '';
      const voice = parseVoice(input.content);
      const preview = voice
        ? isEnglish
          ? 'Sent a voice message.'
          : 'Đã gửi một tin nhắn thoại.'
        : input.content.slice(0, 180);
      await sendAndSave(
        pool,
        user.rows[0],
        'doctor_message',
        isEnglish ? 'New message from Doctor' : 'Tin nhắn mới từ Doctor',
        doctorName
          ? isEnglish
            ? `Dr. ${doctorName}: ${preview}`
            : `Bác sĩ ${doctorName}: ${preview}`
          : preview,
        {
          type: 'doctor_message',
          task_id: taskId,
          tenant_id: tenantId,
          message_id: String(message.id),
        },
        'high',
        {
          // Do not put the patient's health details on the device lock screen.
          pushBody: isEnglish
            ? doctorName
              ? `Dr. ${doctorName} sent a message in your consultation.`
              : 'Your doctor sent a message in your consultation.'
            : doctorName
              ? `Bác sĩ ${doctorName} đã gửi tin nhắn trong cuộc tư vấn của bạn.`
              : 'Bác sĩ đã gửi tin nhắn trong cuộc tư vấn của bạn.',
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
  return message;
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
      content: `[ASINU_VOICE]${JSON.stringify({
        name: String(input.file_name || 'voice-message').slice(0, 255),
        mime_type: input.mime_type || 'audio/webm',
        size_bytes: buffer.length,
        duration_ms: Math.round(duration),
        public_id: uploaded.public_id,
        resource_type: 'video',
        delivery_type: 'authenticated',
        url: authenticatedAssetUrl(uploaded.public_id, 'video', 'authenticated'),
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
  });
};

module.exports = {
  listMessages,
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
