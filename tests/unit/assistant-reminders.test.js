jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const { getPreferences } = require('../../src/services/notification/smart.schedule.service');
const reminders = require('../../src/services/notification/reminder-assistant.service');
const tools = require('../../src/services/assistant/app-tools.service');

afterEach(() => jest.clearAllMocks());

test('reading reminder preferences does not refresh inference or create a preferences row', async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const result = await getPreferences(db, 71, { refreshInferred: false });
  expect(result).toMatchObject({ reminders_enabled: false, effective_morning_time: '08:00' });
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][0].trim()).toMatch(/^SELECT /);
  expect(db.query.mock.calls[0][1]).toEqual([71]);
});

test('a chat reminder preview reads preferences and signs only the reviewed time without any writes', async () => {
  const secret = process.env.JWT_SECRET, enabled = process.env.REMINDER_ASSISTANT_ENABLED;
  process.env.JWT_SECRET = 'assistant-reminders-unit-test-secret';
  process.env.REMINDER_ASSISTANT_ENABLED = 'true';
  const text = 'Đổi giờ nhắc buổi tối sang 8 giờ 30 tối';
  const db = { query: jest.fn().mockResolvedValue({ rows: [{ reminders_enabled: true, evening_time: '19:00' }] }) };
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', question: '', changes: [
    { slot: 'evening', action: 'set', time: '20:30', evidence: text },
  ] }) }).mockResolvedValueOnce({ content: '{"approved":true}' });
  try {
    const result = await tools.prepareReminders(db, 71, { evidence: text }, 'vi');
    expect(result).toMatchObject({ type: 'routine_reminders', changes: [{ slot: 'evening', before: '19:00', time: '20:30' }] });
    expect(result.planToken).toEqual(expect.any(String));
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0].trim()).toMatch(/^SELECT /);
    await expect(reminders.execute(db, 72, result.planToken)).rejects.toMatchObject({ code: 'REMINDER_ASSISTANT_EXPIRED' });
    expect(db.query).toHaveBeenCalledTimes(1);
  } finally {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    if (enabled === undefined) delete process.env.REMINDER_ASSISTANT_ENABLED; else process.env.REMINDER_ASSISTANT_ENABLED = enabled;
  }
});
