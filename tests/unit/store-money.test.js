'use strict';
const {
  appleMoney,
  appleRefundMoney,
  googleMoney,
  googleOrderMoney,
} = require('../../src/services/payment/store-money');
describe('verified Store monetary values', () => {
  test.each([
    ['VND', 1499000000, 1499000],
    ['USD', 1990, 199],
    ['JPY', 120000, 120],
    ['KWD', 1990, 1990],
  ])('%s uses ISO minor units', (currency, price, amountMinor) => {
    expect(appleMoney({ currency, price })).toEqual({ currency, amountMinor });
  });
  test('a missing amount is distinct from a verified zero', () => {
    expect(appleMoney({ currency: 'VND' })).toEqual({ amountMinor: null, currency: null });
    expect(appleMoney({ currency: 'VND', price: 0 })).toEqual({ amountMinor: 0, currency: 'VND' });
  });
  test.each([
    { price: -1000, currency: 'USD' },
    { price: 1.5, currency: 'USD' },
    { price: 1, currency: 'VND' },
    { price: 1000, currency: 'bad' },
  ])('rejects invalid or fractional minor units %p', (v) => {
    expect(appleMoney(v).amountMinor).toBeNull();
  });
  test('Google decimal units and nanos are converted without floating point', () => {
    expect(googleMoney({ currencyCode: 'USD', units: '12', nanos: 990000000 })).toEqual({
      currency: 'USD',
      amountMinor: 1299,
    });
    expect(googleMoney({ currencyCode: 'VND', units: '1499000', nanos: 0 })).toEqual({
      currency: 'VND',
      amountMinor: 1499000,
    });
  });
  test('a prorated Apple refund uses the verified percentage', () => {
    expect(
      appleRefundMoney({
        price: 120000,
        currency: 'USD',
        revocationDate: 1,
        revocationPercentage: 25000,
      })
    ).toEqual({ amountMinor: 3000, currency: 'USD' });
    expect(
      appleRefundMoney({ price: 1990, currency: 'USD', revocationPercentage: 25000 }).amountMinor
    ).toBeNull();
  });
  test('Google uses charged/refunded totals, not recurring or list prices', async () => {
    const get = jest.fn(async () => ({
      data: {
        total: { currencyCode: 'USD', units: '5', nanos: 0 },
        orderHistory: {
          refundEvent: { refundDetails: { total: { currencyCode: 'USD', units: '2', nanos: 0 } } },
        },
      },
    }));
    const publisher = { orders: { get } };
    expect(await googleOrderMoney(publisher, 'example.test', 'demo-order')).toEqual({
      amountMinor: 500,
      currency: 'USD',
    });
    expect(await googleOrderMoney(publisher, 'example.test', 'demo-order', true)).toEqual({
      amountMinor: 200,
      currency: 'USD',
    });
    get.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect(
      (await googleOrderMoney(publisher, 'example.test', 'demo-order')).amountMinor
    ).toBeNull();
  });
});
