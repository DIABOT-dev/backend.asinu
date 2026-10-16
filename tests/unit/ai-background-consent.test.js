jest.mock('../../src/services/notification/basic.notification.service', () => ({ sendAndSave: jest.fn(async () => true) }));
const { runEngagementNotifications } = require('../../src/services/notification/engagement.notification.service');
const { sendAndSave } = require('../../src/services/notification/basic.notification.service');

test('scheduled AI notifications bind each patient consent without an HTTP session', async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldFlag = process.env.AI_CONSENT_ENFORCEMENT;
  process.env.OPENAI_API_KEY = 'synthetic-provider-fixture';
  process.env.AI_CONSENT_ENFORCEMENT = 'true';
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: {
    content: JSON.stringify({ shouldSend: true, title: 'Fixture', body: 'Synthetic notification' }),
  } }] }) }));
  const pool = { query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM user_ai_consents c JOIN users')) return { rows: params[0] === 1 ? [1] : [] };
    if (sql.includes('HAVING')) return { rows: [1, 2].map(id => ({ id, name: 'Fixture', push_token: 'fixture', language_preference: 'vi', hours_inactive: 25 })) };
    return { rows: [] };
  }) };
  try {
    const result = await runEngagementNotifications(pool);
    expect(result).toMatchObject({ total: 2, sent: 1, errors: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).user).toBe('user_1');
    expect(sendAndSave).toHaveBeenCalledTimes(1);
    expect(sendAndSave.mock.calls[0][1].id).toBe(1);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldFlag === undefined) delete process.env.AI_CONSENT_ENFORCEMENT; else process.env.AI_CONSENT_ENFORCEMENT = oldFlag;
  }
});
