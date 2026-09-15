const {
  messageActionSchema,
  doctorMessageActionSchema,
  doctorVoiceSendSchema,
} = require('../../src/services/integrations/doctor-task.policy');
const {
  isDoctorTaskMessageable,
} = require('../../src/services/integrations/doctor-messaging.service');

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
