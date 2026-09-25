const { createNotification } = require('../../src/controllers/notification.controller');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('createNotification', () => {
  test('creates the notification only for the authenticated user', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const req = {
      user: { id: 42 },
      body: {
        userId: 999,
        type: 'health_alert',
        title: 'Health alert',
        message: 'Please check your latest measurement.',
        data: { severity: 'critical' },
      },
      headers: {},
    };
    const res = response();

    await createNotification(pool, req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notifications'), [
      42,
      'health_alert',
      'Health alert',
      'Please check your latest measurement.',
      JSON.stringify({ severity: 'critical' }),
      'high',
    ]);
  });

  test('rejects an invalid payload without writing to the database', async () => {
    const pool = { query: jest.fn() };
    const req = { user: { id: 42 }, body: { type: 'health_alert' }, headers: {} };
    const res = response();

    await createNotification(pool, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_NOTIFICATION_PAYLOAD');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
