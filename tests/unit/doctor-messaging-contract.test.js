const {
  messageActionSchema,
  doctorMessageActionSchema,
  doctorMessageQuerySchema,
  doctorVoiceSendSchema,
} = require('../../src/services/integrations/doctor-task.policy');
const {
  isDoctorTaskMessageable,
  listMessages,
} = require('../../src/services/integrations/doctor-messaging.service');
const { listPatientConversation } = require('../../src/services/integrations/doctor-patient-conversation.service');
const { requestDoctorTaskStatus } = require('../../src/services/integrations/doctor-task.service');
const { listDoctorMessages } = require('../../src/controllers/doctor-task.controller');

const validAction = {
  tenant_id: 'clinic-demo',
  action: 'edit',
  message_id: '11111111-1111-4111-8111-111111111111',
  content: 'Nội dung đã chỉnh sửa',
};

test('Messenger actions require the correct target fields and reject unknown data', () => {
  expect(messageActionSchema.safeParse(validAction).success).toBe(true);
  expect(messageActionSchema.safeParse({ tenant_id: 'clinic-demo', action: 'edit' }).success).toBe(
    false
  );
  expect(messageActionSchema.safeParse({ ...validAction, unexpected: true }).success).toBe(false);
});

test('Doctor signed action contract binds the actor to the server-side identity', () => {
  expect(
    doctorMessageActionSchema.safeParse({
      tenant_id: 'clinic-demo',
      app_user_id: '42',
      task_id: 'task-1',
      actor_ref: 'doctor-1',
      action: 'typing',
      is_typing: true,
    }).success
  ).toBe(true);
  expect(
    doctorMessageActionSchema.safeParse({
      tenant_id: 'clinic-demo',
      app_user_id: '42',
      task_id: 'task-1',
      actor_ref: 'doctor-1',
      action: 'typing',
      is_typing: 'true',
    }).success
  ).toBe(false);
});

test('Voice messages are allowed only with bounded metadata', () => {
  const parsed = doctorVoiceSendSchema.safeParse({
    tenant_id: 'clinic-demo',
    app_user_id: '42',
    task_id: 'task-1',
    content_base64: 'SUQzAAAAAAAA',
    file_name: 'voice.webm',
    mime_type: 'audio/webm',
    size_bytes: 9,
    duration_ms: 1200,
    client_message_id: '11111111-1111-4111-8111-111111111111',
    sender_ref: 'doctor-1',
  });
  expect(parsed.success).toBe(true);
  expect(
    doctorVoiceSendSchema.safeParse({
      ...parsed.data,
      size_bytes: 10 * 1024 * 1024 + 1,
    }).success
  ).toBe(false);
});

test('Closed consultations cannot receive text or voice, while follow-up remains bounded', () => {
  expect(isDoctorTaskMessageable({ status: 'expired' }, 'voice')).toBe(false);
  expect(isDoctorTaskMessageable({ status: 'emergency_referred' }, 'reply')).toBe(false);
  expect(
    isDoctorTaskMessageable(
      { status: 'completed', followUpUntil: new Date(Date.now() + 60_000) },
      'voice'
    )
  ).toBe(true);
  expect(
    isDoctorTaskMessageable(
      { status: 'completed', followUpUntil: new Date(Date.now() - 60_000) },
      'voice'
    )
  ).toBe(false);
});
jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  ...jest.requireActual('../../src/services/integrations/doctor-task.service'),
  assertTenantAllowed: jest.fn(),
  requestDoctorTaskStatus: jest.fn(),
}));


test('patient threads expose reminders as system messages and preserve clinician replies', async () => {
  const pool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ app_user_id: '42', summary: 'Consultation' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'in_progress' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'reminder', sender_type: 'doctor', sender_ref: 'doctor-sla-worker', content: 'Priority update' },
          { id: 'reply', sender_type: 'doctor', sender_ref: 'doctor-1', content: 'Specialist reply' },
        ],
      })
      .mockResolvedValue({ rows: [] }),
  };
  const result = await listMessages(pool, 'clinic-demo', 'task-1', 42);
  expect(result.messages.map(({ id, sender_type }) => [id, sender_type])).toEqual([
    ['reminder', 'system'],
    ['reply', 'doctor'],
  ]);
  // REST responses include only the task-scoped transport state. They do not
  // infer presence from the two messages above.
  expect(result.patient_presence).toEqual({ status: 'offline' });
});

test('the live message view returns the owned thread without waiting for Doctor task status', async () => {
  requestDoctorTaskStatus.mockClear();
  const pool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ app_user_id: '42', summary: 'Consultation' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'in_progress' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'reply', sender_type: 'doctor', content: 'New reply' }] })
      .mockResolvedValue({ rows: [] }),
  };
  const req = {
    params: { taskId: 'task-1' },
    query: { tenant_id: 'clinic-demo', view: 'messages' },
    user: { id: 42 },
  };
  const res = { json: jest.fn() };
  await listDoctorMessages(pool, req, res);
  expect(res.json).toHaveBeenCalledWith({
    ok: true, data: expect.objectContaining({ messages: [expect.objectContaining({ id: 'reply' })] }),
  });
  expect(requestDoctorTaskStatus).not.toHaveBeenCalled();
  await expect(listDoctorMessages(pool, { ...req, user: { id: 43 } }, res)).rejects.toMatchObject({
    statusCode: 404,
  });
});

test('the patient sees foreground presence for the expert currently assigned by Doctor', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  let doctorRef = 'expert-1';
  const pool = {
    query: jest.fn(async (sql) => ({
      rows: sql.includes('FROM doctor_task_outbox')
        ? [{ app_user_id: '42' }]
        : sql.includes('FROM doctor_task_lifecycle_events')
          ? [{ status: 'waiting_user', doctor_ref: 'legacy-external-reference' }]
          : [],
    })),
  };
  const profile = { tenant_id: 'clinic-demo', task_id: 'presence-task', app_user_id: '42' };
  requestDoctorTaskStatus.mockImplementation(async () => ({
    status: 'waiting_user', doctor: { id: doctorRef, name: 'Expert Fixture' },
  }));
  const patientMessages = () => listPatientConversation(pool, 'clinic-demo', 'presence-task', '42');
  const readAsDoctor = (actor, active) =>
    listMessages(pool, 'clinic-demo', 'presence-task', '42', 'doctor', actor, active);

  try {
    expect(doctorMessageQuerySchema.safeParse({ ...profile, viewer_active: true }).success).toBe(true);
    expect(doctorMessageQuerySchema.safeParse({ ...profile, viewer_active: 'true' }).success).toBe(false);
    await readAsDoctor('expert-1', false);
    await readAsDoctor('other-expert', true);
    expect((await patientMessages()).doctor_presence).toEqual({ doctor_ref: 'expert-1', status: 'offline', expires_at: null });
    await readAsDoctor('expert-1', true);
    expect((await patientMessages()).doctor_presence).toEqual({
      doctor_ref: 'expert-1', status: 'online', expires_at: new Date(Date.now() + 25_000).toISOString(),
    });
    clock.mockReturnValue(1_800_000_015_000);
    await readAsDoctor('expert-1', true);
    clock.mockReturnValue(1_800_000_033_000);
    expect((await patientMessages()).doctor_presence.status).toBe('online');
    doctorRef = 'expert-2';
    expect((await patientMessages()).doctor_presence.status).toBe('offline');
    doctorRef = 'expert-1';
    clock.mockReturnValue(1_800_000_061_000);
    expect((await patientMessages()).doctor_presence.status).toBe('offline');
  } finally {
    clock.mockRestore();
  }
});
