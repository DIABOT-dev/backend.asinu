const mockSendPushNotification = jest.fn(async () => ({ ok: true }));

jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: (...args) => mockSendPushNotification(...args),
}));

const { sendAndSave } = require('../src/services/notification/basic.notification.service');

function createPool(
  pushToken = 'ExpoPushToken[notification-delivery-test]',
  remindersEnabled = false
) {
  let notification;
  const pool = {
    query: jest.fn(async (sql, values) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (
        ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized) ||
        normalized.startsWith('SELECT pg_advisory_xact_lock')
      )
        return { rows: [] };
      if (normalized.includes('SELECT reminders_enabled')) {
        return { rows: [{ reminders_enabled: remindersEnabled }] };
      }
      if (
        normalized.startsWith('SELECT 1 FROM notifications') ||
        normalized.startsWith('SELECT id FROM notifications')
      )
        return { rows: [] };
      if (normalized.startsWith('INSERT INTO notifications')) {
        notification = {
          id: 1,
          user_id: values[0],
          type: values[1],
          title: values[2],
          push_body: values[3],
          data: JSON.parse(values[4]),
          attempts: 0,
          push_token: pushToken,
        };
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO notification_push_outbox')) {
        notification.push_body = values[1];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT n.id, n.user_id')) return { rows: [notification] };
      if (normalized.startsWith('UPDATE notification_push_outbox'))
        return { rows: [], rowCount: 1 };
      if (normalized.startsWith('SELECT push_token FROM users')) {
        return { rows: pushToken ? [{ push_token: pushToken }] : [] };
      }
      if (normalized.startsWith('UPDATE users SET push_token = NULL')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    }),
    release: jest.fn(),
  };
  pool.connect = jest.fn(async () => pool);
  return pool;
}

describe('external notification delivery', () => {
  beforeEach(() => {
    mockSendPushNotification.mockClear();
  });

  test('resolves a missing token and pushes transactional events outside the app', async () => {
    const pool = createPool();

    await expect(
      sendAndSave(
        pool,
        { id: 42, push_token: null },
        'wallet_topup_success',
        'Nạp tiền thành công',
        'Số dư đã được cập nhật',
        { amount: '100000' }
      )
    ).resolves.toBe(true);

    expect(mockSendPushNotification).toHaveBeenCalledWith(
      ['ExpoPushToken[notification-delivery-test]'],
      'Nạp tiền thành công',
      'Số dư đã được cập nhật',
      { type: 'wallet_topup_success', amount: '100000' }
    );
  });

  test('supports an explicit in-app-only event without looking up a token', async () => {
    const pool = createPool();

    await expect(
      sendAndSave(pool, 42, 'custom_in_app_event', 'Thông báo', 'Nội dung', {}, null, {
        push: false,
      })
    ).resolves.toBe(true);

    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(
      pool.query.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/g, ' ').trim().startsWith('SELECT push_token FROM users')
      )
    ).toBe(false);
  });

  test('does not save or push optional reminders without explicit opt-in', async () => {
    const pool = createPool('ExpoPushToken[notification-delivery-test]', false);

    await expect(
      sendAndSave(pool, 42, 'reengagement', 'Asinu nhắc bạn', 'Hãy cập nhật sức khỏe')
    ).resolves.toBe(false);

    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(
      pool.query.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/g, ' ').trim().startsWith('INSERT INTO notifications')
      )
    ).toBe(false);
  });

  test('clears an Expo token rejected as unregistered', async () => {
    const pool = createPool();
    mockSendPushNotification.mockResolvedValueOnce({
      ok: false,
      error: 'Device is not registered',
      invalidTokens: ['ExpoPushToken[notification-delivery-test]'],
    });

    await expect(
      sendAndSave(pool, 42, 'payment_failed', 'Thanh toán lỗi', 'Vui lòng thử lại')
    ).resolves.toBe(false);

    expect(
      pool.query.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/g, ' ').trim().startsWith('UPDATE users SET push_token = NULL')
      )
    ).toBe(true);
  });
});
