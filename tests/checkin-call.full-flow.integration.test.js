const { Pool } = require('pg');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET ||= 'local-checkin-flow-test-secret-not-for-production';
jest.mock('../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: jest
    .fn()
    .mockResolvedValue({ ok: true, data: { data: [{ status: 'ok' }] } }),
}));
jest.mock('../src/services/notification/fcm.notification.service', () => ({
  sendFcmNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/notification/apns.voip.service', () => ({
  sendVoipNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
const service = require('../src/services/checkin-call/checkin-call.service');
const entitlementService = require('../src/services/payment/entitlement.service');
const checkinCallRoutes = require('../src/routes/checkin-call.routes');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('check-in call six-account full flow', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const createdUserIds = [];
  const prefix = `ux-call-${Date.now()}-`;
  let patientId;
  let familyIds;
  let baseline;
  const app = express();
  app.locals.authPool = pool;
  app.use(express.json());
  app.use('/api/mobile/checkin-call', checkinCallRoutes(pool));
  const token = (id) =>
    'Bearer ' + jwt.sign({ id, auth_version: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });

  async function startEpisode(localDate) {
    const settings = await service.settings(pool, patientId);
    const inserted = await pool.query(
      `INSERT INTO checkin_call_episodes (
         user_id, local_date, state, severity, scheduled_at, grace_until, next_action_at, config
       ) VALUES ($1,$2,'SCHEDULED','NONE',now(),now(),now() - interval '1 second',$3::jsonb)
       RETURNING id`,
      [patientId, localDate, JSON.stringify({ ...settings, enabled: true })]
    );
    const episodeId = inserted.rows[0].id;
    await service.advance(pool, episodeId);
    const active = await service.getActive(pool, patientId);
    expect(active).toMatchObject({ id: episodeId, target_role: 'USER', state: 'CONTACT_USER' });
    return { episodeId, active };
  }

  async function forceEpisodeDue(episodeId) {
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE id = $1",
      [episodeId]
    );
    await service.advance(pool, episodeId);
  }

  beforeAll(async () => {
    const baselineResult = await Promise.all([
      pool.query('SELECT COUNT(*)::integer AS count FROM users'),
      pool.query('SELECT COUNT(*)::integer AS count FROM checkin_call_episodes'),
    ]);
    baseline = {
      users: baselineResult[0].rows[0].count,
      episodes: baselineResult[1].rows[0].count,
    };

    for (let index = 0; index < 6; index += 1) {
      const inserted = await pool.query(
        `INSERT INTO users (phone_number, display_name, push_token, language_preference)
         VALUES ($1,$2,$3,'vi') RETURNING id`,
        [
          `${prefix}${index}`,
          index === 0 ? 'UX Patient' : `UX Family ${index}`,
          `ExponentPushToken[${prefix}${index}]`,
        ]
      );
      createdUserIds.push(inserted.rows[0].id);
    }
    [patientId, ...familyIds] = createdUserIds;

    await entitlementService.activateHouseholdPlan(pool, patientId, {
      planCode: 'antam_8',
      billingPeriod: 'monthly',
      platform: 'google',
      productId: 'asinu.antam8.monthly',
      originalTransactionId: `full-flow-${patientId}`,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    for (let index = 0; index < familyIds.length; index += 1) {
      await pool.query(
        `INSERT INTO user_connections (
           requester_id, addressee_id, status, requested_by, relationship_type,
           permissions, accepted_at, updated_at
         ) VALUES ($1,$2,'accepted',$1,'family',$3::jsonb,now(),now() - ($4::integer * interval '1 minute'))`,
        [
          patientId,
          familyIds[index],
          JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true }),
          index,
        ]
      );
    }

    await pool.query(
      `INSERT INTO user_onboarding_profiles (user_id, chronic_symptoms)
       VALUES ($1,$2::jsonb)`,
      [patientId, JSON.stringify(['Chóng mặt', 'Đau đầu'])]
    );
    await pool.query(
      `INSERT INTO health_checkins (
         user_id, session_date, initial_status, current_status, flow_state,
         body_location, body_locations, triage_completed_at
       ) VALUES
         ($1, DATE '2097-12-30', 'tired', 'tired', 'follow_up', 'head', ARRAY['head'], now()),
         ($1, DATE '2097-12-29', 'tired', 'tired', 'follow_up', 'head', ARRAY['head'], now()),
         ($1, DATE '2097-12-28', 'tired', 'tired', 'follow_up', 'chest', ARRAY['chest'], now())`,
      [patientId]
    );
    await pool.query(
      `INSERT INTO symptom_frequency (
         user_id, symptom_name, count_7d, count_30d, trend, last_occurred
       ) VALUES ($1,'Chóng mặt',3,5,'increasing',DATE '2097-12-30')`,
      [patientId]
    );

    await service.saveSettings(pool, patientId, {
      enabled: true,
      checkin_time: '08:00',
      timezone: 'Asia/Ho_Chi_Minh',
      grace_hours: 2,
      user_timeout_seconds: 60,
      family_ring_seconds: 60,
      family_confirm_minutes: 5,
      max_rounds: 1,
    });
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length) {
        // A caregiver can be deleted before the patient in an unordered DELETE.
        // Remove fixture episodes first so acknowledged_by cannot block cleanup.
        await pool.query('DELETE FROM checkin_call_episodes WHERE user_id = ANY($1::integer[])', [
          createdUserIds,
        ]);
        await pool.query(
          'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
          [createdUserIds]
        );
        await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [createdUserIds]);
      }
      const residue = await pool.query(
        'SELECT COUNT(*)::integer AS count FROM users WHERE phone_number LIKE $1',
        [`${prefix}%`]
      );
      expect(residue.rows[0].count).toBe(0);
      const finalResult = await Promise.all([
        pool.query('SELECT COUNT(*)::integer AS count FROM users'),
        pool.query('SELECT COUNT(*)::integer AS count FROM checkin_call_episodes'),
      ]);
      expect(finalResult[0].rows[0].count).toBe(baseline.users);
      expect(finalResult[1].rows[0].count).toBe(baseline.episodes);
    } finally {
      await pool.end();
    }
  });

  test('MILD uses recent context, seen does not resolve, then the next family confirms', async () => {
    const { episodeId, active } = await startEpisode('2098-01-01');
    await service.accept(pool, active.attempt_id, patientId);

    const triage = await service.startTriage(pool, episodeId, patientId, 'vi');
    expect(triage.episode.state).toBe('TRIAGE_USER');
    expect(triage.triage.has_recent_context).toBe(true);
    expect(triage.triage.locations[0].key).toBe('head');
    expect(triage.triage.locations[0].symptoms[0].key).toBe('dizziness');

    const escalated = await service.completeTriage(pool, episodeId, patientId, {
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MODERATE',
    });
    expect(escalated).toMatchObject({ state: 'MILD_FAMILY_ESCALATION', severity: 'MILD' });

    const firstFamily = await service.getActive(pool, familyIds[0]);
    expect(firstFamily).toMatchObject({ id: episodeId, target_role: 'FAMILY' });
    expect(
      (await Promise.all(familyIds.slice(1).map((id) => service.getActive(pool, id)))).filter(
        Boolean
      )
    ).toHaveLength(0);

    await service.seen(pool, firstFamily.attempt_id, familyIds[0]);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe(
      'MILD_FAMILY_ESCALATION'
    );

    await forceEpisodeDue(episodeId);
    expect((await service.getAttempt(pool, firstFamily.attempt_id, familyIds[0])).state).toBe(
      'PUSH_WAIT'
    );
    await forceEpisodeDue(episodeId);

    const secondFamily = await service.getActive(pool, familyIds[1]);
    expect(secondFamily).toMatchObject({ id: episodeId, target_role: 'FAMILY' });
    await service.accept(pool, secondFamily.attempt_id, familyIds[1]);
    const resolved = await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
    expect(resolved).toMatchObject({ state: 'RESOLVED', acknowledged_by: familyIds[1] });
    expect(
      (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).filter(Boolean)
    ).toHaveLength(0);
  });

  test('red-flag symptom overrides mild input and calls all five family members', async () => {
    const { episodeId, active } = await startEpisode('2098-01-02');
    await service.accept(pool, active.attempt_id, patientId);
    await service.startTriage(pool, episodeId, patientId, 'vi');
    const escalated = await service.completeTriage(pool, episodeId, patientId, {
      body_location: 'chest',
      symptom: 'shortness_of_breath',
      intensity: 'MILD',
    });
    expect(escalated).toMatchObject({ state: 'URGENT_BROADCAST', severity: 'URGENT' });
    expect(escalated.triage_context.intensity).toBe('URGENT');

    const activeCalls = await Promise.all(familyIds.map((id) => service.getActive(pool, id)));
    expect(activeCalls.filter(Boolean)).toHaveLength(5);
    activeCalls.forEach((call) =>
      expect(call).toMatchObject({ id: episodeId, target_role: 'FAMILY' })
    );

    const acceptedBy = familyIds[3];
    const acceptedAttempt = activeCalls[3].attempt_id;
    expect((await service.accept(pool, acceptedAttempt, acceptedBy)).state).toBe(
      'URGENT_BROADCAST'
    );
    const remaining = await Promise.all(
      familyIds.map(async (id) => ({ id, active: await service.getActive(pool, id) }))
    );
    expect(remaining.filter((item) => item.id !== acceptedBy && item.active)).toHaveLength(4);
    expect(remaining.find((item) => item.id === acceptedBy).active.attempt_id).toBe(
      acceptedAttempt
    );

    const resolved = await service.confirmFamily(pool, episodeId, acceptedBy, 'ON_MY_WAY');
    expect(resolved).toMatchObject({ state: 'RESOLVED', acknowledged_by: acceptedBy });
    expect(resolved.resolved_at).toBeTruthy();
    expect(
      (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).filter(Boolean)
    ).toHaveLength(0);
  });

  test('urgent pickup times out and re-rings without cancelling other relatives', async () => {
    const { episodeId, active } = await startEpisode('2098-02-01');
    await service.answer(pool, episodeId, patientId, 3);
    const family = await service.getActive(pool, familyIds[0]);
    await service.accept(pool, family.attempt_id, familyIds[0]);
    await pool.query(
      "UPDATE checkin_call_attempts SET confirm_deadline = now() - interval '1 second' WHERE id = $1",
      [family.attempt_id]
    );
    await forceEpisodeDue(episodeId);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    const retried = await service.getActive(pool, familyIds[0]);
    expect(retried.attempt_id).not.toBe(family.attempt_id);
    expect((await service.getAttempt(pool, family.attempt_id, familyIds[0])).state).toBe('EXPIRED');
    expect(await service.cancelActiveForManualCheckin(pool, patientId)).toBe(0);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
    expect((await service.getAttempt(pool, active.attempt_id, patientId)).severity).toBe('URGENT');
  });

  test('triage can be skipped or escalated immediately and saves real health history', async () => {
    const { episodeId } = await startEpisode('2098-02-02');
    await service.startTriage(pool, episodeId, patientId, 'vi');
    await service.answer(pool, episodeId, patientId, 2);
    const recorded = await pool.query(
      'SELECT current_status, occurrence_source FROM health_checkins WHERE user_id = $1 AND session_date = $2',
      [patientId, '2098-02-02']
    );
    expect(recorded.rows[0]).toMatchObject({
      current_status: 'tired',
      occurrence_source: 'checkin_call',
    });
    const family = (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).find(
      Boolean
    );
    const actor = (
      await pool.query('SELECT target_user_id FROM checkin_call_attempts WHERE id = $1', [
        family.attempt_id,
      ])
    ).rows[0].target_user_id;
    await service.confirmFamily(pool, episodeId, actor, 'ACCEPT_AND_CHECK');

    const urgent = await startEpisode('2098-02-03');
    await service.startTriage(pool, urgent.episodeId, patientId, 'en');
    await service.completeTriage(pool, urgent.episodeId, patientId, {
      body_location: 'chest',
      symptom: 'chest_pain',
      intensity: 'MILD',
    });
    const symptoms = await pool.query(
      'SELECT symptom_name, severity FROM symptom_logs WHERE user_id = $1 AND occurred_date = $2',
      [patientId, '2098-02-03']
    );
    expect(symptoms.rows).toContainEqual({ symptom_name: 'Đau ngực', severity: 'high' });
    const snapshot = await jest
      .requireActual('../src/services/early-signal/early-signal.service')
      ._test.inputSnapshot(pool, patientId);
    expect(snapshot.symptoms.some((row) => row.symptom_name === 'Đau ngực')).toBe(true);
    expect(
      snapshot.checkin_schedule.find((row) => row.triage_context?.symptom === 'chest_pain')
        ?.triage_context
    ).toMatchObject({ symptom: 'chest_pain', intensity: 'URGENT' });
    expect((await service.getEpisode(pool, urgent.episodeId, patientId)).severity).toBe('URGENT');
    await service.confirmFamily(pool, urgent.episodeId, familyIds[0], 'ACCEPT_AND_CHECK');
  });

  test('urgent self-report and manual check-in cannot erase an existing early signal', async () => {
    const { episodeId } = await startEpisode('2098-02-04');
    await pool.query(
      "UPDATE checkin_call_episodes SET severity = 'URGENT', trigger_source = 'EARLY_SIGNAL', issue_category = 'URGENT_RED_FLAG' WHERE id = $1",
      [episodeId]
    );
    expect(await service.cancelActiveForManualCheckin(pool, patientId)).toBe(0);
    const result = await service.answer(pool, episodeId, patientId, 1);
    expect(result).toMatchObject({ severity: 'URGENT', state: 'URGENT_BROADCAST' });
    await pool.query(
      "UPDATE checkin_call_episodes SET state = 'URGENT_ACKNOWLEDGED', acknowledged_by = $2, next_action_at = NULL WHERE id = $1",
      [episodeId, familyIds[0]]
    );
    const family = await service.getActive(pool, familyIds[0]);
    // Old releases cancelled everyone else's attempts at pickup.
    await pool.query(
      "UPDATE checkin_call_attempts SET state = CASE WHEN target_user_id = $2 THEN 'CONNECTED' ELSE 'CANCELLED' END, connected_at = now() - interval '3 minutes' WHERE episode_id = $1 AND target_role = 'FAMILY'",
      [episodeId, familyIds[0]]
    );
    await service.advance(pool, episodeId);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    expect(await service.getActive(pool, familyIds[1])).not.toBeNull();
    await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
  });

  test('declining a call moves to the next relative without resolving the episode', async () => {
    const { episodeId, active } = await startEpisode('2098-02-05');
    await service.decline(pool, active.attempt_id, patientId);
    await forceEpisodeDue(episodeId);
    const first = (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).find(
      Boolean
    );
    const actor = (
      await pool.query('SELECT target_user_id FROM checkin_call_attempts WHERE id = $1', [
        first.attempt_id,
      ])
    ).rows[0].target_user_id;
    await expect(service.decline(pool, first.attempt_id, patientId)).rejects.toThrow(
      'Attempt not found'
    );
    await service.decline(pool, first.attempt_id, actor);
    await forceEpisodeDue(episodeId);
    const second = (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).find(
      Boolean
    );
    expect(second.attempt_id).not.toBe(first.attempt_id);
    const secondActor = (
      await pool.query('SELECT target_user_id FROM checkin_call_attempts WHERE id = $1', [
        second.attempt_id,
      ])
    ).rows[0].target_user_id;
    await service.confirmFamily(pool, episodeId, secondActor, 'ACCEPT_AND_CHECK');
  });

  test('recording a call response cannot downgrade existing emergency health history', async () => {
    const { episodeId } = await startEpisode('2098-02-06');
    await pool.query(
      `INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state, triage_severity, emergency_triggered)
       VALUES ($1,$2,'very_tired','very_tired','high_alert','emergency',true)`,
      [patientId, '2098-02-06']
    );
    await pool.query("UPDATE checkin_call_episodes SET severity = 'URGENT' WHERE id = $1", [
      episodeId,
    ]);
    await service.answer(pool, episodeId, patientId, 1);
    const history = await pool.query(
      'SELECT current_status, flow_state, triage_severity, emergency_triggered FROM health_checkins WHERE user_id = $1 AND session_date = $2',
      [patientId, '2098-02-06']
    );
    expect(history.rows[0]).toMatchObject({
      current_status: 'very_tired',
      flow_state: 'high_alert',
      triage_severity: 'emergency',
      emergency_triggered: true,
    });
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    await service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK');
  });

  test('no user or family confirmation exhausts safely after all five relatives', async () => {
    const { episodeId } = await startEpisode('2098-01-03');
    await forceEpisodeDue(episodeId);
    expect(await service.getEpisode(pool, episodeId, patientId)).toMatchObject({
      severity: 'UNKNOWN',
      issue_category: 'UNKNOWN',
    });

    const contacted = new Set();
    for (let index = 0; index < familyIds.length; index += 1) {
      const activeCalls = (
        await Promise.all(
          familyIds.map(async (familyId) => ({
            familyId,
            call: await service.getActive(pool, familyId),
          }))
        )
      ).filter((item) => item.call);
      expect(activeCalls).toHaveLength(1);
      const [{ familyId, call: familyCall }] = activeCalls;
      expect(familyCall).toMatchObject({ id: episodeId, target_role: 'FAMILY' });
      expect(contacted.has(familyId)).toBe(false);
      contacted.add(familyId);
      await forceEpisodeDue(episodeId);
      expect((await service.getAttempt(pool, familyCall.attempt_id, familyId)).state).toBe(
        'PUSH_WAIT'
      );
      await forceEpisodeDue(episodeId);
    }

    expect(contacted.size).toBe(5);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('EXHAUSTED');
    expect(
      (await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).filter(Boolean)
    ).toHaveLength(0);
  });

  test.each(['CONTACT_USER', 'TRIAGE_USER'])(
    'an unanswered urgent early signal in %s still calls every family member',
    async (state) => {
      const localDate = state === 'CONTACT_USER' ? '2098-01-06' : '2098-01-07';
      const { episodeId, active } = await startEpisode(localDate);
      await pool.query(
        `UPDATE checkin_call_episodes
          SET state = $2, severity = 'URGENT', trigger_source = 'EARLY_SIGNAL',
              config = config || '{"early_signal":true}'::jsonb
        WHERE id = $1`,
        [episodeId, state]
      );
      await forceEpisodeDue(episodeId);
      expect(await service.getEpisode(pool, episodeId, patientId)).toMatchObject({
        state: 'URGENT_BROADCAST',
        severity: 'URGENT',
        issue_category: 'URGENT_RED_FLAG',
      });
      expect((await service.getAttempt(pool, active.attempt_id, patientId)).state).toBe(
        'NO_ANSWER'
      );
      const familyCalls = await Promise.all(familyIds.map((id) => service.getActive(pool, id)));
      expect(familyCalls.filter(Boolean)).toHaveLength(5);
      familyCalls.forEach((call) =>
        expect(call).toMatchObject({
          id: episodeId,
          target_role: 'FAMILY',
          severity: 'URGENT',
        })
      );
      await service.accept(pool, familyCalls[0].attempt_id, familyIds[0]);
      expect(
        (await service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK')).state
      ).toBe('RESOLVED');
    }
  );

  test('user OK resolves without creating any family call', async () => {
    const { episodeId, active } = await startEpisode('2098-01-04');
    await service.accept(pool, active.attempt_id, patientId);
    const resolved = await service.answer(pool, episodeId, patientId, 1);
    expect(resolved).toMatchObject({ state: 'RESOLVED', severity: 'NONE' });
    const attempts = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM checkin_call_attempts WHERE episode_id = $1 AND target_role = 'FAMILY'",
      [episodeId]
    );
    expect(attempts.rows[0].count).toBe(0);
  });

  test('concurrent family confirmations have exactly one winner and one audit event', async () => {
    const { episodeId } = await startEpisode('2098-03-01');
    await service.answer(pool, episodeId, patientId, 3);
    const replies = await Promise.allSettled([
      service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK'),
      service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK'),
    ]);
    expect(replies.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter((result) => result.status === 'rejected')[0].reason.statusCode).toBe(409);
    const resolved = await service.getEpisode(pool, episodeId, patientId);
    expect(resolved).toMatchObject({ state: 'RESOLVED' });
    const winner = replies.find((result) => result.status === 'fulfilled').value.acknowledged_by;
    expect(resolved.acknowledged_by).toBe(winner);
    const audit = await pool.query(
      "SELECT count(*)::integer AS n FROM checkin_call_events WHERE episode_id = $1 AND event = 'FAMILY_CONFIRMED'",
      [episodeId]
    );
    expect(audit.rows[0].n).toBe(1);
    expect(
      (await service.confirmFamily(pool, episodeId, winner, 'ACCEPT_AND_CHECK')).acknowledged_by
    ).toBe(winner);
  });

  test('duplicate pickup does not extend the urgent confirmation deadline', async () => {
    const { episodeId } = await startEpisode('2098-03-02');
    await service.answer(pool, episodeId, patientId, 3);
    const call = await service.getActive(pool, familyIds[0]);
    const first = await service.accept(pool, call.attempt_id, familyIds[0]);
    const second = await service.accept(pool, call.attempt_id, familyIds[0]);
    expect(second.alreadyAccepted).toBe(true);
    expect(second.confirm_deadline).toEqual(first.confirm_deadline);
    const audit = await pool.query(
      "SELECT count(*)::integer AS n FROM checkin_call_events WHERE attempt_id = $1 AND event = 'CALL_ACCEPTED'",
      [call.attempt_id]
    );
    expect(audit.rows[0].n).toBe(1);
    await service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK');
  });

  test('expired confirmation is rejected and another eligible relative can still confirm', async () => {
    const { episodeId } = await startEpisode('2098-03-03');
    await service.answer(pool, episodeId, patientId, 3);
    const call = await service.getActive(pool, familyIds[0]);
    await service.accept(pool, call.attempt_id, familyIds[0]);
    await pool.query(
      "UPDATE checkin_call_attempts SET confirm_deadline = now() - interval '1 second' WHERE id = $1",
      [call.attempt_id]
    );
    await expect(
      service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK')
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
  });

  test('duplicate user response records health history exactly once', async () => {
    const { episodeId } = await startEpisode('2098-03-04');
    const replies = await Promise.all([
      service.answer(pool, episodeId, patientId, 1),
      service.answer(pool, episodeId, patientId, 1),
    ]);
    replies.forEach((reply) => expect(reply.state).toBe('RESOLVED'));
    const records = await pool.query(
      'SELECT count(*)::integer AS n FROM health_checkins WHERE user_id = $1 AND session_date = $2',
      [patientId, '2098-03-04']
    );
    expect(records.rows[0].n).toBe(1);
    const audit = await pool.query(
      "SELECT count(*)::integer AS n FROM checkin_call_events WHERE episode_id = $1 AND event = 'USER_OK'",
      [episodeId]
    );
    expect(audit.rows[0].n).toBe(1);
  });

  test('revoked family confirmation permission is rechecked after pickup', async () => {
    const { episodeId } = await startEpisode('2098-03-05');
    await service.answer(pool, episodeId, patientId, 3);
    const call = await service.getActive(pool, familyIds[0]);
    await service.accept(pool, call.attempt_id, familyIds[0]);
    await pool.query(
      "UPDATE user_connections SET permissions = jsonb_set(permissions,'{can_ack_escalation}','false'::jsonb) WHERE requester_id = $1 AND addressee_id = $2",
      [patientId, familyIds[0]]
    );
    try {
      await expect(
        service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK')
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('URGENT_BROADCAST');
    } finally {
      await pool.query(
        "UPDATE user_connections SET permissions = jsonb_set(permissions,'{can_ack_escalation}','true'::jsonb) WHERE requester_id = $1 AND addressee_id = $2",
        [patientId, familyIds[0]]
      );
    }
    await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
  });

  test('real HTTP auth and controllers drive a complete user check-in without leaking config', async () => {
    const { episodeId, active } = await startEpisode('2098-03-06');
    const base = '/api/mobile/checkin-call';
    await request(app)
      .get(base + '/active')
      .expect(401);
    await request(app)
      .get(base + '/attempts/' + active.attempt_id)
      .set('Authorization', token(familyIds[0]))
      .expect(404);
    await request(app)
      .post(base + '/episodes/' + episodeId + '/answer')
      .set('Authorization', token(familyIds[0]))
      .send({ choice: 1 })
      .expect(403);
    await request(app)
      .post(base + '/episodes/' + episodeId + '/answer')
      .set('Authorization', token(patientId))
      .send({ choice: '1' })
      .expect(400);
    const pickedUp = await request(app)
      .post(base + '/attempts/' + active.attempt_id + '/accept')
      .set('Authorization', token(patientId))
      .expect(200);
    expect(pickedUp.body.confirm_deadline).toBeTruthy();
    const triage = await request(app)
      .post(base + '/episodes/' + episodeId + '/triage/start')
      .set('Authorization', token(patientId))
      .set('Accept-Language', 'en')
      .expect(200);
    expect(triage.body.triage.locations.some((location) => location.label === 'Head')).toBe(true);
    await request(app)
      .post(base + '/episodes/' + episodeId + '/triage/complete')
      .set('Authorization', token(patientId))
      .send({ body_location: 'chest', symptom: 'dizziness', intensity: 'MILD' })
      .expect(400);
    const result = await request(app)
      .post(base + '/episodes/' + episodeId + '/answer')
      .set('Authorization', token(patientId))
      .send({ choice: 1 })
      .expect(200);
    expect(result.body.episode).toMatchObject({ state: 'RESOLVED', severity: 'NONE' });
    expect(result.body.episode).not.toHaveProperty('config');
    expect(result.body.episode).not.toHaveProperty('family_ids');
    await request(app)
      .get(base + '/episodes/' + episodeId)
      .set('Authorization', token(patientId))
      .expect(200);
    await request(app)
      .put(base + '/settings')
      .set('Authorization', token(familyIds[4]))
      .send({ enabled: true })
      .expect(403);
  });

  test('queued call deliveries are cancelled after resolution and never reach a provider', async () => {
    const {
      sendPushNotification,
    } = require('../src/services/notification/push.notification.service');
    const {
      sendFcmNotification,
    } = require('../src/services/notification/fcm.notification.service');
    const { sendVoipNotification } = require('../src/services/notification/apns.voip.service');
    const { episodeId } = await startEpisode('2098-03-07');
    await service.answer(pool, episodeId, patientId, 3);
    await service.confirmFamily(pool, episodeId, familyIds[0], 'ACCEPT_AND_CHECK');
    jest.clearAllMocks();
    await service.dispatchDeliveries(pool);
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendFcmNotification).not.toHaveBeenCalled();
    expect(sendVoipNotification).not.toHaveBeenCalled();
    const rows = await pool.query(
      "SELECT count(*)::integer AS n FROM checkin_call_deliveries WHERE episode_id = $1 AND state IN ('PENDING','SENDING')",
      [episodeId]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  test('manual check-in cancellation closes the active automated call', async () => {
    const { episodeId, active } = await startEpisode('2098-01-05');
    await service.accept(pool, active.attempt_id, patientId);
    expect(await service.cancelActiveForManualCheckin(pool, patientId)).toBe(1);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('CANCELLED');
    expect(await service.getActive(pool, patientId)).toBeNull();
  });

  test('a scheduled call is cancelled if the plan expires before it starts', async () => {
    const entitlement = await entitlementService.getEntitlement(pool, patientId);
    const household = await pool.query(
      'SELECT current_period_end FROM subscription_households WHERE id = $1',
      [entitlement.householdId]
    );
    const settings = await service.settings(pool, patientId);
    const inserted = await pool.query(
      `INSERT INTO checkin_call_episodes (
         user_id, local_date, state, severity, scheduled_at, grace_until, next_action_at, config
       ) VALUES ($1, DATE '2098-01-08', 'SCHEDULED', 'NONE', now(), now(), now() - interval '1 second', $2::jsonb)
       RETURNING id`,
      [patientId, JSON.stringify(settings)]
    );
    const episodeId = inserted.rows[0].id;
    try {
      await pool.query(
        "UPDATE subscription_households SET current_period_end = now() - interval '1 second' WHERE id = $1",
        [entitlement.householdId]
      );
      await service.advance(pool, episodeId);
      expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('CANCELLED');
      const attempts = await pool.query(
        'SELECT COUNT(*)::integer AS count FROM checkin_call_attempts WHERE episode_id = $1',
        [episodeId]
      );
      expect(attempts.rows[0].count).toBe(0);
      const events = await pool.query(
        "SELECT detail FROM checkin_call_events WHERE episode_id = $1 AND event = 'CANCELLED'",
        [episodeId]
      );
      expect(events.rows[0].detail.reason).toBe('ENTITLEMENT_REVOKED');
    } finally {
      await pool.query('UPDATE subscription_households SET current_period_end = $2 WHERE id = $1', [
        entitlement.householdId,
        household.rows[0].current_period_end,
      ]);
    }
  });
});
