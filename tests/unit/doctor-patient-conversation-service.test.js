'use strict';

jest.mock('../../src/services/integrations/doctor-messaging.service', () => ({
  listMessages: jest.fn(),
  sendPatientMessage: jest.fn(),
  sendPatientAttachment: jest.fn(),
  sendPatientVoice: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  requestDoctorTaskStatus: jest.fn(),
}));
jest.mock('../../src/services/integrations/doctor-task-readiness', () => ({
  waitForDoctorTask: jest.fn((load) => load()),
}));

const conversation = require('../../src/services/integrations/doctor-patient-conversation.service');
const messaging = require('../../src/services/integrations/doctor-messaging.service');
const { requestDoctorTaskStatus } = require('../../src/services/integrations/doctor-task.service');

describe('doctor patient conversation rules', () => {
  const pool = {};
  beforeEach(() => jest.clearAllMocks());

  test('blocks a completed consultation without follow-up', async () => {
    requestDoctorTaskStatus.mockResolvedValueOnce({ status: 'completed', follow_up_open: false });
    await expect(
      conversation.sendPatientConversationMessage(pool, {
        userId: 5,
        taskId: 'task',
        input: { tenant_id: 'tenant', content: 'hello' },
      })
    ).rejects.toMatchObject({ code: 'CONSULTATION_CONVERSATION_CLOSED', statusCode: 409 });
    expect(messaging.sendPatientMessage).not.toHaveBeenCalled();
  });

  test('marks messages as follow-up when the completed task is reopened', async () => {
    requestDoctorTaskStatus.mockResolvedValueOnce({ status: 'completed', follow_up_open: true });
    messaging.sendPatientMessage.mockResolvedValueOnce({ id: 'message' });
    await conversation.sendPatientConversationMessage(pool, {
      userId: 5,
      taskId: 'task',
      input: { tenant_id: 'tenant', content: 'hello', message_type: 'text' },
    });
    expect(messaging.sendPatientMessage).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        input: expect.objectContaining({ message_type: 'follow_up' }),
      })
    );
  });

  test('keeps conversation history available when Doctor status is unavailable', async () => {
    messaging.listMessages.mockResolvedValueOnce({ messages: [{ id: 'message' }] });
    requestDoctorTaskStatus.mockRejectedValueOnce(new Error('Doctor unavailable'));
    await expect(conversation.listPatientConversation(pool, 'tenant', 'task', 5)).resolves.toEqual({
      messages: [{ id: 'message' }],
      task_status: null,
    });
  });

  test('keeps a newly queued consultation unknown while Doctor has not received the task', async () => {
    messaging.listMessages.mockResolvedValueOnce({ summary: 'Synthetic request', messages: [] });
    requestDoctorTaskStatus.mockRejectedValueOnce(Object.assign(new Error('Pending delivery'), {
      statusCode: 404,
      code: 'PATIENT_TASK_NOT_FOUND',
    }));
    await expect(conversation.listPatientConversation(pool, 'tenant', 'task', 5)).resolves.toEqual({
      summary: 'Synthetic request',
      messages: [],
      task_status: null,
    });
  });

  test('returns the assigned status once Doctor receives the queued task', async () => {
    messaging.listMessages.mockResolvedValueOnce({ messages: [] });
    const status = { status: 'assigned', rateable: false, follow_up_open: false };
    requestDoctorTaskStatus.mockResolvedValueOnce(status);
    await expect(conversation.listPatientConversation(pool, 'tenant', 'task', 5)).resolves.toEqual({
      messages: [],
      task_status: status,
    });
  });
});
