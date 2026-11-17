'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/services/assistant/domain-tools.service', () => ({
  ...jest.requireActual('../../src/services/assistant/domain-tools.service'),
  prepare: jest.fn(),
}));
const { callTextAi } = require('../../src/services/ai/ai.service');
const domains = require('../../src/services/assistant/domain-tools.service');
const { plan } = require('../../src/services/assistant/app-assistant.service');
const input = text => ({ text, current: { language: 'vi', fontSize: 'normal' } });
const fixtures = [
  ['notifications-list', 'notifications.list', 'Tôi còn thông báo nào chưa đọc?', { unread: true }],
  ['family-invite', 'family.invite', 'Mời người thân số 0900000000 kết nối', { phone: '0900000000' }],
];
beforeEach(() => {
  jest.resetAllMocks();
  domains.prepare.mockResolvedValue({ answer: 'Synthetic tool result.' });
});

test.each(fixtures)('flat %s arguments reach the tool only after independent review', async (name, tool, text, parameters) => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name, arguments: parameters }] }) })
    .mockResolvedValueOnce({ content: '{"approved":true}' });
  const result = await plan(input(text), 'vi', { pool: {}, userId: 7 });
  expect(result).toMatchObject({ status: 'answer', answer: 'Synthetic tool result.' });
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(domains.prepare).toHaveBeenCalledWith({}, 7,
    { type: 'app_tool', tool, parameters, evidence: text }, 'vi', expect.any(Object));
  expect(callTextAi.mock.invocationCallOrder[1]).toBeLessThan(domains.prepare.mock.invocationCallOrder[0]);
});

test.each(fixtures)('a rejected review of flat %s arguments cannot prepare an operation', async (name, _tool, text, parameters) => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name, arguments: parameters }] }) })
    .mockResolvedValueOnce({ content: '{"approved":false}' });
  expect(await plan(input(text), 'vi', { pool: {}, userId: 7 })).toMatchObject({ status: 'clarify', actions: [] });
  expect(domains.prepare).not.toHaveBeenCalled();
});

test.each([
  ['gifts-open', 'Mở hộp lộc giúp tôi', {}],
  ['family-invite', 'Mời người thân kết nối', { relationship: 'bạn' }],
  ['notifications-list', 'Tôi còn thông báo nào chưa đọc?', { parameters: {}, unread: true }],
])('missing or conflicting %s arguments ask for clarification before review or preparation', async (name, text, parameters) => {
  callTextAi.mockResolvedValueOnce({ content: JSON.stringify({ status: 'ready', calls: [{ name, arguments: parameters }] }) });
  expect(await plan(input(text), 'vi', { pool: {}, userId: 7 })).toMatchObject({ status: 'clarify', actions: [] });
  expect(callTextAi).toHaveBeenCalledTimes(1);
  expect(domains.prepare).not.toHaveBeenCalled();
});
