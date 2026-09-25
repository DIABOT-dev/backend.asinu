const { Pool } = require('pg');
const service = require('../src/services/checkin-call/checkin-call.service');

const describeDatabase = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;

describeDatabase('check-in call PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const users = [];

  afterAll(async () => {
    if (users.length) {
      await pool.query(
        'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
        [users]
      );
      await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [users]);
    }
    await pool.end();
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
    const result = await service.answer(pool, userCall.id, users[0], 2);
    expect(result.state).toBe('MILD_FAMILY_ESCALATION');
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
    const result = await service.answer(pool, userCall.id, group[0], 3);
    expect(result.state).toBe('URGENT_BROADCAST');
    const first = await service.getActive(pool, group[1]);
    const second = await service.getActive(pool, group[2]);
    expect(first.target_role).toBe('FAMILY');
    expect(second.target_role).toBe('FAMILY');
    expect((await service.accept(pool, first.attempt_id, group[1])).state).toBe(
      'URGENT_ACKNOWLEDGED'
    );
    expect(await service.getActive(pool, group[2])).toBeNull();
    await expect(service.confirmFamily(pool, userCall.id, group[2], 'ON_MY_WAY')).rejects.toThrow(
      'Another family member accepted'
    );
    expect(
      (await service.confirmFamily(pool, userCall.id, group[1], 'ACCEPT_AND_CHECK')).state
    ).toBe('RESOLVED');
  });

  test('cannot enable check-in calls without a reachable Care Circle', async () => {
    const created = await pool.query(
      'INSERT INTO users (phone_number, push_token) VALUES ($1,$2) RETURNING id',
      ['nofamily' + Date.now(), 'ExponentPushToken[test]']
    );
    const userId = created.rows[0].id;
    users.push(userId);
    await expect(service.saveSettings(pool, userId, { enabled: true })).rejects.toThrow(
      'Care Circle'
    );
  });
});
