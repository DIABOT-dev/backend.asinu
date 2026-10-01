const { Pool } = require('pg');
const service = require('../src/services/checkin-call/checkin-call.service');
const entitlementService = require('../src/services/payment/entitlement.service');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('check-in call six-account full flow', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const createdUserIds = [];
  const prefix = `ux-call-${Date.now()}-`;
  let patientId;
  let familyIds;
  let baseline;

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
    if (createdUserIds.length) {
      await pool.query(
        'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
        [createdUserIds]
      );
      await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [createdUserIds]);
    }
    const residue = await pool.query('SELECT COUNT(*)::integer AS count FROM users WHERE phone_number LIKE $1', [
      `${prefix}%`,
    ]);
    expect(residue.rows[0].count).toBe(0);
    const finalResult = await Promise.all([
      pool.query('SELECT COUNT(*)::integer AS count FROM users'),
      pool.query('SELECT COUNT(*)::integer AS count FROM checkin_call_episodes'),
    ]);
    expect(finalResult[0].rows[0].count).toBe(baseline.users);
    expect(finalResult[1].rows[0].count).toBe(baseline.episodes);
    await pool.end();
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
    expect((await Promise.all(familyIds.slice(1).map((id) => service.getActive(pool, id)))).filter(Boolean)).toHaveLength(0);

    await service.seen(pool, firstFamily.attempt_id, familyIds[0]);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('MILD_FAMILY_ESCALATION');

    await forceEpisodeDue(episodeId);
    expect((await service.getAttempt(pool, firstFamily.attempt_id, familyIds[0])).state).toBe('PUSH_WAIT');
    await forceEpisodeDue(episodeId);

    const secondFamily = await service.getActive(pool, familyIds[1]);
    expect(secondFamily).toMatchObject({ id: episodeId, target_role: 'FAMILY' });
    await service.accept(pool, secondFamily.attempt_id, familyIds[1]);
    const resolved = await service.confirmFamily(pool, episodeId, familyIds[1], 'ACCEPT_AND_CHECK');
    expect(resolved).toMatchObject({ state: 'RESOLVED', acknowledged_by: familyIds[1] });
    expect((await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).filter(Boolean)).toHaveLength(0);
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
    activeCalls.forEach((call) => expect(call).toMatchObject({ id: episodeId, target_role: 'FAMILY' }));

    const acceptedBy = familyIds[3];
    const acceptedAttempt = activeCalls[3].attempt_id;
    expect((await service.accept(pool, acceptedAttempt, acceptedBy)).state).toBe('URGENT_ACKNOWLEDGED');
    const remaining = await Promise.all(
      familyIds.map(async (id) => ({ id, active: await service.getActive(pool, id) }))
    );
    expect(remaining.filter((item) => item.id !== acceptedBy && item.active)).toHaveLength(0);
    expect(remaining.find((item) => item.id === acceptedBy).active.attempt_id).toBe(acceptedAttempt);

    const resolved = await service.confirmFamily(pool, episodeId, acceptedBy, 'ON_MY_WAY');
    expect(resolved).toMatchObject({ state: 'RESOLVED', acknowledged_by: acceptedBy });
  });

  test('no user or family confirmation exhausts safely after all five relatives', async () => {
    const { episodeId } = await startEpisode('2098-01-03');
    await forceEpisodeDue(episodeId);
    expect((await service.getEpisode(pool, episodeId, patientId))).toMatchObject({
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
      expect((await service.getAttempt(pool, familyCall.attempt_id, familyId)).state).toBe('PUSH_WAIT');
      await forceEpisodeDue(episodeId);
    }

    expect(contacted.size).toBe(5);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('EXHAUSTED');
    expect((await Promise.all(familyIds.map((id) => service.getActive(pool, id)))).filter(Boolean)).toHaveLength(0);
  });

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

  test('manual check-in cancellation closes the active automated call', async () => {
    const { episodeId, active } = await startEpisode('2098-01-05');
    await service.accept(pool, active.attempt_id, patientId);
    expect(await service.cancelActiveForManualCheckin(pool, patientId)).toBe(1);
    expect((await service.getEpisode(pool, episodeId, patientId)).state).toBe('CANCELLED');
    expect(await service.getActive(pool, patientId)).toBeNull();
  });
});
