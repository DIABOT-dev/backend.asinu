jest.mock('../src/services/health/health-timeline.service', () => ({
  rebuildPatientHealthTimeline: jest.fn().mockResolvedValue('Synthetic health timeline'),
}));
jest.mock('../src/security/health-field-encryption', () => ({
  decryptHealthRows: jest.fn((_userId, _table, _fields, rows) => rows),
}));
jest.mock('../src/services/integrations/doctor-task.service', () => ({
  assertTenantAllowed: jest.fn(),
}));
jest.mock('../src/services/integrations/doctor-profile.service', () => ({
  assertProfileRequest: (input) => ({
    tenantId: input.tenant_id,
    appUserId: input.app_user_id,
    taskId: input.task_id,
  }),
}));

const {
  loadDoctorClinicalContext,
} = require('../src/services/integrations/doctor-context.service');
const { conversationIntent } = require('../src/services/integrations/doctor-question-planner');

const input = {
  tenant_id: 'fixture-clinic',
  app_user_id: '42',
  task_id: 'fixture-task',
  clinical_support: { policy_version: 'fixture-policy' },
};
const message = (index, content, sender_type = 'patient', sender_ref = '42') => ({
  id: String(index),
  content,
  sender_type,
  sender_ref,
  message_type: 'reply',
  created_at: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(),
});
const fixturePool = (messages, summary = '') => ({
  query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM doctor_task_outbox'))
      return { rows: [{ app_user_id: '42', summary, created_at: '2026-10-20T00:00:00Z' }] };
    if (sql.includes('FROM doctor_task_messages')) {
      expect(params).toEqual(['fixture-clinic', 'fixture-task', '42']);
      const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] || messages.length);
      const eligible = sql.includes("'doctor-sla-worker'")
        ? messages.filter((item) => item.sender_ref !== 'doctor-sla-worker')
        : messages;
      const ordered = sql.includes('ORDER BY created_at ASC') ? eligible : eligible.toReversed();
      return { rows: ordered.slice(0, limit) };
    }
    return { rows: [] };
  }),
});

test('AI context keeps earlier answers in a consultation longer than twelve turns', async () => {
  const messages = Array.from({ length: 180 }, (_, i) =>
    message(i + 1, i ? 'Nội dung trao đổi giả lập.' : 'Tôi đau đầu 3 ngày nay.')
  );
  const context = await loadDoctorClinicalContext(fixturePool(messages), input);
  expect(context.conversation).toHaveLength(180);
  expect(context.conversation[0].message).toContain('3 ngày');
  expect(context.context_version).toBe('180');
});

test('automated SLA messages do not replace the latest clinical speaker', async () => {
  const context = await loadDoctorClinicalContext(
    fixturePool([
      message(1, 'Tôi đau bụng từ sáng nay.'),
      message(2, 'Ca đang được ưu tiên xử lý.', 'doctor', 'doctor-sla-worker'),
    ]),
    input
  );
  expect(context.conversation).toHaveLength(1);
  expect(conversationIntent(context)).toBe('clinical');
  expect(context.context_version).toBe('1');
});

test('the submitted patient complaint is available before the first chat message without inventing a message version', async () => {
  const context = await loadDoctorClinicalContext(
    fixturePool([], 'Tôi đau bụng từ sáng nay.'),
    input
  );
  expect(context.conversation[0]).toMatchObject({
    role: 'patient',
    message: 'Tôi đau bụng từ sáng nay.',
    source: 'intake',
  });
  expect(conversationIntent(context)).toBe('clinical');
  expect(context.context_version).toBe('0');
});
