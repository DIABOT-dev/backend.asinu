'use strict';

const { Pool } = require('pg');
// Only replace the clock. All policy decisions and SQL transitions are real;
// the push provider is mocked so these tests cannot notify real devices.
jest.mock('../src/services/notification/notification-quiet-hours.policy', () => {
  const actual = jest.requireActual('../src/services/notification/notification-quiet-hours.policy');
  return { ...actual, getQuietHoursHoldUntil: jest.fn(actual.getQuietHoursHoldUntil) };
});
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/checkin/checkin.service', () => ({
  runCheckinFollowUps: jest.fn().mockResolvedValue({ sent: 0 }),
  runMorningCheckin: jest.fn().mockResolvedValue({ sent: 0 }),
  runAlertConfirmationFollowUps: jest.fn().mockResolvedValue({ sent: 0 }),
}));
jest.mock('../src/services/notification/notification-intelligence.service', () => ({
  generateMessage: jest
    .fn()
    .mockResolvedValue({ text: 'Quiet-hours fixture', templateId: 'fixture' }),
  checkAlertTriggers: jest.fn().mockResolvedValue(null),
}));

const {
  getQuietHoursHoldUntil,
} = require('../src/services/notification/notification-quiet-hours.policy');
const actualPolicy = jest.requireActual(
  '../src/services/notification/notification-quiet-hours.policy'
);
const { sendPushNotification } = require('../src/services/notification/push.notification.service');
const {
  reserveNotification,
  deliverNotification,
} = require('../src/services/notification/notification-dispatch.service');
const {
  runBasicNotifications,
} = require('../src/services/notification/basic.notification.service');
const {
  getNotifications,
  markAllAsRead,
} = require('../src/services/notification/notification.service');
const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('quiet hours and configured night reminders (real SQL, fake provider)', () => {
  const originalMetricFlag = process.env.HEALTH_METRIC_REMINDERS_ENABLED;
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  let userId;
  const fixtureIds = [];
  const setClock = (date) =>
    getQuietHoursHoldUntil.mockImplementation((notification, preferences, timezone) =>
      actualPolicy.getQuietHoursHoldUntil(notification, preferences, timezone, new Date(date))
    );
  const preferences = async (values = {}) => {
    await pool.query(
      'INSERT INTO user_notification_preferences (user_id, reminders_enabled, morning_time, afternoon_time, evening_time) VALUES ($1, $2, $3, $4, $5)',
      [
        userId,
        values.reminders_enabled ?? true,
        values.morning_time ?? null,
        values.afternoon_time ?? null,
        values.evening_time ?? null,
      ]
    );
  };
  const reserve = (type = 'payment_failed', priority = 'low', data = {}) =>
    reserveNotification(pool, {
      userId,
      type,
      priority,
      data,
      title: 'Quiet-hours fixture',
      body: 'Fixture',
    });
  const job = async (id) =>
    (
      await pool.query(
        'SELECT state, attempts, next_attempt_at FROM notification_push_outbox WHERE notification_id = $1',
        [id]
      )
    ).rows[0];
  const due = (id) =>
    pool.query(
      "UPDATE notification_push_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE notification_id = $1",
      [id]
    );
  beforeAll(async () => {
    userId = (
      await pool.query(
        "INSERT INTO users (display_name, push_token) VALUES ('Quiet-hours fixture', 'ExpoPushToken[quiet-only-fixture]') RETURNING id"
      )
    ).rows[0].id;
    fixtureIds.push(userId);
  });
  beforeEach(async () => {
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'true';
    sendPushNotification.mockReset().mockResolvedValue({ ok: true });
    getQuietHoursHoldUntil.mockReset();
    setClock('2026-10-07T23:15:00+07:00');
    await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::int[])', [fixtureIds]);
    await pool.query('DELETE FROM user_notification_preferences WHERE user_id = ANY($1::int[])', [
      fixtureIds,
    ]);
    await pool.query('DELETE FROM user_onboarding_profiles WHERE user_id = ANY($1::int[])', [
      fixtureIds,
    ]);
    await pool.query(
      "UPDATE users SET push_token = 'ExpoPushToken[quiet-only-fixture]', deleted_at = NULL WHERE id = ANY($1::int[])",
      [fixtureIds]
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [fixtureIds]);
    await pool.end();
    if (originalMetricFlag === undefined) delete process.env.HEALTH_METRIC_REMINDERS_ENABLED;
    else process.env.HEALTH_METRIC_REMINDERS_ENABLED = originalMetricFlag;
  });

  test('transactional notification is retained until 06:00 without consuming an attempt', async () => {
    const row = await reserve();
    expect(await deliverNotification(pool, row.notificationId)).toEqual({
      ok: false,
      skipped: true,
      deferred: true,
      reason: 'quiet_hours',
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(await job(row.notificationId)).toEqual({
      state: 'RETRY',
      attempts: 0,
      next_attempt_at: new Date('2026-10-08T06:00:00+07:00'),
    });
    expect(
      (await pool.query('SELECT id FROM notifications WHERE user_id = $1', [userId])).rows
    ).toEqual([{ id: row.notificationId }]);
  });
  test('duplicate night event keeps one job and concurrent daytime workers send it once', async () => {
    const row = await reserve('payment_failed', 'high', { paymentId: 'quiet-duplicate' });
    await deliverNotification(pool, row.notificationId);
    const duplicate = await reserve('payment_failed', 'high', { paymentId: 'quiet-duplicate' });
    expect(duplicate).toEqual({ notificationId: row.notificationId, existing: true });
    setClock('2026-10-08T06:00:00+07:00');
    await due(row.notificationId);
    await Promise.all([
      deliverNotification(pool, row.notificationId),
      deliverNotification(pool, row.notificationId),
    ]);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(await job(row.notificationId)).toMatchObject({ state: 'SENT', attempts: 1 });
  });
  test('explicit evening 23:15 reminder can send at night', async () => {
    await preferences({ evening_time: '23:15' });
    const row = await reserve('reminder_evening_summary');
    await pool.query('UPDATE notifications SET created_at = $2 WHERE id = $1', [
      row.notificationId,
      new Date('2026-10-07T23:15:00+07:00'),
    ]);
    expect(await deliverNotification(pool, row.notificationId)).toEqual({ ok: true });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test('inferred night schedule cannot authorize a push', async () => {
    await preferences();
    await pool.query(
      'UPDATE user_notification_preferences SET inferred_evening_hour = 23 WHERE user_id = $1',
      [userId]
    );
    const row = await reserve('reminder_evening_summary');
    await pool.query('UPDATE notifications SET created_at = $2 WHERE id = $1', [
      row.notificationId,
      new Date('2026-10-07T23:00:00+07:00'),
    ]);
    expect(await deliverNotification(pool, row.notificationId)).toMatchObject({
      reason: 'quiet_hours',
      deferred: true,
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
  test('changing the configured night time invalidates its queued exception', async () => {
    await preferences({ evening_time: '23:15' });
    const row = await reserve('reminder_evening_summary');
    await pool.query('UPDATE notifications SET created_at = $2 WHERE id = $1', [
      row.notificationId,
      new Date('2026-10-07T23:15:00+07:00'),
    ]);
    await pool.query(
      "UPDATE user_notification_preferences SET evening_time = '21:00' WHERE user_id = $1",
      [userId]
    );
    expect(await deliverNotification(pool, row.notificationId)).toMatchObject({
      deferred: true,
      reason: 'quiet_hours',
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
  test('opt-out after a night deferral cancels delivery in the morning', async () => {
    await preferences();
    const row = await reserve('reminder_evening_summary');
    await deliverNotification(pool, row.notificationId);
    await pool.query(
      'UPDATE user_notification_preferences SET reminders_enabled = false WHERE user_id = $1',
      [userId]
    );
    setClock('2026-10-08T06:00:00+07:00');
    await due(row.notificationId);
    expect(await deliverNotification(pool, row.notificationId)).toEqual({
      ok: false,
      skipped: true,
    });
    expect(await job(row.notificationId)).toMatchObject({ state: 'CANCELLED', attempts: 0 });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
  test('critical safety alert still sends at night', async () => {
    const row = await reserve('checkin_followup_urgent', 'critical');
    expect(await deliverNotification(pool, row.notificationId)).toEqual({ ok: true });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test('05:30 remains quiet until 06:00', async () => {
    setClock('2026-10-08T05:30:00+07:00');
    const row = await reserve();
    expect(await deliverNotification(pool, row.notificationId)).toMatchObject({
      deferred: true,
      reason: 'quiet_hours',
    });
    expect(await job(row.notificationId)).toMatchObject({
      next_attempt_at: new Date('2026-10-08T06:00:00+07:00'),
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
  test('the temporary pause cancels existing retries and hides their inbox rows without deleting history', async () => {
    await preferences();
    const metric = await reserve('reminder_morning_summary');
    const visible = await reserve('morning_checkin');
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'false';
    expect(await reserve('reminder_glucose')).toBeNull();
    expect(await deliverNotification(pool, metric.notificationId)).toEqual({
      ok: false,
      skipped: true,
      reason: 'health_metric_reminders_paused',
    });
    expect(await job(metric.notificationId)).toMatchObject({ state: 'CANCELLED', attempts: 0 });
    const listed = await getNotifications(pool, userId, { page: 1, limit: 1 });
    expect(listed.notifications.map((notification) => notification.id)).toEqual([
      visible.notificationId,
    ]);
    expect(listed.pagination).toEqual({ page: 1, limit: 1, total: 1, unreadCount: 1 });
    expect(
      (
        await pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1', [
          userId,
        ])
      ).rows[0].count
    ).toBe(2);
    expect(sendPushNotification).not.toHaveBeenCalled();
    await markAllAsRead(pool, userId);
    expect(
      (await pool.query('SELECT is_read FROM notifications WHERE id = $1', [metric.notificationId]))
        .rows[0].is_read
    ).toBe(false);
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'true';
    const restored = await getNotifications(pool, userId);
    expect(restored.pagination.total).toBe(2);
    expect(restored.pagination.unreadCount).toBe(1);
    expect(await job(metric.notificationId)).toMatchObject({ state: 'CANCELLED', attempts: 0 });
  });
  test('inactive scheduled outbox rows cannot block other opted-in notifications', async () => {
    await preferences();
    await reserve('reminder_evening_summary');
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'false';
    setClock('2026-10-07T12:00:00+07:00');
    const routine = await reserve('reengagement');
    expect(routine).not.toBeNull();
    expect(await deliverNotification(pool, routine.notificationId)).toEqual({ ok: true });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test('the pause does not block an urgent check-in call/alert', async () => {
    process.env.HEALTH_METRIC_REMINDERS_ENABLED = 'false';
    const row = await reserve('checkin_call', 'high', { kind: 'INCOMING_CALL' });
    expect(await deliverNotification(pool, row.notificationId)).toEqual({ ok: true });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['23:15', 23, 15, 'evening_time', 'reminder_evening_summary', null],
    ['05:30', 5, 30, 'morning_time', 'reminder_morning_summary', null],
    ['00:15', 0, 15, 'afternoon_time', 'reminder_afternoon', null],
    ['23:00 legacy', 23, 0, 'evening_hour', 'reminder_evening_summary', 23],
  ])(
    'scheduler creates only explicitly configured %s jobs, not inferred night schedules',
    async (_label, hour, minute, field, type, legacyHour) => {
      const otherId = (
        await pool.query(
          "INSERT INTO users (display_name, push_token) VALUES ('Inferred-only fixture', 'ExpoPushToken[inferred-only-fixture]') RETURNING id"
        )
      ).rows[0].id;
      fixtureIds.push(otherId);
      await pool.query(
        'INSERT INTO user_onboarding_profiles (user_id, onboarding_completed_at) VALUES ($1, NOW()), ($2, NOW())',
        [userId, otherId]
      );
      await preferences(
        legacyHour === null
          ? { [field]: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
          : {}
      );
      if (legacyHour !== null)
        await pool.query(
          'UPDATE user_notification_preferences SET evening_hour = $2 WHERE user_id = $1',
          [userId, legacyHour]
        );
      await pool.query(
        'INSERT INTO user_notification_preferences (user_id, reminders_enabled, inferred_morning_hour, inferred_afternoon_time, inferred_evening_hour) VALUES ($1, true, $2, $3, $2)',
        [otherId, hour, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`]
      );
      const result = await runBasicNotifications(pool, hour, minute);
      expect(result.quietHours).toBe(true);
      expect(result.results.some((entry) => entry.failed)).toBe(false);
      expect(
        (
          await pool.query(
            'SELECT user_id, type FROM notifications WHERE user_id = ANY($1::int[]) ORDER BY id',
            [fixtureIds]
          )
        ).rows
      ).toEqual([{ user_id: userId, type }]);
    }
  );
});
