'use strict';

const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../src/services/notification/notification-quiet-hours.policy', () => ({
  ...jest.requireActual('../src/services/notification/notification-quiet-hours.policy'),
  getQuietHoursHoldUntil: () => null,
}));
jest.mock('../src/services/notification/notification-schedule.policy', () => ({
  ...jest.requireActual('../src/services/notification/notification-schedule.policy'),
  getScheduledReminderHoldUntil: async () => null,
}));
const { sendPushNotification } = require('../src/services/notification/push.notification.service');
const {
  reserveNotification,
  deliverNotification,
} = require('../src/services/notification/notification-dispatch.service');
const { followUpSnapshot } = require('../src/services/notification/checkin-reminder.policy');
const { runCheckinFollowUps } = require('../src/services/checkin/checkin.service');
const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('queued check-in reminders revalidate real patient state', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  let userId;
  beforeAll(async () => {
    userId = (
      await pool.query(
        "INSERT INTO users(display_name,push_token) VALUES('Reminder freshness fixture','ExpoPushToken[fake-never-send]') RETURNING id"
      )
    ).rows[0].id;
    await pool.query(
      'INSERT INTO user_notification_preferences(user_id,reminders_enabled) VALUES($1,true)',
      [userId]
    );
  });
  beforeEach(async () => {
    sendPushNotification.mockClear();
    await pool.query('DELETE FROM notifications WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM health_checkins WHERE user_id=$1', [userId]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
  });
  async function checkin({ completed = false } = {}) {
    return (
      await pool.query(
        `INSERT INTO health_checkins(user_id,session_date,initial_status,current_status,flow_state,
      last_response_at,triage_completed_at,triage_state) VALUES($1,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
      'tired','tired','follow_up',NOW()-INTERVAL '4 hours',
      CASE WHEN $2 THEN NOW()-INTERVAL '3 hours' ELSE NULL END,$3::jsonb) RETURNING *`,
        [
          userId,
          completed,
          JSON.stringify({
            phase: 'initial',
            phase_id: randomUUID(),
            revision: randomUUID(),
            ...(completed ? { completed: { finalized: true } } : {}),
          }),
        ]
      )
    ).rows[0];
  }
  const reserve = (type, data = {}) =>
    reserveNotification(pool, { userId, type, title: 'Reminder fixture', body: 'Fixture', data });
  const followup = async (session) => reserve('checkin_followup', followUpSnapshot(session));
  const job = async (id) =>
    (
      await pool.query(
        'SELECT state,attempts FROM notification_push_outbox WHERE notification_id=$1',
        [id]
      )
    ).rows[0];
  test.each(['morning_checkin', 'reengagement'])(
    '%s is cancelled if the user checks in after enqueue',
    async (type) => {
      const saved = await reserve(type);
      await checkin();
      expect(await deliverNotification(pool, saved.notificationId)).toMatchObject({
        skipped: true,
        reason: 'checkin_already_updated',
      });
      expect(await job(saved.notificationId)).toEqual({ state: 'CANCELLED', attempts: 0 });
      expect(sendPushNotification).not.toHaveBeenCalled();
      expect(
        (await pool.query('SELECT is_read FROM notifications WHERE id=$1', [saved.notificationId]))
          .rows[0].is_read
      ).toBe(true);
    }
  );
  test.each(['morning_checkin', 'reengagement'])(
    '%s is not created after today’s check-in, including unwell',
    async (type) => {
      await checkin();
      expect(await reserve(type)).toBeNull();
      expect(sendPushNotification).not.toHaveBeenCalled();
    }
  );
  test('a legitimate check-again reminder remains eligible after an earlier completed result', async () => {
    const session = await checkin({ completed: true });
    const saved = await followup(session);
    expect(await deliverNotification(pool, saved.notificationId)).toEqual({ ok: true });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
  test.each([0, 1])(
    'the scheduler acknowledges a completed result and records miss %i correctly',
    async (misses) => {
      const session = await checkin({ completed: true });
      await pool.query(
        "UPDATE health_checkins SET next_checkin_at=NOW()-INTERVAL '1 minute',no_response_count=$2 WHERE id=$1",
        [session.id, misses]
      );
      expect(await runCheckinFollowUps(pool)).toMatchObject({ total: 1, sent: 1 });
      const message = (
        await pool.query('SELECT title,message FROM notifications WHERE user_id=$1', [userId])
      ).rows[0];
      expect(message.title).toBe('Asinu hỏi thăm lại');
      expect(message.message).toContain('đã ghi nhận');
      expect(message.message).not.toMatch(/chưa hoàn tất|chưa xong/);
      expect(
        (
          await pool.query('SELECT no_response_count FROM health_checkins WHERE id=$1', [
            session.id,
          ])
        ).rows[0].no_response_count
      ).toBe(misses + 1);
    }
  );
  test('a patient response during dispatch cannot be overwritten by the scheduler counter update', async () => {
    const session = await checkin({ completed: true });
    await pool.query(
      "UPDATE health_checkins SET next_checkin_at=NOW()-INTERVAL '1 minute',no_response_count=1 WHERE id=$1",
      [session.id]
    );
    sendPushNotification.mockImplementationOnce(async () => {
      await pool.query(
        "UPDATE health_checkins SET last_response_at=NOW(),no_response_count=0,next_checkin_at=NOW()+INTERVAL '8 hours' WHERE id=$1",
        [session.id]
      );
      return { ok: true };
    });
    await runCheckinFollowUps(pool);
    expect(
      (
        await pool.query(
          "SELECT no_response_count,next_checkin_at>NOW()+INTERVAL '7 hours' AS kept_patient_schedule FROM health_checkins WHERE id=$1",
          [session.id]
        )
      ).rows[0]
    ).toEqual({ no_response_count: 0, kept_patient_schedule: true });
  });
  test('legacy unfinished-checkin copy is retired when the interview was already completed', async () => {
    const session = await checkin({ completed: true });
    // Emulate a job queued by the previous release, before the new validator.
    const saved = (
      await pool.query(
        "INSERT INTO notifications(user_id,type,title,message,data) VALUES($1,'checkin_followup','Old fixture','Bạn chưa hoàn tất check-in.',$2::jsonb) RETURNING id",
        [userId, JSON.stringify({ checkinId: String(session.id) })]
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO notification_push_outbox(notification_id,push_body) VALUES($1,'Old fixture')",
      [saved.id]
    );
    expect(await deliverNotification(pool, saved.id)).toMatchObject({
      skipped: true,
      reason: 'checkin_already_updated',
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
  test.each(['response', 'conclusion', 'new_phase', 'revision', 'resolved', 'past_day', 'deleted'])(
    'a queued follow-up is cancelled after %s changes',
    async (change) => {
      const session = await checkin();
      const saved = await followup(session);
      const updates = {
        response: 'UPDATE health_checkins SET last_response_at=NOW() WHERE id=$1',
        conclusion:
          "UPDATE health_checkins SET triage_completed_at=NOW(),triage_state=jsonb_set(triage_state,'{completed}','{\"finalized\":true}'::jsonb) WHERE id=$1",
        new_phase:
          "UPDATE health_checkins SET triage_state=jsonb_set(triage_state,'{phase_id}','\"new-phase\"') WHERE id=$1",
        revision:
          "UPDATE health_checkins SET triage_state=jsonb_set(triage_state,'{revision}','\"new-revision\"') WHERE id=$1",
        resolved: "UPDATE health_checkins SET flow_state='resolved',resolved_at=NOW() WHERE id=$1",
        past_day: 'UPDATE health_checkins SET session_date=session_date-1 WHERE id=$1',
        deleted: 'DELETE FROM health_checkins WHERE id=$1',
      };
      await pool.query(updates[change], [session.id]);
      expect(await deliverNotification(pool, saved.notificationId)).toMatchObject({
        skipped: true,
        reason: 'checkin_already_updated',
      });
      expect(await job(saved.notificationId)).toEqual({ state: 'CANCELLED', attempts: 0 });
      expect(sendPushNotification).not.toHaveBeenCalled();
    }
  );
  test('a response arriving before reservation also invalidates the scheduler snapshot', async () => {
    const session = await checkin();
    await pool.query('UPDATE health_checkins SET last_response_at=NOW() WHERE id=$1', [session.id]);
    expect(await followup(session)).toBeNull();
  });
  test('an emergency alert remains deliverable after the check-in is resolved', async () => {
    const session = await checkin();
    await pool.query("UPDATE health_checkins SET flow_state='resolved' WHERE id=$1", [session.id]);
    const saved = await reserve('emergency', { checkinId: String(session.id) });
    expect(await deliverNotification(pool, saved.notificationId)).toEqual({ ok: true });
  });
});
