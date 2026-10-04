'use strict';

const {
  listMessages,
  sendPatientMessage,
  sendPatientAttachment,
  sendPatientVoice,
} = require('./doctor-messaging.service');
const { requestDoctorTaskStatus } = require('./doctor-task.service');
const { waitForDoctorTask } = require('./doctor-task-readiness');

async function getPatientMessageState(tenantId, taskId, userId) {
  const status = await waitForDoctorTask(() =>
    requestDoctorTaskStatus({
      input: { tenant_id: tenantId, task_id: taskId, app_user_id: String(userId) },
    })
  );
  const terminal = ['cancelled', 'expired', 'emergency_referred', 'forwarded'];
  if (
    (terminal.includes(status.status) && !status.reopen_open) ||
    (status.status === 'completed' && !status.follow_up_open)
  ) {
    const error = new Error('CONSULTATION_CONVERSATION_CLOSED');
    error.statusCode = 409;
    error.code = 'CONSULTATION_CONVERSATION_CLOSED';
    throw error;
  }
  return status;
}

async function listPatientConversation(pool, tenantId, taskId, userId) {
  const data = await listMessages(pool, tenantId, taskId, userId);
  let taskStatus = null;
  try {
    taskStatus = await requestDoctorTaskStatus({
      input: { tenant_id: tenantId, task_id: taskId, app_user_id: String(userId) },
    });
  } catch {
    // Keep history available during a temporary Doctor outage.
  }
  return { ...data, task_status: taskStatus };
}

async function sendPatientConversationMessage(pool, { userId, taskId, input }) {
  const status = await getPatientMessageState(input.tenant_id, taskId, userId);
  return sendPatientMessage(pool, {
    userId,
    taskId,
    input: {
      ...input,
      message_type: status.status === 'completed' ? 'follow_up' : input.message_type,
    },
  });
}

async function sendPatientConversationAttachment(
  pool,
  { userId, taskId, tenantId, clientMessageId, file }
) {
  await getPatientMessageState(tenantId, taskId, userId);
  return sendPatientAttachment(pool, {
    userId,
    taskId,
    input: {
      tenant_id: tenantId,
      content: '',
      message_type: 'follow_up',
      client_message_id: clientMessageId,
    },
    file,
  });
}

async function sendPatientConversationVoice(
  pool,
  { userId, taskId, tenantId, clientMessageId, file, durationMs }
) {
  await getPatientMessageState(tenantId, taskId, userId);
  return sendPatientVoice(pool, {
    userId,
    taskId,
    input: { tenant_id: tenantId, client_message_id: clientMessageId },
    file,
    durationMs,
  });
}

module.exports = {
  getPatientMessageState,
  listPatientConversation,
  sendPatientConversationMessage,
  sendPatientConversationAttachment,
  sendPatientConversationVoice,
};
