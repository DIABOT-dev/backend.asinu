'use strict';

const paymentService = require('../../src/services/payment/payment.service');

describe('payment history', () => {
  test('returns the original QR details needed to reopen a pending payment', async () => {
    const expiresAt = new Date('2026-10-02T04:30:00.000Z');
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 9,
              order_code: 'order123',
              amount: '50000.00',
              status: 'pending',
              qr_url: 'https://qr.sepay.vn/img?order=order123',
              expires_at: expiresAt,
              created_at: new Date('2026-10-02T04:00:00.000Z'),
              completed_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }),
    };

    const result = await paymentService.getHistory(pool, 42, { page: 1, limit: 10 });

    expect(pool.query.mock.calls[0][0]).toContain('expires_at');
    expect(result.payments[0]).toMatchObject({
      order_code: 'order123',
      qr_url: 'https://qr.sepay.vn/img?order=order123',
      expires_at: expiresAt,
      description: 'asinupay42orderorder123',
    });
  });
});
