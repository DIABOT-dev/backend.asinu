const { sendAndSave } = require('../notification/basic.notification.service');
const { assertTenantAllowed } = require('./doctor-task.service');
const { verifyDoctorSignature, assertProfileRequest } = require('./doctor-profile.service');
const { uploadBuffer, deleteAsset } = require('../media/cloudinary-upload.service');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const TERMINAL_LIFECYCLE_STATUSES = new Set(['cancelled', 'expired', 'failed']);

const isDoctorTaskMessageable = ({ status, followUpUntil }, messageType, now = new Date()) => {
  if (!status || !status.length) return true;
  if (TERMINAL_LIFECYCLE_STATUSES.has(status)) return false;
  if (status !== 'completed') return true;
  return (
    messageType === 'follow_up' &&
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

const listMessages = async (pool, tenantId, taskId, userId) => {
  assertTenantAllowed(tenantId);
  const task = await loadOwnedTask(pool, tenantId, taskId, userId);
  const result = await pool.query(
    `SELECT id, task_id, sender_type, sender_ref, message_type, content,
            client_message_id, created_at
       FROM doctor_task_messages
      WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3
      ORDER BY created_at ASC, id ASC
      LIMIT 500`,
    [tenantId, taskId, userId]
  );
  return { task_id: taskId, summary: task.summary || null, messages: result.rows };
};

const insertMessage = async (client, input) => {
  const inserted = await client.query(
    `INSERT INTO doctor_task_messages(
       tenant_id, task_id, user_id, sender_type, sender_ref,
       message_type, content, client_message_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, task_id, client_message_id) DO NOTHING
     RETURNING id, task_id, sender_type, sender_ref, message_type, content,
               client_message_id, created_at`,
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
    `SELECT id, task_id, sender_type, sender_ref, message_type, content,
            client_message_id, created_at
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
      await client.query(
        `INSERT INTO doctor_task_outbox(event_id, idempotency_key, tenant_id, payload)
         VALUES ($1,$1,$2,$3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, input.tenant_id, JSON.stringify(envelope)]
      );
    }
    await client.query('COMMIT');
    await rebuildPatientHealthTimeline(pool, userId);
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
    `SELECT id, task_id, sender_type, sender_ref, message_type, content,
            client_message_id, created_at
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
    return { ...existing, duplicate: true, ...(attachment ? { attachment } : {}) };
  }

  const uploaded = await uploadBuffer(file.buffer, {
    folder: process.env.CLOUDINARY_PATIENT_FILE_FOLDER || 'asinu/patient-files',
    resource_type: 'image',
    use_filename: true,
    unique_filename: true,
  });
  const fileResult = await pool.query(
    `INSERT INTO doctor_patient_files
      (user_id, name, mime_type, size_bytes, secure_url, public_id, source_task_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, mime_type, size_bytes, secure_url, source_task_id, uploaded_by, created_at`,
    [
      userId,
      String(file.originalname).slice(0, 255),
      file.mimetype,
      file.size,
      uploaded.secure_url,
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
    url: attachment.secure_url,
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
      if (uploaded.public_id) await deleteAsset(uploaded.public_id, 'image').catch(() => {});
      const existingAttachment = parseAttachment(message.content);
      return {
        ...message,
        ...(existingAttachment ? { attachment: existingAttachment } : {}),
      };
    }
    return { ...message, attachment };
  } catch (error) {
    await pool
      .query('DELETE FROM doctor_patient_files WHERE id = $1 AND user_id = $2', [
        attachment.id,
        userId,
      ])
      .catch(() => {});
    if (uploaded.public_id) {
      await deleteAsset(uploaded.public_id, 'image').catch(() => {});
    }
    throw error;
  }
};

const listPatientTasks = async (pool, userId, tenantId) => {
  assertTenantAllowed(tenantId);
  const result = await pool.query(
    `SELECT payload->'payload'->>'task_id' AS task_id,
            payload->'payload'->>'summary' AS summary,
            COALESCE((o.payload->>'occurred_at')::timestamptz, o.created_at) AS created_at,
            latest.content AS latest_message,
            latest.sender_type AS latest_sender_type,
            latest.created_at AS latest_message_at
       FROM doctor_task_outbox o
       LEFT JOIN LATERAL (
         SELECT m.content, m.sender_type, m.created_at
           FROM doctor_task_messages m
          WHERE m.tenant_id = o.tenant_id
            AND m.task_id = o.payload->'payload'->>'task_id'
            AND m.user_id = $1
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) latest ON TRUE
      WHERE o.tenant_id = $2
        AND o.payload->>'event_type' = 'doctor.task.requested'
        AND o.payload->'payload'->>'app_user_id' = $1::text
      ORDER BY COALESCE(latest.created_at, o.created_at) DESC
      LIMIT 100`,
    [userId, tenantId]
  );
  return { tasks: result.rows };
};

const queryDoctorMessages = async (pool, req, input) => {
  verifyDoctorSignature(req);
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  return listMessages(pool, tenantId, taskId, appUserId);
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
      const preview = input.content.slice(0, 180);
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
        { type: 'doctor_message', task_id: taskId, message_id: String(message.id) },
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
  }
  await rebuildPatientHealthTimeline(pool, appUserId);
  return message;
};

module.exports = {
  listMessages,
  listPatientTasks,
  sendPatientMessage,
  sendPatientAttachment,
  queryDoctorMessages,
  sendDoctorMessage,
  isDoctorTaskMessageable,
};
