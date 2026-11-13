'use strict';
jest.mock('../../src/services/checkin/checkin.service', () => ({ processTriageStep: jest.fn() }));
const service = require('../../src/services/checkin/checkin.service');
const { triageHandler } = require('../../src/controllers/checkin.controller');
const request = extra => ({ user: { id: 77 }, headers: { 'accept-language': 'vi' }, body: { checkin_id: 123, previous_answers: [], phase_id: 'synthetic-phase', wait_for_ai: true, ...extra } });
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() }; }
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

test('an unfinished operation returns processing before a proxy timeout and later returns its result', async () => {
  let release;
  const operation = new Promise(resolve => { release = resolve; });
  service.processTriageStep.mockReturnValue(operation);
  const first = response();
  const pending = triageHandler({}, request(), first);
  await jest.advanceTimersByTimeAsync(8000);
  await pending;
  expect(first.statusCode).toBe(202);
  expect(first.json).toHaveBeenCalledWith({ ok: true, processing: true });
  const second = response();
  const poll = triageHandler({}, request(), second);
  release({ isDone: false, question: 'Synthetic accepted question' });
  await poll;
  expect(second.statusCode).toBe(200);
  expect(second.json).toHaveBeenCalledWith({ ok: true, isDone: false, question: 'Synthetic accepted question' });
  expect(service.processTriageStep.mock.calls.every(([, owner]) => owner === 77)).toBe(true);
  expect(service.processTriageStep.mock.calls[0][5]).toMatchObject({ waitForAi: true, phaseId: 'synthetic-phase' });
});

test('changed phase and invalid options retain their error response, rather than polling forever', async () => {
  service.processTriageStep.mockRejectedValueOnce({ code: 'TRIAGE_CHANGED' });
  const changed = response();
  await triageHandler({}, request(), changed);
  expect(changed.statusCode).toBe(409);
  const invalid = response();
  await triageHandler({}, request({ wait_for_ai: 'yes' }), invalid);
  expect(invalid.statusCode).toBe(400);
  expect(service.processTriageStep).toHaveBeenCalledTimes(1);
});
