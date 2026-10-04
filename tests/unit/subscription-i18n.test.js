'use strict';

const subscriptionController = require('../../src/controllers/subscription.controller');
const iapController = require('../../src/controllers/iap.controller');
const subscriptionService = require('../../src/services/payment/subscription.service');
const iapService = require('../../src/services/payment/iap.service');
const { localizedPlanName } = require('../../src/services/payment/subscription-catalog');

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    vary: jest.fn().mockReturnThis(),
    json: jest.fn((body) => body),
  };
}

afterEach(() => jest.restoreAllMocks());

test('all plan labels follow the selected language', () => {
  expect(localizedPlanName('free', 'en')).toBe('Free');
  expect(localizedPlanName('antam_4', 'en')).toBe('An Tam 4');
  expect(localizedPlanName('antam_4', 'vi')).toBe('An Tâm 4');
});

test('subscription status localizes cached plan names per request', async () => {
  jest.spyOn(subscriptionService, 'getStatus').mockResolvedValue({ planCode: 'free', planName: 'Miễn phí' });
  const res = response();
  await subscriptionController.getStatus({}, { user: { id: 7 }, headers: { 'accept-language': 'en-US' } }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ planName: 'Free' }));
  expect(res.vary).toHaveBeenCalledWith('Accept-Language');
});

test('subscription failures hide technical errors and use request language', async () => {
  jest.spyOn(subscriptionService, 'getStatus').mockRejectedValue(new Error('relation subscriptions does not exist'));
  const res = response();
  await subscriptionController.getStatus({}, { user: { id: 7 }, headers: { 'accept-language': 'en' } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
  const payload = res.json.mock.calls[0][0];
  expect(payload.error).not.toContain('subscriptions');
  expect(payload.error).not.toContain('relation');
});

test('IAP catalogue and verification errors follow request language', async () => {
  const req = { query: { platform: 'apple' }, headers: { 'accept-language': 'en' } };
  const catalogResponse = response();
  iapController.listProducts({}, req, catalogResponse);
  expect(catalogResponse.json.mock.calls[0][0].products[0].plan_name).toBe('An Tam 2');
  expect(catalogResponse.vary).toHaveBeenCalledWith('Accept-Language');

  jest.spyOn(iapService, 'verifyAndActivate').mockResolvedValue({
    ok: false,
    code: 'IAP_SUBSCRIPTION_EXPIRED',
    error: 'This subscription has expired; purchase a new plan to continue',
  });
  const verifyResponse = response();
  await iapController.verifyReceipt({}, {
    user: { id: 7 },
    body: { platform: 'apple' },
    headers: { 'accept-language': 'vi' },
  }, verifyResponse);
  expect(verifyResponse.status).toHaveBeenCalledWith(402);
  expect(verifyResponse.json.mock.calls[0][0].error).toBe('Giao dịch đã hết hạn. Vui lòng đăng ký gói mới.');
});
