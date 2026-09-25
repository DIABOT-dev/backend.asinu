const service = require('../src/services/checkin-call/checkin-call.service');

describe('check-in call safety rules', () => {
  test('settings enforce the grace and timeout safety bounds', () => {
    expect(service.validateSettings({}).checkin_time).toBe('08:00');
    expect(service.validateSettings({}).grace_hours).toBe(6);
    expect(service.validateSettings({ grace_hours: 2 }).grace_hours).toBe(2);
    expect(service.validateSettings({ grace_hours: 12 }).grace_hours).toBe(12);
    expect(() => service.validateSettings({ grace_hours: 1 })).toThrow('grace_hours');
    expect(() => service.validateSettings({ grace_hours: 13 })).toThrow('grace_hours');
    expect(() => service.validateSettings({ family_confirm_minutes: 31 })).toThrow(
      'family_confirm_minutes'
    );
    expect(() => service.validateSettings({ checkin_time: '25:00' })).toThrow('checkin_time');
  });

  test('seen only writes an audit event, never resolves an episode', async () => {
    const queries = [];
    const pool = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT a.episode_id')) return { rows: [{ episode_id: 'episode-1' }] };
        return { rows: [] };
      }),
    };
    await service.seen(pool, 'attempt-1', 7);
    expect(queries.some((sql) => sql.includes('INSERT INTO checkin_call_events'))).toBe(true);
    expect(queries.some((sql) => sql.includes('UPDATE checkin_call_episodes'))).toBe(false);
  });

  test('user OK writes a health check-in and never starts family escalation', async () => {
    const queries = [];
    const episode = {
      id: 'episode-1',
      user_id: 7,
      local_date: '2026-09-22',
      state: 'CONTACT_USER',
      config: { user_timeout_seconds: 60 },
      family_ids: [],
    };
    const db = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => db) };
    await service.answer(pool, episode.id, 7, 1);
    expect(queries.some((sql) => sql.includes('INSERT INTO health_checkins'))).toBe(true);
    expect(queries.some((sql) => sql.includes("state = 'RESOLVED'"))).toBe(true);
    const resolvedCall = db.query.mock.calls.find(([sql]) => sql.includes("state = 'RESOLVED'"));
    expect(resolvedCall[1]).toEqual([episode.id]);
    expect(queries.some((sql) => sql.includes('checkin_call_deliveries'))).toBe(false);
    expect(queries).toContain('COMMIT');
  });

  test('test-mode OK resolves without writing a real health check-in', async () => {
    const queries = [];
    const episode = {
      id: 'episode-test',
      user_id: 7,
      local_date: '2099-12-31',
      state: 'CONTACT_USER',
      config: { user_timeout_seconds: 60, test_mode: true },
      family_ids: [],
    };
    const db = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await service.answer({ connect: async () => db }, episode.id, 7, 1);

    expect(queries.some((sql) => sql.includes('INSERT INTO health_checkins'))).toBe(false);
    expect(queries.some((sql) => sql.includes("state = 'RESOLVED'"))).toBe(true);
  });

  test('MILD creates only the first family call', async () => {
    const queries = [];
    const episode = {
      id: 'episode-1',
      user_id: 7,
      state: 'CONTACT_USER',
      severity: 'NONE',
      config: { family_ring_seconds: 60, max_rounds: 1 },
      family_ids: [],
      family_index: 0,
      round_number: 1,
    };
    const db = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('AS family_id')) return { rows: [{ family_id: 11 }, { family_id: 12 }] };
        if (sql.includes('INSERT INTO checkin_call_attempts'))
          return { rows: [{ id: 'attempt-1', ring_deadline: new Date(), target_user_id: 11 }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await service.answer({ connect: async () => db }, episode.id, 7, 2);
    expect(queries.filter((sql) => sql.includes('INSERT INTO checkin_call_attempts'))).toHaveLength(
      1
    );
    expect(queries.some((sql) => sql.includes("state = 'MILD_FAMILY_ESCALATION'"))).toBe(true);
  });

  test('URGENT creates a call for every eligible family member', async () => {
    const queries = [];
    const episode = {
      id: 'episode-2',
      user_id: 7,
      state: 'CONTACT_USER',
      severity: 'NONE',
      config: { family_ring_seconds: 60 },
      family_ids: [],
    };
    const db = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('AS family_id')) return { rows: [{ family_id: 11 }, { family_id: 12 }] };
        if (sql.includes('INSERT INTO checkin_call_attempts'))
          return { rows: [{ id: 'attempt-' + queries.length, ring_deadline: new Date() }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await service.answer({ connect: async () => db }, episode.id, 7, 3);
    expect(queries.filter((sql) => sql.includes('INSERT INTO checkin_call_attempts'))).toHaveLength(
      2
    );
    expect(queries.some((sql) => sql.includes("state = 'URGENT_BROADCAST'"))).toBe(true);
  });

  test('a family member who has not been contacted cannot resolve MILD', async () => {
    const episode = {
      id: 'episode-3',
      user_id: 7,
      state: 'MILD_FAMILY_ESCALATION',
      family_ids: [11, 12],
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await expect(
      service.confirmFamily({ connect: async () => db }, episode.id, 12, 'ACCEPT_AND_CHECK')
    ).rejects.toThrow('No active family alert');
    expect(db.query.mock.calls.some(([sql]) => sql.includes("state = 'RESOLVED'"))).toBe(false);
  });

  test('the second family member cannot take over an acknowledged URGENT alert', async () => {
    const episode = {
      id: 'episode-4',
      user_id: 7,
      state: 'URGENT_ACKNOWLEDGED',
      acknowledged_by: 11,
      family_ids: [11, 12],
    };
    const db = {
      query: jest.fn(async (sql) =>
        sql.includes('SELECT * FROM checkin_call_episodes') ? { rows: [episode] } : { rows: [] }
      ),
      release: jest.fn(),
    };
    await expect(
      service.confirmFamily({ connect: async () => db }, episode.id, 12, 'ON_MY_WAY')
    ).rejects.toThrow('Another family member accepted');
  });
});
