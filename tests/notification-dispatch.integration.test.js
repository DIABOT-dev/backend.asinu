'use strict';

const { Pool } = require('pg');
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
const { sendPushNotification } = require('../src/services/notification/push.notification.service');
const { sendAndSave } = require('../src/services/notification/basic.notification.service');
const { dispatch } = require('../src/core/notification/notification.orchestrator');
const {
  reserveNotification,
  deliverNotification,
  retryPendingNotifications,
} = require('../src/services/notification/notification-dispatch.service');
const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase(
  'notification reservation and durable push delivery (real SQL, fake provider)',
  () => {
    const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
    let userId;
    const ids = [];
    beforeAll(async () => {
      const { rows } = await pool.query(
        "INSERT INTO users (display_name, push_token) VALUES ('Notification fixture', 'ExpoPushToken[only-fixture]') RETURNING id"
      );
      userId = rows[0].id;
      ids.push(userId);
    });
    beforeEach(async () => {
      sendPushNotification.mockReset().mockResolvedValue({ ok: true });
      await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_notification_preferences WHERE user_id = $1', [userId]);
      await pool.query(
        "UPDATE users SET push_token = 'ExpoPushToken[only-fixture]', deleted_at = NULL WHERE id = $1",
        [userId]
      );
    });
    afterAll(async () => {
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
      await pool.end();
    });
    const message = (data = {}, type = 'caregiver_alert') => ({
      userId,
      type,
      title: 'Fixture title',
      body: 'Fixture body',
      data,
    });
    const inboxCount = async () =>
      Number(
        (await pool.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1', [userId]))
          .rows[0].count
      );
    const optIn = () =>
      pool.query(
        'INSERT INTO user_notification_preferences (user_id, reminders_enabled) VALUES ($1,true)',
        [userId]
      );
    const due = (id) =>
      pool.query(
        "UPDATE notification_push_outbox SET next_attempt_at = now() - interval '1 second' WHERE notification_id = $1",
        [id]
      );

    test('distinct protected-person events both persist; the same event reuses its row', async () => {
      const first = await reserveNotification(pool, message({ patientId: 101, alertId: 'a' }));
      const second = await reserveNotification(pool, message({ patientId: 102, alertId: 'b' }));
      const retry = await reserveNotification(pool, message({ patientId: 101, alertId: 'a' }));
      expect(first.notificationId).not.toBe(second.notificationId);
      expect(retry).toEqual({ notificationId: first.notificationId, existing: true });
      expect(await inboxCount()).toBe(2);
    });
    test('simultaneous basic/orchestrator reminders never exceed the shared daily cap', async () => {
      await optIn();
      await pool.query(
        "INSERT INTO notifications (user_id,type,title,message) VALUES ($1,'morning_checkin','x','x'),($1,'evening_checkin','x','x')",
        [userId]
      );
      await Promise.all([
        sendAndSave(pool, userId, 'reengagement', 'x', 'x'),
        dispatch(pool, message({}, 'milestone')),
        reserveNotification(pool, message({}, 'weekly_recap')),
      ]);
      expect(await inboxCount()).toBe(3);
    });
    test('critical follow-up is delivered despite routine opt-out and a full budget', async () => {
      await pool.query(
        "INSERT INTO notifications (user_id,type,title,message) VALUES ($1,'morning_checkin','x','x'),($1,'evening_checkin','x','x'),($1,'reengagement','x','x')",
        [userId]
      );
      expect(
        await sendAndSave(pool, userId, 'checkin_followup_urgent', 'Urgent fixture', 'x', {
          checkinId: 'c',
        })
      ).toBe(true);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('failed push retries without a duplicate inbox record or another budget reservation', async () => {
      sendPushNotification.mockResolvedValueOnce({ ok: false });
      expect(await sendAndSave(pool, userId, 'payment_failed', 'x', 'x', { paymentId: 'p' })).toBe(
        false
      );
      const id = (await pool.query('SELECT id FROM notifications WHERE user_id = $1', [userId]))
        .rows[0].id;
      await due(id);
      expect(await sendAndSave(pool, userId, 'payment_failed', 'x', 'x', { paymentId: 'p' })).toBe(
        true
      );
      expect(await inboxCount()).toBe(1);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
      expect(await retryPendingNotifications(pool)).toEqual({ scanned: 0, sent: 0 });
    });
    test('concurrent delivery workers claim the push only once', async () => {
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await Promise.all([
        deliverNotification(pool, row.notificationId),
        deliverNotification(pool, row.notificationId),
      ]);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('rechecks the current device token rather than retaining an old account token', async () => {
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await pool.query(
        "UPDATE users SET push_token = 'ExpoPushToken[new-fixture-device]' WHERE id = $1",
        [userId]
      );
      await deliverNotification(pool, row.notificationId);
      expect(sendPushNotification.mock.calls[0][0]).toEqual(['ExpoPushToken[new-fixture-device]']);
    });
    test('retry cancels optional reminders after opt-out', async () => {
      await optIn();
      const row = await reserveNotification(pool, message({}, 'reengagement'));
      await pool.query(
        'UPDATE user_notification_preferences SET reminders_enabled = false WHERE user_id = $1',
        [userId]
      );
      await deliverNotification(pool, row.notificationId);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
    test('retry cancels deleted users and expired notifications', async () => {
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [userId]);
      await deliverNotification(pool, row.notificationId);
      await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [userId]);
      const next = await reserveNotification(
        pool,
        message({ paymentId: 'expired' }, 'payment_failed')
      );
      await pool.query(
        "UPDATE notification_push_outbox SET expires_at = now() - interval '1 second' WHERE notification_id = $1",
        [next.notificationId]
      );
      await deliverNotification(pool, next.notificationId);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
    test('retry cancels family messages when alert permission is revoked', async () => {
      const { rows } = await pool.query(
        "INSERT INTO users (display_name) VALUES ('Subject fixture') RETURNING id"
      );
      const subject = rows[0].id;
      ids.push(subject);
      await pool.query(
        "INSERT INTO user_connections (requester_id, addressee_id, status, permissions) VALUES ($1,$2,'accepted','{\"can_receive_alerts\":true}')",
        [subject, userId]
      );
      const row = await reserveNotification(pool, message({ patientId: subject }));
      await pool.query(
        'DELETE FROM user_connections WHERE requester_id = $1 AND addressee_id = $2',
        [subject, userId]
      );
      await deliverNotification(pool, row.notificationId);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
    test('invalid tokens are cleared and never retried', async () => {
      sendPushNotification.mockResolvedValueOnce({
        ok: false,
        invalidTokens: ['ExpoPushToken[only-fixture]'],
      });
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await deliverNotification(pool, row.notificationId);
      await due(row.notificationId);
      await retryPendingNotifications(pool);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query('SELECT push_token FROM users WHERE id = $1', [userId])).rows[0]
          .push_token
      ).toBeNull();
    });
    test('doctor push retains privacy-safe body while preserving the inbox preview', async () => {
      await sendAndSave(
        pool,
        userId,
        'doctor_message',
        'x',
        'Private health text',
        { message_id: 'm' },
        'high',
        { pushBody: 'You have a new message' }
      );
      expect(sendPushNotification.mock.calls[0][2]).toBe('You have a new message');
      expect(
        (await pool.query('SELECT message FROM notifications WHERE user_id = $1', [userId])).rows[0]
          .message
      ).toBe('Private health text');
    });
    test('recovering an expired lease finishes within the retry bound', async () => {
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await pool.query(
        "UPDATE notification_push_outbox SET state = 'INFLIGHT', attempts = 5, lease_until = now() - interval '1 second' WHERE notification_id = $1",
        [row.notificationId]
      );
      await retryPendingNotifications(pool);
      expect(sendPushNotification).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            'SELECT state FROM notification_push_outbox WHERE notification_id = $1',
            [row.notificationId]
          )
        ).rows[0].state
      ).toBe('CANCELLED');
    });
    test('a profile edit cancels a queued reminder about a removed disease', async () => {
      await optIn();
      const row = await reserveNotification(
        pool,
        message({ topic: { kind: 'medical_condition', code: 'diabetes' } }, 'reengagement')
      );
      // No disease recorded in this fixture's current profile.
      await deliverNotification(pool, row.notificationId);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
  }
);
