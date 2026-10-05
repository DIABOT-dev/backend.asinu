'use strict';

const { Pool } = require('pg');
jest.mock('../src/services/health_feed/repository', () => ({
  getPendingNotificationJobs: jest.fn(),
  markNotificationJobDispatched: jest.fn(),
  localizeContent: jest.fn((content) => content),
}));
jest.mock('../src/services/health_feed/config', () => ({
  ...jest.requireActual('../src/services/health_feed/config'),
  isHealthFeedEnabled: () => true,
  isWithinPushWindow: jest.fn(() => true),
}));
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
const repo = require('../src/services/health_feed/repository');
const config = require('../src/services/health_feed/config');
const { sendPushNotification } = require('../src/services/notification/push.notification.service');
const { dispatchPendingNotifications } = require('../src/services/health_feed/service');
const {
  retryPendingNotifications,
} = require('../src/services/notification/notification-dispatch.service');
const { sendAndSave } = require('../src/services/notification/basic.notification.service');
const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('Health Feed shares atomic budget and durable delivery', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  let userId;
  beforeAll(async () => {
    userId = (
      await pool.query(
        "INSERT INTO users (display_name, push_token) VALUES ('Feed fixture', 'ExpoPushToken[feed-fixture]') RETURNING id"
      )
    ).rows[0].id;
    await pool.query(
      'INSERT INTO user_notification_preferences (user_id, reminders_enabled, health_feed_enabled) VALUES ($1,true,true)',
      [userId]
    );
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await pool.query(
      'UPDATE user_notification_preferences SET reminders_enabled = true, health_feed_enabled = true WHERE user_id = $1',
      [userId]
    );
    config.isWithinPushWindow.mockReturnValue(true);
    sendPushNotification.mockReset().mockResolvedValue({ ok: true });
    repo.markNotificationJobDispatched.mockClear();
    repo.getPendingNotificationJobs.mockResolvedValue([
      {
        id: 1,
        user_id: userId,
        push_token: 'ExpoPushToken[feed-fixture]',
        health_feed_enabled: true,
        reminders_enabled: true,
        language_preference: 'vi',
        payload: { feed_item_id: 'fixture-feed', content_id: 'fixture-content' },
        content_title: 'Fixture',
        content_summary: 'Fixture summary',
      },
    ]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });
  const fillTwo = () =>
    pool.query(
      "INSERT INTO notifications (user_id,type,title,message) VALUES ($1,'morning_checkin','x','x'),($1,'evening_checkin','x','x')",
      [userId]
    );
  test('feed and basic reminder concurrency cannot overrun a shared budget', async () => {
    await fillTwo();
    await Promise.all([
      dispatchPendingNotifications(pool),
      sendAndSave(pool, userId, 'reengagement', 'x', 'x'),
    ]);
    const count = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND counts_toward_cap = true',
      [userId]
    );
    expect(Number(count.rows[0].count)).toBe(3);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test('an inbox row created outside the push window does not suppress its later delivery', async () => {
    await fillTwo();
    config.isWithinPushWindow.mockReturnValue(false);
    await dispatchPendingNotifications(pool);
    expect(sendPushNotification).not.toHaveBeenCalled();
    config.isWithinPushWindow.mockReturnValue(true);
    await dispatchPendingNotifications(pool);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND type = 'health_feed'",
            [userId]
          )
        ).rows[0].count
      )
    ).toBe(1);
  });
  test('a provider failure stays queued for retry and does not recreate inbox history', async () => {
    sendPushNotification.mockResolvedValueOnce({ ok: false });
    await dispatchPendingNotifications(pool);
    expect(repo.markNotificationJobDispatched).toHaveBeenCalledWith(pool, 1, 'queued');
    await pool.query(
      "UPDATE notification_push_outbox SET next_attempt_at = now() - interval '1 second' WHERE notification_id IN (SELECT id FROM notifications WHERE user_id = $1)",
      [userId]
    );
    await retryPendingNotifications(pool);
    expect(sendPushNotification).toHaveBeenCalledTimes(2);
    expect(
      Number(
        (await pool.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1', [userId]))
          .rows[0].count
      )
    ).toBe(1);
  });
  test('turning off Health Feed cancels a pending retry', async () => {
    sendPushNotification.mockResolvedValueOnce({ ok: false });
    await dispatchPendingNotifications(pool);
    await pool.query(
      'UPDATE user_notification_preferences SET health_feed_enabled = false WHERE user_id = $1',
      [userId]
    );
    await pool.query(
      "UPDATE notification_push_outbox SET next_attempt_at = now() - interval '1 second' WHERE notification_id IN (SELECT id FROM notifications WHERE user_id = $1)",
      [userId]
    );
    await retryPendingNotifications(pool);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
});
