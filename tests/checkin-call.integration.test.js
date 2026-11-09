const { Pool } = require('pg');
jest.mock('../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(null),
}));
const service = require('../src/services/checkin-call/checkin-call.service');
const entitlementService = require('../src/services/payment/entitlement.service');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('check-in call PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const users = [];

  async function activateAnTam(userId) {
    await entitlementService.activateHouseholdPlan(pool, userId, {
      planCode: 'antam_8',
      billingPeriod: 'monthly',
      platform: 'google',
      productId: 'asinu.antam8.monthly',
      originalTransactionId: `integration-${userId}`,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  afterAll(async () => {
    try {
      if (users.length) {
        // Explicit ordering avoids caregiver acknowledged_by FK failures.
        await pool.query('DELETE FROM checkin_call_episodes WHERE user_id = ANY($1::integer[])', [
          users,
        ]);
        await pool.query(
          'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
          [users]
        );
        await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [users]);
      }
    } finally {
      await pool.end();
    }
  });

  async function earlySignalFixture(withFamily) {
    const created = [];
    for (let index = 0; index < (withFamily ? 2 : 1); index++) {
      const inserted = await pool.query(
        'INSERT INTO users(phone_number,display_name,push_token) VALUES($1,$2,$3) RETURNING id',
        [`qa-present-${require('crypto').randomUUID().slice(0, 16)}`, 'Synthetic presence test', `ExponentPushToken[qa-present-${index}]`]
      );
      created.push(inserted.rows[0].id);
      users.push(inserted.rows[0].id);
    }
    const [patientId, familyId] = created;
    await activateAnTam(patientId);
    if (familyId) await pool.query(
      "INSERT INTO user_connections(requester_id,addressee_id,status,permissions,accepted_at) VALUES($1,$2,'accepted',$3::jsonb,now())",
      [patientId, familyId, JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true })]
    );
    const assessment = await pool.query(
      `INSERT INTO early_signal_assessments(user_id,requested_by,trigger_type,window_start,window_end,input_snapshot,severity,is_red_flag,summary,disclaimer,output_snapshot,audit_hash)
       VALUES($1,$1,'worsened',CURRENT_DATE,CURRENT_DATE,'{}','urgent',true,'Synthetic test','Synthetic test','{}','synthetic-test') RETURNING id`,
      [patientId]
    );
    return { patientId, familyId, assessmentId: assessment.rows[0].id };
  }

  test('early signal during an active check-in contacts family without calling the patient', async () => {
    const f = await earlySignalFixture(true);
    const first = await service.startEarlySignalEpisode(pool, f.patientId, f.assessmentId, { patientPresent: true });
    expect(first.state).toBe('URGENT_BROADCAST');
    expect(await service.getActive(pool, f.patientId)).toBeNull();
    expect(await service.getActive(pool, f.familyId)).toMatchObject({ id: first.id, target_role: 'FAMILY' });
    const second = await service.startEarlySignalEpisode(pool, f.patientId, f.assessmentId, { patientPresent: true });
    expect(second.id).toBe(first.id);
    expect(second.urgent_until).toEqual(first.urgent_until);
    const attempts = await pool.query('SELECT target_user_id,target_role FROM checkin_call_attempts WHERE episode_id=$1', [first.id]);
    expect(attempts.rows).toEqual([{ target_user_id: f.familyId, target_role: 'FAMILY' }]);
    const deliveries = await pool.query('SELECT target_user_id FROM checkin_call_deliveries WHERE episode_id=$1', [first.id]);
    expect(deliveries.rows).toEqual([{ target_user_id: f.familyId }]);
  });

  test('early signal with a present patient and no family creates no incoming notification', async () => {
    const f = await earlySignalFixture(false);
    const episode = await service.startEarlySignalEpisode(pool, f.patientId, f.assessmentId, { patientPresent: true });
    expect(episode.state).toBe('EXHAUSTED_URGENT');
    expect((await pool.query('SELECT id FROM checkin_call_attempts WHERE episode_id=$1', [episode.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM checkin_call_deliveries WHERE episode_id=$1', [episode.id])).rowCount).toBe(0);
  });

  test('early signal background contact stops its patient call when the patient checks in', async () => {
    const f = await earlySignalFixture(true);
    const first = await service.startEarlySignalEpisode(pool, f.patientId, f.assessmentId);
    const original = await service.getActive(pool, f.patientId);
    expect(original).toMatchObject({ id: first.id, target_role: 'USER' });
    const updated = await service.startEarlySignalEpisode(pool, f.patientId, f.assessmentId, { patientPresent: true });
    expect(updated).toMatchObject({ id: first.id, state: 'URGENT_BROADCAST', severity: 'URGENT' });
    expect(await service.getActive(pool, f.patientId)).toBeNull();
    expect(await service.getActive(pool, f.familyId)).toMatchObject({ id: first.id, target_role: 'FAMILY' });
    const cancelled = await pool.query('SELECT state FROM checkin_call_attempts WHERE id=$1', [original.attempt_id]);
    expect(cancelled.rows[0].state).toBe('CANCELLED');
    const queued = await pool.query('SELECT state FROM checkin_call_deliveries WHERE attempt_id=$1', [original.attempt_id]);
    expect(queued.rows.every(row => row.state === 'CANCELLED')).toBe(true);
  });

  test('overdue → user call → MILD first family → seen → confirmation', async () => {
    const seed = String(Date.now());
    for (let i = 0; i < 3; i += 1) {
      const created = await pool.query(
        'INSERT INTO users (phone_number, display_name, push_token) VALUES ($1,$2,$3) RETURNING id',
        ['testcall' + seed + i, 'Checkin test ' + i, 'ExponentPushToken[test-' + i + ']']
      );
      users.push(created.rows[0].id);
    }
    for (const familyId of users.slice(1)) {
      await pool.query(
        "INSERT INTO user_connections (requester_id, addressee_id, status, permissions, accepted_at) VALUES ($1,$2,'accepted',$3::jsonb,now())",
        [users[0], familyId, JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true })]
      );
    }
    await activateAnTam(users[0]);
    await service.saveSettings(pool, users[0], {
      enabled: true,
      checkin_time: '00:00',
      grace_hours: 2,
    });
    expect(await service.createDailyEpisodes(pool)).toBeGreaterThanOrEqual(1);
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE user_id = $1",
      [users[0]]
    );
    await service.tick(pool);
    const userCall = await service.getActive(pool, users[0]);
    expect(userCall.target_role).toBe('USER');
    const triage = await service.startTriage(pool, userCall.id, users[0], 'vi');
    expect(triage.episode.state).toBe('TRIAGE_USER');
    expect(triage.triage.locations.length).toBeGreaterThan(0);
    const result = await service.completeTriage(pool, userCall.id, users[0], {
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MILD',
    });
    expect(result.state).toBe('MILD_FAMILY_ESCALATION');
    expect(result.triage_context).toEqual({
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MILD',
    });
    const familyCalls = await Promise.all(users.slice(1).map((id) => service.getActive(pool, id)));
    expect(familyCalls.filter(Boolean)).toHaveLength(1);
    const contactedIndex = familyCalls.findIndex(Boolean) + 1;
    const familyOne = familyCalls[contactedIndex - 1];
    expect(familyOne.target_role).toBe('FAMILY');
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE id = $1",
      [userCall.id]
    );
    await service.tick(pool);
    const fallback = await pool.query(
      "SELECT a.state, COUNT(d.id)::integer AS fallback_count FROM checkin_call_attempts a LEFT JOIN checkin_call_deliveries d ON d.attempt_id = a.id AND d.kind = 'FALLBACK' WHERE a.id = $1 GROUP BY a.state",
      [familyOne.attempt_id]
    );
    expect(fallback.rows[0]).toMatchObject({ state: 'PUSH_WAIT', fallback_count: 1 });
    await service.seen(pool, familyOne.attempt_id, users[contactedIndex]);
    expect((await service.getEpisode(pool, userCall.id, users[0])).state).toBe(
      'MILD_FAMILY_ESCALATION'
    );
    const confirmed = await service.confirmFamily(
      pool,
      userCall.id,
      users[contactedIndex],
      'ACCEPT_AND_CHECK'
    );
    expect(confirmed.state).toBe('RESOLVED');
    expect(await service.getActive(pool, users[contactedIndex])).toBeNull();
  });

  test('URGENT calls all family and first pickup cancels the others', async () => {
    const seed = String(Date.now());
    const group = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await pool.query(
        'INSERT INTO users (phone_number, display_name, push_token) VALUES ($1,$2,$3) RETURNING id',
        ['urgent' + seed + i, 'Urgent test ' + i, 'ExponentPushToken[urgent-' + i + ']']
      );
      group.push(created.rows[0].id);
      users.push(created.rows[0].id);
    }
    for (const familyId of group.slice(1)) {
      await pool.query(
        "INSERT INTO user_connections (requester_id, addressee_id, status, permissions, accepted_at) VALUES ($1,$2,'accepted',$3::jsonb,now())",
        [group[0], familyId, JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true })]
      );
    }
    await activateAnTam(group[0]);
    await service.saveSettings(pool, group[0], {
      enabled: true,
      checkin_time: '00:00',
      grace_hours: 2,
    });
    await service.createDailyEpisodes(pool);
    await pool.query(
      "UPDATE checkin_call_episodes SET next_action_at = now() - interval '1 second' WHERE user_id = $1",
      [group[0]]
    );
    await service.tick(pool);
    const userCall = await service.getActive(pool, group[0]);
    await service.startTriage(pool, userCall.id, group[0], 'vi');
    const result = await service.completeTriage(pool, userCall.id, group[0], {
      body_location: 'chest',
      symptom: 'shortness_of_breath',
      intensity: 'URGENT',
    });
    expect(result.state).toBe('URGENT_BROADCAST');
    const first = await service.getActive(pool, group[1]);
    const second = await service.getActive(pool, group[2]);
    expect(first.target_role).toBe('FAMILY');
    expect(second.target_role).toBe('FAMILY');
    expect((await service.accept(pool, first.attempt_id, group[1])).state).toBe('URGENT_BROADCAST');
    expect(await service.getActive(pool, group[2])).not.toBeNull();
    expect(
      (await service.confirmFamily(pool, userCall.id, group[1], 'ACCEPT_AND_CHECK')).state
    ).toBe('RESOLVED');
    expect(await service.getActive(pool, group[2])).toBeNull();
    await expect(
      service.confirmFamily(pool, userCall.id, group[2], 'ACCEPT_AND_CHECK')
    ).rejects.toThrow('Episode closed');
  });

  test('requires An Tam but allows personal reminder settings without a Care Circle', async () => {
    const created = await pool.query(
      'INSERT INTO users (phone_number, push_token) VALUES ($1,$2) RETURNING id',
      ['nofamily' + Date.now(), 'ExponentPushToken[test]']
    );
    const userId = created.rows[0].id;
    users.push(userId);
    await expect(service.saveSettings(pool, userId, { enabled: false })).rejects.toThrow('An Tam');
    await expect(service.saveSettings(pool, userId, { enabled: true })).rejects.toThrow('An Tam');
    await activateAnTam(userId);
    await expect(service.saveSettings(pool, userId, { enabled: true })).resolves.toMatchObject({
      user_id: userId, enabled: true,
    });
    await expect(service.eligibleContacts(pool, userId)).resolves.toEqual([]);
    await expect(service.settings(pool, userId)).resolves.toMatchObject({ enabled: true });
  });
});
