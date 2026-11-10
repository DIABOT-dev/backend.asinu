jest.mock('../../src/services/checkin/checkin.service', () => ({}));
jest.mock('../../src/services/checkin/checkin-api.service', () => ({}));
jest.mock('../../src/services/profile/engagement.service', () => ({}));
jest.mock('../../src/services/checkin/checkin-cancellation.service', () => ({
  cancelCheckin: jest.fn(),
}));
const { cancelCheckin } = require('../../src/services/checkin/checkin-cancellation.service');
const { cancelCheckinHandler } = require('../../src/controllers/checkin.controller');
const response = () => {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
};
beforeEach(() => jest.resetAllMocks());
test('the actor comes from authentication, never from a request body', async () => {
  cancelCheckin.mockResolvedValue({ cancelled: true });
  const res = response();
  const pool = {};
  await cancelCheckinHandler(
    pool,
    { user: { id: 7 }, body: { checkin_id: '100', phase_id: 'current', user_id: 8 }, headers: {} },
    res
  );
  expect(cancelCheckin).toHaveBeenCalledWith(pool, 7, '100', 'current');
  expect(res.json).toHaveBeenCalledWith({ ok: true, cancelled: true });
});
test.each([
  { checkin_id: 100 },
  { checkin_id: -1, phase_id: 'current' },
  { checkin_id: 'invalid', phase_id: 'current' },
  { checkin_id: 100, phase_id: 'x'.repeat(161) },
])('invalid cancellation input is rejected before any write (%p)', async (body) => {
  const res = response();
  await cancelCheckinHandler({}, { user: { id: 7 }, body, headers: {} }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(cancelCheckin).not.toHaveBeenCalled();
});
test.each([
  ['SESSION_NOT_FOUND', 404],
  ['TRIAGE_CHANGED', 409],
  ['CHECKIN_ALREADY_COMPLETED', 409],
])('passes the stable %s error to the app', async (code, statusCode) => {
  cancelCheckin.mockRejectedValue(
    Object.assign(new Error('internal detail'), { code, statusCode })
  );
  const res = response();
  await cancelCheckinHandler(
    {},
    { user: { id: 7 }, body: { checkin_id: 100, phase_id: 'current' }, headers: {} },
    res
  );
  expect(res.status).toHaveBeenCalledWith(statusCode);
  expect(res.json.mock.calls[0][0].code).toBe(code);
  expect(res.json.mock.calls[0][0].error).not.toContain('internal detail');
});
