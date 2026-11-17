'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/services/ai/ai-consent.service', () => ({
  ...jest.requireActual('../../src/services/ai/ai-consent.service'),
  hasAiConsent: jest.fn().mockResolvedValue(true),
}));

const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const readCache = require('../../src/services/assistant/assistant-read-cache.service');
const assistant = require('../../src/services/assistant/app-assistant.service');
const domains = require('../../src/services/assistant/domain-tools.service');
const tools = require('../../src/services/assistant/app-tools.service');
const { callTextAi } = require('../../src/services/ai/ai.service');
const { hasAiConsent } = require('../../src/services/ai/ai-consent.service');
const request = (text = 'Tôi còn thông báo nào chưa đọc?') => ({ text, current: { language: 'vi', fontSize: 'normal' } });
const action = input => ({ type: 'app_tool', tool: 'notifications.list', parameters: { unread: true }, evidence: input.text });
const answer = { status: 'answer', question: '', actions: [], answer: 'Synthetic answer.' };
const miss = { code: 'APP_ASSISTANT_READ_CACHE_MISS', statusCode: 409 };
let env;

function database() {
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  return { query: jest.fn(), connect: jest.fn(async () => client), client };
}
const issued = (input = request(), reads = [action(input)]) => readCache.issue(input, reads, answer, 7);
const replay = (capability, input = request(), options = {}) => readCache.replay(
  { token: capability.token, request: input }, 'vi', { pool: database(), userId: 7, ...options }
);

beforeEach(() => {
  env = { ...process.env };
  process.env.JWT_SECRET = 'read-cache-fixture-secret-only';
  process.env.APP_ASSISTANT_MODEL = 'synthetic-cache-model-a';
  hasAiConsent.mockReset().mockResolvedValue(true);
  callTextAi.mockReset();
  jest.useFakeTimers().setSystemTime(new Date('2026-11-17T05:00:00Z'));
  jest.spyOn(domains, 'prepare').mockResolvedValue({ answer: 'Fresh current answer.' });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  process.env = env;
});

test('fingerprints follow the fixed cross-platform canonical JSON contract', () => {
  const input = { ...request('  Xem thông báo  '), hiddenArticles: ['z', 'a', 'z'], conversation: [{ role: 'user', text: 'Old unrelated text' }] };
  const expected = { text: 'Xem thông báo', current: { language: 'vi', fontSize: 'normal' }, hiddenArticles: ['a', 'z'], allowCuratedArticles: true };
  expect(readCache.canonicalRequest(input)).toEqual(expected);
  expect(readCache.fingerprint(input)).toBe(createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
  expect(readCache.fingerprint(request())).toBe(readCache.fingerprint({ ...request(), hiddenArticles: [], allowCuratedArticles: true }));
});

test('a real approved answer plan issues a compact unsigned read capability', async () => {
  const input = request();
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name: 'notifications-list', arguments: { unread: true } }] }) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await assistant.plan(input, 'vi', { pool: {}, userId: 7 });
  expect(result).toMatchObject({ status: 'answer', actions: [], answer: 'Fresh current answer.', readCache: { key: readCache.fingerprint(input) } });
  const payload = jwt.verify(result.readCache.token, process.env.JWT_SECRET, { audience: readCache.AUDIENCE, subject: '7' });
  expect(payload.actions).toEqual([{ type: 'app_tool', tool: 'notifications.list', parameters: { unread: true } }]);
  expect(JSON.stringify(payload)).not.toMatch(/evidence|planToken|Synthetic answer/);
  expect(payload.exp - payload.iat).toBe(900);
});

test('replay reads live data and retains its original token/expiry without calling AI', async () => {
  const capability = issued(), db = database();
  jest.setSystemTime(new Date('2026-11-17T05:05:00Z'));
  const result = await replay(capability, request(), { pool: db });
  expect(result).toEqual({ status: 'answer', question: '', actions: [], answer: 'Fresh current answer.', readCache: capability });
  expect(domains.prepare).toHaveBeenCalledWith(db.client, 7, action(request()), 'vi', { hiddenArticles: [], allowCuratedArticles: true });
  expect(db.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN READ ONLY', 'COMMIT']);
  expect(db.client.release).toHaveBeenCalledTimes(1);
  expect(callTextAi).not.toHaveBeenCalled();
  expect(hasAiConsent).toHaveBeenCalledTimes(2);
});

test('query actions reuse their existing current-data service without AI or stale answer storage', async () => {
  const input = request('Tôi đã uống bao nhiêu nước hôm nay?');
  const reading = { type: 'query', topic: 'water', range: 'today', statistic: 'list', evidence: input.text };
  const capability = issued(input, [reading]);
  const query = jest.spyOn(tools, 'query').mockResolvedValue('Hôm nay đã ghi 650 ml.');
  expect(await replay(capability, input)).toMatchObject({ status: 'answer', answer: 'Hôm nay đã ghi 650 ml.', actions: [] });
  expect(query).toHaveBeenCalledTimes(1);
  expect(domains.prepare).not.toHaveBeenCalled();
  expect(callTextAi).not.toHaveBeenCalled();
});

test.each([
  { ...request(), clarification: { original: 'Xem thông báo', question: 'Thông báo nào?' } },
  { ...request('Còn hôm qua?'), conversation: [{ role: 'user', text: 'Xem lượng nước hôm nay' }] },
])('context-dependent or clarification requests never issue or replay capabilities', async input => {
  expect(issued(input)).toBeNull();
  await expect(replay(issued(), input)).rejects.toMatchObject(miss);
  expect(domains.prepare).not.toHaveBeenCalled();
});

test.each([
  { type: 'app_tool', tool: 'notifications.delete_all', parameters: {} },
  { type: 'app_tool', tool: 'coins.balance', parameters: {} },
  { type: 'app_tool', tool: 'missions.status', parameters: {} },
  { type: 'app_tool', tool: 'gifts.today', parameters: {} },
  { type: 'app_tool', tool: 'checkin.conclusion', parameters: { speak: true } },
  { type: 'navigate', destination: 'notifications' },
  { type: 'native', kind: 'device.permission', parameters: { kind: 'camera', enabled: true } },
  { type: 'screen', screen: 'wallet_topup', params: { amount: '100000' } },
  { type: 'speech', text: 'Synthetic speech' },
  { type: 'query', topic: 'profile', range: 'month', statistic: 'average' },
])('unsafe, effectful or unsupported actions never receive replay capabilities: %j', reading => {
  expect(issued(request(), [{ ...reading, evidence: request().text }])).toBeNull();
  expect(issued(request(), [action(request()), { ...reading, evidence: request().text }])).toBeNull();
});

test('signed/executable fields cannot be copied into the read cache', () => {
  expect(issued(request(), [{ ...action(request()), planToken: 'executable-token' }])).toBeNull();
  expect(readCache.issue(request(), [action(request())], { ...answer, actions: [{ type: 'app_tool', planToken: 'x' }] }, 7)).toBeNull();
  expect(readCache.issue(request(), [action(request())], { ...answer, status: 'clarify' }, 7)).toBeNull();
  expect(readCache.issue(request(), [action(request())], answer, 0)).toBeNull();
  delete process.env.JWT_SECRET;
  expect(issued()).toBeNull();
});

test.each([
  () => ({ ...request(), text: 'Xem tất cả thông báo' }),
  () => ({ ...request(), current: { language: 'en', fontSize: 'normal' } }),
  () => ({ ...request(), current: { language: 'vi', fontSize: 'large' } }),
  () => ({ ...request(), hiddenArticles: ['hidden-article'] }),
  () => ({ ...request(), allowCuratedArticles: false }),
])('changing any canonical field invalidates the capability', async changed => {
  await expect(replay(issued(), changed())).rejects.toMatchObject(miss);
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('a token is bound to its authenticated owner, audience, and signature', async () => {
  const capability = issued();
  await expect(replay(capability, request(), { userId: 8 })).rejects.toMatchObject(miss);
  await expect(replay({ token: capability.token.slice(0, -5) + 'wrong' })).rejects.toMatchObject(miss);
  const token = jwt.sign({ id: 7 }, process.env.JWT_SECRET, { audience: 'asinu:app-operation' });
  await expect(replay({ token })).rejects.toMatchObject(miss);
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('expiry, model and policy changes invalidate old capabilities', async () => {
  const capability = issued();
  process.env.APP_ASSISTANT_MODEL = 'synthetic-cache-model-b';
  await expect(replay(capability)).rejects.toMatchObject(miss);
  process.env.APP_ASSISTANT_MODEL = 'synthetic-cache-model-a';
  process.env.APP_ASSISTANT_READ_CACHE_POLICY_VERSION = 'new-policy';
  await expect(replay(capability)).rejects.toMatchObject(miss);
  delete process.env.APP_ASSISTANT_READ_CACHE_POLICY_VERSION;
  jest.setSystemTime(new Date('2026-11-17T05:15:01Z'));
  await expect(replay(capability)).rejects.toMatchObject(miss);
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('Vietnam calendar rollover invalidates a still-unexpired token', async () => {
  jest.setSystemTime(new Date('2026-11-17T16:59:50Z'));
  const capability = issued();
  jest.setSystemTime(new Date('2026-11-17T17:00:10Z'));
  await expect(replay(capability)).rejects.toMatchObject(miss);
  expect(domains.prepare).not.toHaveBeenCalled();
});

test('revoked consent prevents reads, and revocation during reading withholds the answer', async () => {
  const capability = issued();
  hasAiConsent.mockResolvedValueOnce(false);
  await expect(replay(capability)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED', statusCode: 403 });
  expect(domains.prepare).not.toHaveBeenCalled();
  hasAiConsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(replay(capability)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED', statusCode: 403 });
});

test.each([
  { clarify: 'Which relative?' }, { answer: 'x', action: { planToken: 'unsafe' } },
  { answer: 'x', screen: { screen: 'feed_article' } }, { answer: 'x', speech: 'x' },
])('a changed read result cannot become an operation on replay: %j', async result => {
  domains.prepare.mockResolvedValueOnce(result);
  const db = database();
  await expect(replay(issued(), request(), { pool: db })).rejects.toMatchObject(miss);
  expect(db.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
  expect(db.client.release).toHaveBeenCalledTimes(1);
});

test('permission/feature errors preserve their normal status and never fall through to AI', async () => {
  const error = Object.assign(new Error('Feature disabled'), { code: 'CARE_CIRCLE_DISABLED', statusCode: 403 });
  domains.prepare.mockRejectedValueOnce(error);
  await expect(replay(issued())).rejects.toBe(error);
  expect(callTextAi).not.toHaveBeenCalled();
});

test('family health replay rechecks current directional access through the real read service', async () => {
  domains.prepare.mockRestore();
  process.env.CARE_CIRCLE_ENABLED = 'true';
  process.env.CAREGIVER_VIEW_LOGS_ENABLED = 'true';
  const circles = require('../../src/services/care-circle/careCircle.service');
  const caregivers = require('../../src/services/care-circle/caregiver-view.service');
  const connection = { requester_id: 7, addressee_id: 8, addressee_full_name: 'Người Thử', addressee_can_view_logs: true };
  const connections = jest.spyOn(circles, 'getConnections').mockResolvedValue({ ok: true, connections: [connection] });
  const summary = jest.spyOn(caregivers, 'memberHealthSummary').mockResolvedValue({
    report: { checkinDays: 1, totalDays: 7, sessions: [] }, healthScore: { factors: [] },
  });
  const input = request('Xem sức khỏe của Người Thử');
  const capability = issued(input, [{ type: 'app_tool', tool: 'family.health', parameters: { target: 'Người Thử' }, evidence: input.text }]);
  expect(await replay(capability, input)).toMatchObject({ answer: expect.stringContaining('1/7') });
  expect(summary).toHaveBeenCalledWith(expect.any(Object), 7, 8);
  connections.mockResolvedValueOnce({ ok: true, connections: [{ ...connection, addressee_can_view_logs: false }] });
  expect(await replay(capability, input)).toMatchObject({ answer: expect.stringContaining('chưa cho phép') });
  expect(summary).toHaveBeenCalledTimes(1);
  connections.mockResolvedValueOnce({ ok: true, connections: [] });
  await expect(replay(capability, input)).rejects.toMatchObject(miss);
  expect(callTextAi).not.toHaveBeenCalled();
});

test('read-only database enforcement blocks a read service that unexpectedly attempts writes', async () => {
  domains.prepare.mockRejectedValueOnce(Object.assign(new Error('Read only transaction'), { code: '25006' }));
  await expect(replay(issued())).rejects.toMatchObject(miss);
  expect(callTextAi).not.toHaveBeenCalled();
});
