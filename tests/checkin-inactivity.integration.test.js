'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

// Real database decisions/outboxes, no network deliveries or generated audio.
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/notification/fcm.notification.service', () => ({
  sendFcmNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/notification/apns.voip.service', () => ({
  sendVoipNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/checkin-call/audio.service', () => ({
  synthesizeText: jest.fn(),
  audioVersion: jest.fn(),
}));
jest.mock('../src/services/integrations/crm-event.service', () => ({
  emitCrmEventAsync: jest.fn(),
}));
jest.mock('../src/services/notification/notification-quiet-hours.policy', () => ({
  ...jest.requireActual('../src/services/notification/notification-quiet-hours.policy'),
  getQuietHoursHoldUntil: () => null,
}));

const {
  INACTIVITY_NOTICE_TYPE,
  getCheckinInactivity,
  inactivityStateSql,
  suppressInactivityNotification,
  routineCall,
} = require('../src/services/checkin/checkin-inactivity.policy');
const { notifyInactiveCareCircles } = require('../src/services/checkin/checkin-inactivity.service');
const {
  reserveNotification,
  deliverNotification,
} = require('../src/services/notification/notification-dispatch.service');
const { sendPushNotification } = require('../src/services/notification/push.notification.service');
const { sendFcmNotification } = require('../src/services/notification/fcm.notification.service');
const { sendVoipNotification } = require('../src/services/notification/apns.voip.service');
const calls = require('../src/services/checkin-call/checkin-call.service');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;
const today = "(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const tables = [
  'users',
  'user_connections',
  'health_checkins',
  'notifications',
  'notification_push_outbox',
  'user_notification_preferences',
  'user_baselines',
  'user_onboarding_profiles',
  'subscription_households',
  'subscription_household_members',
  'checkin_call_settings',
  'checkin_call_episodes',
  'checkin_call_attempts',
  'checkin_call_deliveries',
  'checkin_call_events',
];

describeDatabase('Care Circle weekly check-in pause (isolated schema, mocked delivery)', () => {
  const schema = `checkin_inactivity_test_${process.pid}_${Date.now()}`;
  let admin;
  let pool;
  let patient;
  let relative;
  let connection;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: process.env.CHECKIN_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    // LIKE does not copy foreign keys/triggers or data. Copy defaults/indexes,
    // then replace serial defaults so even sequences stay inside this schema.
    for (const table of tables) {
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      const serials = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_default LIKE 'nextval(%'`,
        [schema, table]
      );
      for (const { column_name: column } of serials.rows) {
        const sequence = `${table}_${column}_fixture_seq`;
        await pool.query(`CREATE SEQUENCE ${sequence}`);
        await pool.query(
          `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT nextval('${sequence}')`
        );
      }
    }
    // Apply the actual migration, including the receipt's ON DELETE SET NULL.
    await pool.query(
      fs.readFileSync(
        path.join(__dirname, '../db/migrations/119_checkin_inactivity_notices.sql'),
        'utf8'
      )
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    sendPushNotification.mockResolvedValue({ ok: true });
    await pool.query(`TRUNCATE ${tables.join(', ')}, checkin_inactivity_notices CASCADE`);
    const users = await pool.query(
      "INSERT INTO users (display_name, push_token, fcm_token) VALUES ('Nguyễn Minh','ExpoPushToken[patient-fixture]','fcm-patient-fixture'), ('Trần Lan','ExpoPushToken[relative-fixture]','fcm-relative-fixture') RETURNING id"
    );
    [patient, relative] = users.rows.map((u) => u.id);
    const connected = await pool.query(
      `INSERT INTO user_connections (requester_id, addressee_id, status, accepted_at, permissions)
       VALUES ($1,$2,'accepted', ((${today} - 30)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'), '{"can_receive_alerts":true,"can_ack_escalation":false}') RETURNING id`,
      [patient, relative]
    );
    connection = connected.rows[0].id;
    // Only the patient is inactive; recipients can themselves be patients in a
    // different inactivity span, with no inferred mother/child role.
    await checkin(relative, 0);
    await checkin(patient, 7);
    await pool.query(
      'INSERT INTO user_notification_preferences (user_id, reminders_enabled) VALUES ($1,true)',
      [patient]
    );
  });

  async function checkin(userId, daysAgo) {
    return pool.query(
      `INSERT INTO health_checkins (user_id, session_date, initial_status, current_status)
       VALUES ($1, ${today} - $2::int, 'ok', 'ok') RETURNING id`,
      [userId, daysAgo]
    );
  }

  async function setLastCheckin(daysAgo) {
    await pool.query(
      `UPDATE health_checkins SET session_date = ${today} - $2::int WHERE user_id = $1`,
      [patient, daysAgo]
    );
  }

  function noticeInput(state) {
    return {
      userId: relative,
      type: INACTIVITY_NOTICE_TYPE,
      title: 'Tạm dừng nhắc check-in',
      body: 'Thông báo một lần',
      priority: 'high',
      data: {
        type: INACTIVITY_NOTICE_TYPE,
        patient_id: patient,
        inactive_since_date: state.inactive_since_date,
      },
    };
  }

  async function episode({
    severity = 'NONE',
    trigger = 'MISSED_CHECKIN',
    state = 'CONTACT_USER',
    config = {},
  } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO checkin_call_episodes (user_id, local_date, scheduled_at, grace_until, next_action_at, config, severity, trigger_source, state)
       VALUES ($1,${today},now(),now(),now() + interval '1 hour',$2::jsonb,$3,$4,$5) RETURNING *`,
      [patient, JSON.stringify(config), severity, trigger, state]
    );
    const e = rows[0];
    const attempt = await pool.query(
      `INSERT INTO checkin_call_attempts (episode_id, target_user_id, target_role, room_name, ring_deadline)
       VALUES ($1,$2,'USER',$3,now() + interval '1 minute') RETURNING id`,
      [e.id, patient, randomUUID()]
    );
    await pool.query(
      `INSERT INTO checkin_call_deliveries (episode_id, attempt_id, target_user_id, kind)
       VALUES ($1,$2,$3,'INCOMING_CALL')`,
      [e.id, attempt.rows[0].id, patient]
    );
    return e;
  }

  test.each([6, 7, 8, 30])('pauses at day 7, not day 6 (day %i)', async (days) => {
    await setLastCheckin(days);
    const status = await getCheckinInactivity(pool, patient);
    expect(status.inactive_days).toBe(days);
    expect(status.paused).toBe(days >= 7);
  });

  test('uses VN midnight, not UTC midnight or a device clock', async () => {
    await pool.query("UPDATE health_checkins SET session_date='2026-10-01' WHERE user_id=$1", [
      patient,
    ]);
    await pool.query(
      "UPDATE user_connections SET accepted_at='2026-09-01T00:00:00+07:00' WHERE id=$1",
      [connection]
    );
    const sql = inactivityStateSql('$1::int', '$2::timestamptz');
    expect((await pool.query(sql, [patient, '2026-10-07T16:59:59Z'])).rows[0].paused).toBe(false);
    expect((await pool.query(sql, [patient, '2026-10-07T17:00:00Z'])).rows[0].paused).toBe(true);
  });

  test('only accepted circles count; never-checked-in/newly connected people get seven days', async () => {
    await pool.query("UPDATE user_connections SET status='pending' WHERE id=$1", [connection]);
    expect((await getCheckinInactivity(pool, patient)).paused).toBe(false);
    await pool.query(
      `UPDATE user_connections SET status='accepted', accepted_at=((${today} - 6)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') WHERE id=$1`,
      [connection]
    );
    await pool.query('DELETE FROM health_checkins WHERE user_id=$1', [patient]);
    expect((await getCheckinInactivity(pool, patient)).paused).toBe(false);
    await pool.query(
      "UPDATE user_connections SET accepted_at=accepted_at - interval '1 day' WHERE id=$1",
      [connection]
    );
    expect((await getCheckinInactivity(pool, patient)).paused).toBe(true);
    expect((await notifyInactiveCareCircles(pool)).created).toBe(1);
  });

  test('two workers produce one family notice; restarts/days later/inbox deletion do not resend', async () => {
    const results = await Promise.all([
      notifyInactiveCareCircles(pool),
      notifyInactiveCareCircles(pool),
    ]);
    expect(results.reduce((n, x) => n + x.created, 0)).toBe(1);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    const inbox = await pool.query('SELECT * FROM notifications');
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].user_id).toBe(relative);
    expect(inbox.rows[0].data.patient_id).toBe(patient);
    expect(inbox.rows[0].message).toContain('7 ngày');
    // Advance only the policy's reference clock; the absence anchor is stable.
    const future = await pool.query(inactivityStateSql('$1::int', "NOW() + interval '10 days'"), [
      patient,
    ]);
    expect(future.rows[0].paused).toBe(true);
    expect(future.rows[0].inactive_since_date).toBe(inbox.rows[0].data.inactive_since_date);
    expect((await notifyInactiveCareCircles(pool)).created).toBe(0);
    await pool.query('DELETE FROM notifications');
    const receipt = await pool.query('SELECT notification_id FROM checkin_inactivity_notices');
    expect(receipt.rows[0].notification_id).toBeNull();
    expect((await notifyInactiveCareCircles(pool)).created).toBe(0);
    expect(
      await reserveNotification(pool, noticeInput(await getCheckinInactivity(pool, patient)))
    ).toBeNull();
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  test('delivery failure retries the same notice, without another inbox row', async () => {
    sendPushNotification.mockResolvedValueOnce({ ok: false });
    await notifyInactiveCareCircles(pool);
    const { rows } = await pool.query(
      'SELECT notification_id, state FROM notification_push_outbox'
    );
    expect(rows[0].state).toBe('RETRY');
    expect((await notifyInactiveCareCircles(pool)).created).toBe(0);
    await pool.query('UPDATE notification_push_outbox SET next_attempt_at=now()');
    expect((await deliverNotification(pool, rows[0].notification_id)).ok).toBe(true);
    expect((await pool.query('SELECT * FROM notifications')).rowCount).toBe(1);
    expect(sendPushNotification).toHaveBeenCalledTimes(2);
  });

  test('receipt and inbox creation roll back together', async () => {
    const state = await getCheckinInactivity(pool, patient);
    await expect(
      reserveNotification(pool, { ...noticeInput(state), title: 'x'.repeat(1000) })
    ).rejects.toThrow();
    expect((await pool.query('SELECT * FROM checkin_inactivity_notices')).rowCount).toBe(0);
    expect((await reserveNotification(pool, noticeInput(state))).existing).toBe(false);
  });

  test('a new check-in resumes reminders; queued pause notices become stale and the next absence is separate', async () => {
    const reserved = await reserveNotification(
      pool,
      noticeInput(await getCheckinInactivity(pool, patient))
    );
    await checkin(patient, 0);
    expect((await getCheckinInactivity(pool, patient)).paused).toBe(false);
    expect((await deliverNotification(pool, reserved.notificationId)).reason).toBe(
      'checkin_inactivity_paused'
    );
    expect(await suppressInactivityNotification(pool, patient, 'morning_checkin')).toBe(false);
    // Simulate a later span using separate historical check-ins/connections.
    await pool.query(
      `UPDATE health_checkins SET session_date=${today} - 14 WHERE user_id=$1 AND session_date < ${today}`,
      [patient]
    );
    await pool.query(
      `UPDATE health_checkins SET session_date=${today} - 7 WHERE user_id=$1 AND session_date=${today}`,
      [patient]
    );
    // The old receipt describes the earlier span, not this one.
    await pool.query(
      'UPDATE checkin_inactivity_notices SET inactive_since_date=inactive_since_date - 7'
    );
    expect((await notifyInactiveCareCircles(pool)).created).toBe(1);
    expect((await pool.query('SELECT * FROM checkin_inactivity_notices')).rowCount).toBe(2);
  });

  test('honors alert permission and cancels a queued notice after revocation', async () => {
    await pool.query("UPDATE user_connections SET permissions='{}' WHERE id=$1", [connection]);
    expect((await notifyInactiveCareCircles(pool)).created).toBe(0);
    const state = await getCheckinInactivity(pool, patient);
    expect(await reserveNotification(pool, noticeInput(state))).toBeNull();
    await pool.query(
      'UPDATE user_connections SET permissions=\'{"can_receive_alerts":true}\' WHERE id=$1',
      [connection]
    );
    const reserved = await reserveNotification(pool, noticeInput(state));
    await pool.query("UPDATE user_connections SET permissions='{}' WHERE id=$1", [connection]);
    expect((await deliverNotification(pool, reserved.notificationId)).skipped).toBe(true);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  test('blocks new and queued routine reminders and legacy family nags, preserving health/doctor alerts', async () => {
    await setLastCheckin(6);
    const reminder = await reserveNotification(pool, {
      userId: patient,
      type: 'morning_checkin',
      title: 'Check-in',
      body: 'Nhắc',
      push: true,
    });
    expect(reminder).toBeTruthy();
    await setLastCheckin(7);
    expect((await deliverNotification(pool, reminder.notificationId)).reason).toBe(
      'checkin_inactivity_paused'
    );
    expect(
      await reserveNotification(pool, {
        userId: patient,
        type: 'evening_checkin',
        title: 'Check-in',
        body: 'Nhắc',
      })
    ).toBeNull();
    expect(
      await suppressInactivityNotification(pool, relative, 'caregiver_alert', {
        reengage_patient_id: patient,
      })
    ).toBe(true);
    for (const type of [
      'health_alert',
      'checkin_followup_urgent',
      'early_signal',
      'doctor_message',
      'caregiver_alert',
    ]) {
      expect(await suppressInactivityNotification(pool, patient, type, {})).toBe(false);
    }
    const urgent = await reserveNotification(pool, {
      userId: patient,
      type: 'health_alert',
      title: 'Cần chú ý',
      body: 'Cảnh báo',
      priority: 'high',
    });
    expect((await deliverNotification(pool, urgent.notificationId)).ok).toBe(true);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  test('does not create daily calls while paused, resumes without changing enabled preference', async () => {
    const household = await pool.query(
      "INSERT INTO subscription_households (owner_user_id, plan_code, current_period_end) VALUES ($1,'antam_2',now() + interval '1 year') RETURNING id",
      [relative]
    );
    await pool.query(
      'INSERT INTO subscription_household_members (household_id, user_id) VALUES ($1,$2)',
      [household.rows[0].id, patient]
    );
    await pool.query(
      "INSERT INTO checkin_call_settings (user_id, enabled, checkin_time) VALUES ($1,true,'00:00')",
      [patient]
    );
    expect(await calls.createDailyEpisodes(pool)).toBe(0);
    await setLastCheckin(6);
    expect(await calls.createDailyEpisodes(pool)).toBe(1);
    expect(
      (await pool.query('SELECT enabled FROM checkin_call_settings WHERE user_id=$1', [patient]))
        .rows[0].enabled
    ).toBe(true);
  });

  test('cancels an existing routine call, attempt and pending delivery, and sends only native END_CALL', async () => {
    const e = await episode();
    await calls.advance(pool, e.id);
    expect(
      (await pool.query('SELECT state FROM checkin_call_episodes WHERE id=$1', [e.id])).rows[0]
        .state
    ).toBe('CANCELLED');
    expect((await pool.query('SELECT state FROM checkin_call_attempts')).rows[0].state).toBe(
      'CANCELLED'
    );
    expect((await pool.query('SELECT state FROM checkin_call_deliveries')).rows[0].state).toBe(
      'CANCELLED'
    );
    expect((await pool.query('SELECT detail FROM checkin_call_events')).rows[0].detail.reason).toBe(
      'CHECKIN_INACTIVITY_7_DAYS'
    );
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendVoipNotification).not.toHaveBeenCalled();
    expect(sendFcmNotification.mock.calls.every((c) => c[3]?.action === 'END_CALL')).toBe(true);
  });

  test('delivery gate cancels already queued calls before ringing, even before their next advance', async () => {
    await episode();
    await calls.dispatchDeliveries(pool);
    expect((await pool.query('SELECT state FROM checkin_call_episodes')).rows[0].state).toBe(
      'CANCELLED'
    );
    expect((await pool.query('SELECT state FROM checkin_call_deliveries')).rows[0].state).toBe(
      'CANCELLED'
    );
    expect(sendVoipNotification).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendFcmNotification.mock.calls.every((c) => c[3]?.action === 'END_CALL')).toBe(true);
  });

  test.each([
    { severity: 'URGENT' },
    { severity: 'MILD' },
    { trigger: 'EARLY_SIGNAL', config: { early_signal: true } },
  ])('preserves an active health escalation %j', async (config) => {
    const e = await episode(config);
    expect(routineCall(e)).toBe(false);
    await calls.advance(pool, e.id);
    expect(
      (await pool.query('SELECT state FROM checkin_call_episodes WHERE id=$1', [e.id])).rows[0]
        .state
    ).toBe('CONTACT_USER');
    expect((await pool.query('SELECT state FROM checkin_call_deliveries')).rows[0].state).toBe(
      'PENDING'
    );
  });
});
