'use strict';

const { Pool } = require('pg');
// Existing delivery scenarios run at a deterministic daytime; quiet-hours
// behavior has its own real-SQL suite with explicit nighttime clocks.
jest.mock('../src/services/notification/notification-quiet-hours.policy', () => {
  const actual = jest.requireActual('../src/services/notification/notification-quiet-hours.policy');
  return {
    ...actual,
    getQuietHoursHoldUntil: (notification, preferences, timezone) =>
      actual.getQuietHoursHoldUntil(
        notification,
        preferences,
        timezone,
        new Date('2026-10-07T12:00:00+07:00')
      ),
  };
});
jest.mock('../src/services/notification/push.notification.service', () => ({
  ...jest.requireActual('../src/services/notification/push.notification.service'),
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/health_feed/config', () => ({
  ...jest.requireActual('../src/services/health_feed/config'),
  isWithinPushWindow: () => true,
}));
jest.mock('../src/services/notification/notification-schedule.policy', () => {
  const actual = jest.requireActual('../src/services/notification/notification-schedule.policy');
  return {
    ...actual,
    getScheduledReminderHoldUntil: jest.fn(actual.getScheduledReminderHoldUntil),
  };
});
const {
  getScheduledReminderHoldUntil,
} = require('../src/services/notification/notification-schedule.policy');
const {
  sendPushNotification,
  notifyCareCircleInvitation,
  notifyCareCircleAccepted,
} = require('../src/services/notification/push.notification.service');
const { testNotificationHandler } = require('../src/controllers/notification.controller');
const { sendAndSave } = require('../src/services/notification/basic.notification.service');
const { dispatch } = require('../src/core/notification/notification.orchestrator');
const { saveInAppNotification } = require('../src/services/notification/notification.service');
const {
  reserveNotification,
  deliverNotification,
  retryPendingNotifications,
} = require('../src/services/notification/notification-dispatch.service');
const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase(
  'notification reservation and durable push delivery (real SQL, fake provider)',
  () => {
    const originalMetricFlag = process.env.HEALTH_METRIC_REMINDERS_ENABLED;
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
      process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'true';
      sendPushNotification.mockReset().mockResolvedValue({ ok: true });
      getScheduledReminderHoldUntil
        .mockReset()
        .mockImplementation(
          jest.requireActual('../src/services/notification/notification-schedule.policy')
            .getScheduledReminderHoldUntil
        );
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
      if (originalMetricFlag === undefined) delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
      else process.env.HEALTH_METRIC_REMINDERS_ENABLED = originalMetricFlag;
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
        'INSERT INTO user_notification_preferences (user_id, reminders_enabled, health_feed_enabled) VALUES ($1,true,true)',
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
    test('a deferred event still reuses its pending row after the normal cooldown expires', async () => {
      const first = await reserveNotification(
        pool,
        message({ paymentId: 'pending-event' }, 'payment_failed')
      );
      await pool.query(
        "UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE id = $1",
        [first.notificationId]
      );
      const duplicate = await reserveNotification(
        pool,
        message({ paymentId: 'pending-event' }, 'payment_failed')
      );
      expect(duplicate).toEqual({ notificationId: first.notificationId, existing: true });
      expect(await inboxCount()).toBe(1);
    });
    test('an inbox-only event can gain one push without recreating its row or resending later', async () => {
      const data = { eventId: 'shared-inbox-push-event' };
      await saveInAppNotification(pool, userId, 'payment_failed', 'x', 'x', data);
      await sendAndSave(pool, userId, 'payment_failed', 'x', 'x', data);
      await sendAndSave(pool, userId, 'payment_failed', 'x', 'x', data);
      expect(await inboxCount()).toBe(1);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('concurrent delivery workers claim the push only once', async () => {
      const row = await reserveNotification(pool, message({}, 'payment_failed'));
      await Promise.all([
        deliverNotification(pool, row.notificationId),
        deliverNotification(pool, row.notificationId),
      ]);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('25 concurrent retries of the same event produce one inbox row and one push', async () => {
      await Promise.all(
        Array.from({ length: 25 }, () =>
          sendAndSave(pool, userId, 'payment_failed', 'x', 'x', { paymentId: 'same-event' })
        )
      );
      expect(await inboxCount()).toBe(1);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('distinct invitations remain distinct even if the rendered copy is identical', async () => {
      const first = await reserveNotification(
        pool,
        message({ invitationId: 'a' }, 'care_circle_invitation')
      );
      const second = await reserveNotification(
        pool,
        message({ invitationId: 'b' }, 'care_circle_invitation')
      );
      const duplicate = await reserveNotification(
        pool,
        message({ invitationId: 'a' }, 'care_circle_invitation')
      );
      expect(first.notificationId).not.toBe(second.notificationId);
      expect(duplicate.notificationId).toBe(first.notificationId);
      expect(await inboxCount()).toBe(2);
    });
    test('wallet payment order codes preserve separate transactions and deduplicate retries', async () => {
      await Promise.all(
        ['order-a', 'order-b', 'order-a'].map((orderCode) =>
          sendAndSave(pool, userId, 'wallet_topup_success', 'Payment', 'Same amount', { orderCode })
        )
      );
      expect(await inboxCount()).toBe(2);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
    });
    test('event IDs coalesce writer aliases and extra metadata, including older stored keys', async () => {
      const first = await reserveNotification(
        pool,
        message({ event_id: 'stable-event' }, 'payment_failed')
      );
      await pool.query('UPDATE notifications SET event_key = NULL WHERE id = $1', [
        first.notificationId,
      ]);
      const duplicate = await reserveNotification(pool, {
        ...message({ eventId: 'stable-event', action: 'updated', userId }, 'payment_failed'),
        title: 'Updated translated title',
      });
      expect(duplicate).toEqual({ notificationId: first.notificationId, existing: true });
      expect(await inboxCount()).toBe(1);
    });
    test('different routine queues cannot push together and deferred work keeps its retry budget', async () => {
      await optIn();
      const rows = await Promise.all(
        ['morning_checkin', 'reengagement', 'health_feed'].map((type) =>
          reserveNotification(pool, message({}, type))
        )
      );
      await Promise.all(rows.map((row) => deliverNotification(pool, row.notificationId)));
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
      const states = (
        await pool.query(
          'SELECT state, attempts FROM notification_push_outbox WHERE notification_id = ANY($1::int[]) ORDER BY attempts DESC',
          [rows.map((row) => row.notificationId)]
        )
      ).rows;
      expect(states).toEqual([
        { state: 'SENT', attempts: 1 },
        { state: 'RETRY', attempts: 0 },
        { state: 'RETRY', attempts: 0 },
      ]);
      await retryPendingNotifications(pool);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
      await pool.query(
        "UPDATE notification_push_outbox SET updated_at = now() - interval '6 minutes' WHERE state = 'SENT' AND notification_id = ANY($1::int[])",
        [rows.map((row) => row.notificationId)]
      );
      for (const row of rows) await due(row.notificationId);
      await retryPendingNotifications(pool);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
      expect(await inboxCount()).toBe(3);
    });
    test('a queued fixed-time reminder wins even if an older auxiliary is delivered first', async () => {
      await optIn();
      const auxiliary = await reserveNotification(pool, message({}, 'reengagement'));
      const fixed = await reserveNotification(pool, message({}, 'reminder_morning_summary'));
      const deferred = await deliverNotification(pool, auxiliary.notificationId);
      expect(deferred).toEqual({ ok: false, skipped: true, deferred: true });
      expect(sendPushNotification).not.toHaveBeenCalled();
      expect(await deliverNotification(pool, fixed.notificationId)).toEqual({ ok: true });
      expect(sendPushNotification.mock.calls[0][3].type).toBe('reminder_morning_summary');
      expect(
        (
          await pool.query(
            'SELECT state, attempts, next_attempt_at > NOW() AS waiting FROM notification_push_outbox WHERE notification_id = $1',
            [auxiliary.notificationId]
          )
        ).rows[0]
      ).toEqual({ state: 'RETRY', attempts: 0, waiting: true });
    });
    test('concurrent scheduled and auxiliary workers still deliver only the scheduled reminder', async () => {
      await optIn();
      const auxiliary = await reserveNotification(pool, message({}, 'health_feed'));
      const fixed = await reserveNotification(pool, message({}, 'reminder_evening_summary'));
      await Promise.all([
        deliverNotification(pool, auxiliary.notificationId),
        deliverNotification(pool, fixed.notificationId),
      ]);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
      expect(sendPushNotification.mock.calls[0][3].type).toBe('reminder_evening_summary');
    });
    test('retry batch prioritizes urgent events, then fixed reminders, then older auxiliary work', async () => {
      await optIn();
      await reserveNotification(pool, message({}, 'weekly_recap'));
      await reserveNotification(pool, message({}, 'reminder_morning_summary'));
      await reserveNotification(pool, message({}, 'emergency'));
      expect(await retryPendingNotifications(pool, 1)).toEqual({ scanned: 1, sent: 1 });
      expect(sendPushNotification.mock.calls[0][3].type).toBe('emergency');
      expect(await retryPendingNotifications(pool, 1)).toEqual({ scanned: 1, sent: 1 });
      expect(sendPushNotification.mock.calls[1][3].type).toBe('reminder_morning_summary');
      expect(await retryPendingNotifications(pool, 1)).toEqual({ scanned: 1, sent: 0 });
    });
    test('two fixed reminders due together both persist and are delivered with spacing', async () => {
      await optIn();
      const first = await reserveNotification(pool, message({}, 'reminder_morning_summary'));
      const second = await reserveNotification(pool, message({}, 'morning_checkin'));
      await deliverNotification(pool, first.notificationId);
      expect(await deliverNotification(pool, second.notificationId)).toEqual({
        ok: false,
        skipped: true,
        deferred: true,
      });
      expect(await inboxCount()).toBe(2);
      await pool.query(
        "UPDATE notification_push_outbox SET updated_at = NOW() - interval '6 minutes' WHERE notification_id = $1",
        [first.notificationId]
      );
      await due(second.notificationId);
      expect(await deliverNotification(pool, second.notificationId)).toEqual({ ok: true });
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
    });
    test('an imminent configured reminder is protected before its cron creates the queue row', async () => {
      await optIn();
      const auxiliary = await reserveNotification(pool, message({}, 'reengagement'));
      getScheduledReminderHoldUntil.mockResolvedValue(new Date(Date.now() + 5 * 60000));
      expect(await reserveNotification(pool, message({}, 'weekly_recap'))).toBeNull();
      expect(await deliverNotification(pool, auxiliary.notificationId)).toEqual({
        ok: false,
        skipped: true,
        deferred: true,
      });
      const fixed = await reserveNotification(pool, message({}, 'reminder_morning_summary'));
      expect(await deliverNotification(pool, fixed.notificationId)).toEqual({ ok: true });
      await sendAndSave(pool, userId, 'checkin_followup_urgent', 'Urgent', 'x', {
        checkinId: 'priority',
      });
      expect(sendPushNotification.mock.calls.map((call) => call[3].type)).toEqual([
        'reminder_morning_summary',
        'checkin_followup_urgent',
      ]);
    });
    test('a routine send in flight spaces other reminders but never delays an emergency', async () => {
      await optIn();
      const first = await reserveNotification(pool, message({}, 'morning_checkin'));
      const next = await reserveNotification(pool, message({}, 'health_feed'));
      const urgent = await reserveNotification(pool, message({}, 'emergency'));
      let release, started;
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      sendPushNotification.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const sending = deliverNotification(pool, first.notificationId);
      await ready;
      try {
        expect(await deliverNotification(pool, next.notificationId)).toMatchObject({
          skipped: true,
          deferred: true,
        });
        expect(await deliverNotification(pool, urgent.notificationId)).toEqual({ ok: true });
        expect(sendPushNotification).toHaveBeenCalledTimes(2);
      } finally {
        release({ ok: true });
        await sending;
      }
    });
    test('parallel notifications for different users do not block each other', async () => {
      await optIn();
      const otherId = (
        await pool.query(
          "INSERT INTO users (display_name, push_token) VALUES ('Other notification fixture', 'ExpoPushToken[other-fixture]') RETURNING id"
        )
      ).rows[0].id;
      ids.push(otherId);
      await pool.query(
        'INSERT INTO user_notification_preferences (user_id, reminders_enabled) VALUES ($1,true)',
        [otherId]
      );
      const first = await reserveNotification(pool, message({}, 'morning_checkin'));
      const other = await reserveNotification(pool, {
        ...message({}, 'morning_checkin'),
        userId: otherId,
      });
      await Promise.all([
        deliverNotification(pool, first.notificationId),
        deliverNotification(pool, other.notificationId),
      ]);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
    });
    test('repeated client inbox writes are atomic, while different payloads remain distinct', async () => {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          saveInAppNotification(
            pool,
            userId,
            'health_alert',
            'x',
            'x',
            index % 2
              ? { logId: 'one', severity: 'critical' }
              : { severity: 'critical', logId: 'one' }
          )
        )
      );
      expect(await inboxCount()).toBe(1);
      await saveInAppNotification(pool, userId, 'health_alert', 'x', 'x', {
        logId: 'two',
        severity: 'critical',
      });
      expect(await inboxCount()).toBe(2);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
    test('doctor messages without a message ID deduplicate only identical content', async () => {
      await sendAndSave(pool, userId, 'doctor_message', 'Doctor', 'First message');
      await sendAndSave(pool, userId, 'doctor_message', 'Doctor', 'First message');
      await sendAndSave(pool, userId, 'doctor_message', 'Doctor', 'Second message');
      expect(await inboxCount()).toBe(2);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
    });
    test('developer push testing cannot bypass atomic deduplication', async () => {
      const responses = [];
      await Promise.all(
        Array.from({ length: 10 }, () => {
          const res = {
            json: (body) => {
              responses.push(body);
            },
            status() {
              return this;
            },
          };
          return testNotificationHandler(
            pool,
            {
              user: { id: userId },
              body: { type: 'health_alert' },
              headers: {},
            },
            res
          );
        })
      );
      expect(responses).toHaveLength(10);
      expect(await inboxCount()).toBe(1);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
    test('legacy care-circle push helpers also reuse the durable event row', async () => {
      // The normal care-circle writer does not include senderId; the helper
      // does. Both still represent the same invitation, not two events.
      await reserveNotification(
        pool,
        message({ invitationId: 'invitation-one' }, 'care_circle_invitation')
      );
      await Promise.all(
        Array.from({ length: 10 }, () =>
          notifyCareCircleInvitation(pool, userId, 'Sender fixture', 'invitation-one', 123)
        )
      );
      expect(await inboxCount()).toBe(1);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
      await Promise.all(
        Array.from({ length: 10 }, () =>
          notifyCareCircleAccepted(pool, userId, 'Accepter fixture', 456)
        )
      );
      expect(await inboxCount()).toBe(2);
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
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
