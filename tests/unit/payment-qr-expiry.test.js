'use strict';

const paymentService = require('../../src/services/payment/payment.service');

describe('payment QR expiry', () => {
  test('creates wallet QR codes with a five-minute server-side lifetime', async () => {
    const expiresAt = new Date('2026-10-02T04:05:00.000Z');
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ expires_at: expiresAt }] }),
    };

    const result = await paymentService.createQR(pool, 42, 50000);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain("INTERVAL '5 minutes'");
    expect(result).toMatchObject({
      amount: 50000,
      expires_at: expiresAt,
    });
  });
});
