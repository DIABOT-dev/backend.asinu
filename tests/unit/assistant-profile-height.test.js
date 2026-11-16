'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const jwt = require('jsonwebtoken');
const { callTextAi } = require('../../src/services/ai/ai.service');
const service = require('../../src/services/assistant/app-assistant.service');
const tools = require('../../src/services/assistant/app-tools.service');
const profile = require('../../src/services/assistant/profile-assistant.service');
const router = require('../../src/services/assistant/skill-router.service');
const request = text => ({ text, current: { language: 'vi', fontSize: 'normal' } });
const ready = (text, heightCm) => ({ status: 'ready', actions: [{ type: 'profile', changes: { heightCm }, evidence: text }] });
let secret;
beforeEach(() => {
  secret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'assistant-height-synthetic-test-secret';
  callTextAi.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
});

test.each([
  ['Cập nhật chiều cao cho tôi là 1m70', 170],
  ['Bạn cập nhật cho tôi chiều cao giúp tôi là 1 m 70 cm', 170],
  ['Thao tác là chỉnh sửa thông tin cập nhật chiều cao cho tôi là 1 m 70', 170],
  ['Đổi chiều cao thành 170 cm', 170],
  ['Đổi chiều cao thành 170cm', 170],
  ['Đổi chiều cao thành 170', 170],
  ['Đổi chiều cao thành 1,70 mét', 170],
  ['Đổi chiều cao thành 1.7m', 170],
  ['Đổi chiều cao thành 1m70.', 170],
  ['Đổi chiều cao thành 1m70, cảm ơn', 170],
  ['Đổi chiều cao thành 1.70m.', 170],
  ['Đổi chiều cao thành 1 m 70 cm, cảm ơn', 170],
  ['Đổi chiều cao thành 1,70m', 170],
  ['Đổi chiều cao thành 1mét70', 170],
  ['Đổi chiều cao thành 170, hôm nay tôi mệt', 170],
  ['Đổi chiều cao thành 1 m 75 cm', 175],
  ['Đổi chiều cao thành 1 mét 05 cm', 105],
  ['Đổi chiều cao thành 1 mét 7 cm', 107],
  ['Đổi chiều cao thành một mét bảy mươi', 170],
  ['Đổi chiều cao thành một mét bảy mươi lăm xentimet', 175],
  ['Đổi chiều cao thành một phẩy bảy mét', 170],
  ['Đổi chiều cao thành một trăm bảy mươi', 170],
  ['Trước tôi cao 1m60, cập nhật chiều cao thành 1m70', 170],
  ['Set my height to 1.70 meters', 170],
  ['Set my height to 1 meter 70 centimeters', 170],
  ['Set my height to 170 centimeters', 170],
])('an explicit height retains its exact value across units: %s', (text, value) => {
  expect(service.validatePlan(ready(text, value), request(text))).toMatchObject({ status: 'ready', actions: [{ changes: { heightCm: value } }] });
});

test.each([
  ['Đổi chiều cao thành 1m70', 171],
  ['Đổi chiều cao thành 1m70cm', 70],
  ['Đổi chiều cao thành 1 m 70 cm', 70],
  ['Đổi chiều cao thành 1m7', 170],
  ['Đổi chiều cao thành 170 m', 170],
  ['Đổi chiều cao thành 1 m 700 cm', 170],
  ['Đổi chiều cao thành 1m170', 170],
  ['Đổi chiều cao thành 1m70 hay 1m80 tôi không nhớ', 170],
  ['Set my height to either 1.70 meters or 1.80 meters', 170],
  ['Đổi chiều cao thành 170 kg', 170],
  ['Đổi chiều cao giúp tôi, cân nặng 70 kg', 70],
  ['Đổi chiều cao giúp tôi, huyết áp 170/80', 170],
  ['Đổi chiều cao giúp tôi, năm sinh 1970', 170],
  ['Đổi chiều cao giúp tôi', 170],
  ['Đổi chiều cao thành 2,6 mét', 260],
])('an invented, ambiguous or invalid height is not accepted: %s', (text, value) => {
  expect(service.validatePlan(ready(text, value), request(text))).toBeNull();
});

test.each([
  'Cập nhật chiều cao cho tôi là 1m70',
  'Bạn cập nhật cho tôi chiều cao giúp tôi là 1 m 70 cm',
  'Thao tác là chỉnh sửa thông tin cập nhật chiều cao cho tôi là 1 m 70',
  'Set my height to 1.70 meters',
  'Trước tôi cao 1m60, cập nhật chiều cao thành 1m70',
])('the screenshot request reaches a reviewed, owner-bound preview, without saving: %s', async text => {
  expect(router.select(request(text))).toEqual(['profile']);
  const db = { query: jest.fn(() => { throw Error('Preview must not write'); }) };
  const context = jest.spyOn(tools, 'profileContext').mockResolvedValue({ version: 'user-version:profile-version', chronicDiseases: [] });
  const save = jest.spyOn(profile, 'execute');
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name: 'update-profile', arguments: { changes: { heightCm: 170 } } }] }) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await service.plan(request(text), 'vi', { pool: db, userId: 7 });
  expect(result).toMatchObject({ status: 'ready', actions: [{ type: 'profile', changes: { heightCm: 170 }, planToken: expect.any(String) }] });
  const claims = jwt.verify(result.actions[0].planToken, process.env.JWT_SECRET, { subject: '7', audience: 'asinu:assistant-profile' });
  expect(claims.changes).toEqual({ heightCm: 170 });
  expect(claims.version).toBe('user-version:profile-version');
  expect(context).toHaveBeenCalledWith(db, 7);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(save).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  await expect(profile.execute(db, 8, result.actions[0].planToken)).rejects.toMatchObject({ code: 'APP_ASSISTANT_PLAN_EXPIRED' });
  expect(db.query).not.toHaveBeenCalled();
});

test('height conversions cannot loosen the explicit quantity rules of health logs', () => {
  const bp = 'Ghi huyết áp 12/8';
  expect(service.validatePlan({ status: 'ready', actions: [{ type: 'blood_pressure', systolic: 120, diastolic: 80, evidence: bp }] }, request(bp))).toBeNull();
  const water = 'Ghi 1m70 nước';
  expect(service.validatePlan({ status: 'ready', actions: [{ type: 'water', volume_ml: 170, evidence: water }] }, request(water))).toBeNull();
});

test('an ongoing clarification with the same height reaches confirmation rather than another generic repeat', async () => {
  const input = { ...request('Bạn cập nhật cho tôi chiều cao giúp tôi là 1m70cm'),
    clarification: { original: 'Cập nhật chiều cao cho tôi là 1m70', question: 'Bạn nói rõ hơn thao tác muốn làm và thông tin cần dùng giúp mình nhé.' } };
  jest.spyOn(tools, 'profileContext').mockResolvedValue({ version: 'version:unchanged', chronicDiseases: [] });
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name: 'update-profile', arguments: { changes: { heightCm: 170 } } }] }) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  expect(await service.plan(input, 'vi', { pool: {}, userId: 7 })).toMatchObject({ status: 'ready', actions: [{ changes: { heightCm: 170 }, planToken: expect.any(String) }] });
});

test('a reviewer refusal of a conflicted height cannot produce an executable profile preview', async () => {
  const text = 'Cập nhật chiều cao 1m70 và 1m80';
  jest.spyOn(tools, 'profileContext').mockResolvedValue({ version: 'version:unchanged', chronicDiseases: [] });
  const sign = jest.spyOn(profile, 'prepare');
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name: 'update-profile', arguments: { changes: { heightCm: 170 } } }] }) })
    .mockResolvedValueOnce({ content: '{"approved":false}' });
  expect(await service.plan(request(text), 'vi', { pool: {}, userId: 7 })).toMatchObject({ status: 'clarify', actions: [] });
  expect(sign).not.toHaveBeenCalled();
});
