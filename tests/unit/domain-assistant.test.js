jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const tools = require('../../src/services/assistant/domain-tools.service');
const schema = require('../../src/services/assistant/domain-tools.schema');
const reads = require('../../src/services/assistant/domain-tools.read');
const { validatePlan } = require('../../src/services/assistant/app-assistant.service');
const raw = (tool, parameters = {}) => ({ type: 'app_tool', tool, parameters, evidence: 'explicit synthetic request' });
const request = text => ({ text, current: { language: 'vi', fontSize: 'normal' } });

test.each([
  ['family.share', { target: 'An', enabled: true, ownerId: 99 }],
  ['family.permissions', { target: 'An', changes: { can_view_logs: true } }],
  ['family.invite', { phone: 'not a phone' }],
  ['gifts.open', { box: 0 }], ['gifts.open', { box: 7 }],
  ['calls.configure', { checkin_time: '25:00' }],
  ['calls.personalize', { address: 'grandpa', location: { latitude: 1 } }],
  ['coins.redeem', { reward: 'WALLET_CASH', recipientId: 1 }],
  ['device.permission', { kind: 'all', enabled: true }],
  ['subscription.upgrade', { plan: 'root', billing: 'once' }],
  ['wallet.topup', { amount: -1 }],
  ['expert.send', { message: 'not in scope' }],
])('domain tool %s rejects extra identities, unsupported scope and invalid parameters', (tool, parameters) => {
  expect(() => schema.parse(raw(tool, parameters))).toThrow();
});

test('matching an ambiguous first name never selects somebody by list order', () => {
  const rows = [{ name: 'Trần An' }, { name: 'Nguyễn An' }];
  expect(reads.choose(rows, 'An', row => row.name)).toBeNull();
  expect(reads.choose(rows, 'Trần An', row => row.name)).toBe(rows[0]);
  expect(reads.choose(rows, '1', row => row.name)).toBe(rows[0]);
});

test('an account without an early assessment receives an empty state instead of a failed request', async () => {
  const service = require('../../src/services/early-signal/early-signal-request.service');
  const spy = jest.spyOn(service, 'latest').mockResolvedValue(null);
  try {
    expect(await tools.prepare({}, 1, raw('early_signal.latest'))).toEqual({ answer: 'Chưa có dữ liệu cho yêu cầu này nhé.' });
  } finally { spy.mockRestore(); }
});

test('latest conclusion is not restricted to an invented today date, while an explicit yesterday filter is preserved', () => {
  for (const [text, parameters] of [
    ['Xem kết luận check-in gần nhất', {}],
    ['Xem kết luận check-in gần nhất của hôm qua', { date: '2026-11-13' }],
  ]) {
    const result = validatePlan({ status: 'ready', actions: [{ type: 'app_tool', tool: 'checkin.conclusion', parameters: { date: '2026-11-13' }, evidence: text }] }, request(text));
    expect(result.actions[0].parameters).toEqual(parameters);
  }
});

test('weather requests on the free plan cannot prompt for GPS or mutate preferences', async () => {
  const entitlement = require('../../src/services/payment/entitlement.service');
  const spy = jest.spyOn(entitlement, 'getEntitlement').mockResolvedValue({ callCenterEnabled: false });
  const db = { query: jest.fn() };
  try {
    const result = await tools.prepare(db, 1, raw('calls.weather_device'));
    expect(result.clarify).toMatch(/An Tâm/);
    expect(result.native).toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

test('checkout and system permission preparation never mutates DB, charges money or marks permission granted', async () => {
  const db = { query: jest.fn(() => { throw Error('Preview must not query or write'); }) };
  expect(await tools.prepare(db, 1, raw('wallet.topup', { amount: 100000 }))).toEqual({ screen: { screen: 'wallet_topup', params: { amount: '100000' } } });
  expect(await tools.prepare(db, 1, raw('subscription.upgrade', { plan: 'antam_4', billing: 'yearly' }))).toEqual({ screen: { screen: 'upgrade', params: { plan: 'antam_4', billing: 'yearly' } } });
  expect(await tools.prepare(db, 1, raw('device.permission', { kind: 'microphone', enabled: true }))).toEqual({ native: { type: 'native', kind: 'device.permission', parameters: { kind: 'microphone', enabled: true } } });
  expect(db.query).not.toHaveBeenCalled();
});

test('bundled feed search honors the current device hidden list, and hiding a local article uses the existing device flow', async () => {
  const enabled = process.env.ENABLE_HEALTH_FEED; process.env.ENABLE_HEALTH_FEED = 'false';
  try {
    const catalog = require('../../src/services/assistant/bundled-feed.json').vi;
    const available = await reads.feed({}, 1, 'vi', { hiddenArticles: ['curated-1'] });
    expect(available.map(row => row.id)).not.toContain('curated-1');
    expect(await reads.feed({}, 1, 'vi', { allowCuratedArticles: false })).toEqual([]);
    const result = await tools.prepare({}, 1, raw('feed.hide', { target: catalog[1].title }));
    expect(result).toEqual({ native: { type: 'native', kind: 'feed.hide', parameters: { id: 'curated-2' } } });
  } finally { if (enabled === undefined) delete process.env.ENABLE_HEALTH_FEED; else process.env.ENABLE_HEALTH_FEED = enabled; }
});

test('an owner-bound preview cannot be applied by another account, with a tampered signature or after expiry', async () => {
  const secret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'domain-assistant-unit-test-secret';
  const db = { query: jest.fn().mockResolvedValue({ rows: [{ reminders_enabled: true }] }) };
  try {
    const plan = await tools.prepare(db, 1, raw('settings.configure', { reminders_enabled: false }));
    db.query.mockClear();
    await expect(tools.execute(db, 2, plan.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    await expect(tools.execute(db, 1, plan.action.planToken.slice(0, -10) + 'modified')).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60000);
    try { await expect(tools.execute(db, 1, plan.action.planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' }); }
    finally { clock.mockRestore(); }
    expect(db.query).not.toHaveBeenCalled();
  } finally { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});

test('new journal/profile inputs retain explicit quantities, valid inclusive dates, and no retired weight field', () => {
  const ready = action => ({ status: 'ready', actions: [action] });
  const text = 'Tôi ăn cơm cá và rau';
  expect(validatePlan(ready({ type: 'meal', meal_text: 'cơm cá và rau', evidence: text }), request(text))).not.toBeNull();
  expect(validatePlan(ready({ type: 'meal', meal_text: 'cơm cá và rau', calories_kcal: 500, evidence: text }), request(text))).toBeNull();
  expect(validatePlan(ready({ type: 'profile', changes: { heightCm: 170 }, evidence: 'chiều cao' }), request('chiều cao'))).toBeNull();
  expect(validatePlan(ready({ type: 'query', topic: 'water', range: 'custom', startDate: '2026-11-14', endDate: '2026-11-13', evidence: 'xem nước' }), request('xem nước'))).toBeNull();
  expect(validatePlan(ready({ type: 'profile', changes: { weightKg: 50 }, evidence: '50kg' }), request('50kg'))).toBeNull();
});
