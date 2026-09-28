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

  test('quick triage rejects a severity/category mismatch', async () => {
    await expect(
      service.answer({}, 'episode-invalid-triage', 7, 2, 'URGENT_RED_FLAG')
    ).rejects.toThrow('Invalid issue category');
    await expect(
      service.answer({}, 'episode-invalid-triage', 7, 3, 'MILD_FATIGUE')
    ).rejects.toThrow('Invalid issue category');
  });

  test('starting contextual triage prioritizes recent check-in locations', async () => {
    const episode = {
      id: 'episode-triage-start',
      user_id: 7,
      state: 'CONTACT_USER',
      config: { user_timeout_seconds: 60 },
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes("SET state = 'TRIAGE_USER'")) {
          return { rows: [{ ...episode, state: 'TRIAGE_USER' }] };
        }
        if (sql.includes('FROM health_checkins h')) {
          return { rows: [{ location: 'head', recent_count: 2, last_reported: '2026-09-27' }] };
        }
        if (sql.includes('FROM symptom_frequency')) {
          return { rows: [{ symptom_name: 'Chóng mặt', count_30d: 3, last_occurred: '2026-09-27' }] };
        }
        if (sql.includes('FROM user_onboarding_profiles')) {
          return { rows: [{ chronic_symptoms: ['Đau đầu'] }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const result = await service.startTriage({ connect: async () => db }, episode.id, 7, 'vi');

    expect(result.episode.state).toBe('TRIAGE_USER');
    expect(result.triage.locations[0].key).toBe('head');
    expect(result.triage.locations[0].recent).toBe(true);
    expect(result.triage.locations[0].symptoms[0].recent).toBe(true);
  });

  test('completed non-urgent contextual triage always starts family escalation', async () => {
    const episode = {
      id: 'episode-contextual-mild',
      user_id: 7,
      state: 'TRIAGE_USER',
      severity: 'NONE',
      config: {
        family_ring_seconds: 60,
        max_rounds: 1,
        test_mode: true,
        single_device_family_test: true,
      },
      family_ids: [7],
      family_index: 0,
      round_number: 1,
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('INSERT INTO checkin_call_attempts')) {
          return { rows: [{ id: 'family-attempt', ring_deadline: new Date() }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await service.completeTriage({ connect: async () => db }, episode.id, 7, {
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MODERATE',
    });

    const triageUpdate = db.query.mock.calls.find(([sql]) => sql.includes('triage_context = $4'));
    expect(triageUpdate[1][1]).toBe('MILD');
    expect(JSON.parse(triageUpdate[1][3])).toEqual({
      body_location: 'head',
      symptom: 'dizziness',
      intensity: 'MODERATE',
    });
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes("state = 'MILD_FAMILY_ESCALATION'"))
    ).toBe(true);
  });

  test('a hard-rule red flag becomes URGENT even if the submitted intensity is mild', async () => {
    const episode = {
      id: 'episode-contextual-red-flag',
      user_id: 7,
      state: 'TRIAGE_USER',
      severity: 'NONE',
      config: { family_ring_seconds: 60, test_mode: true, single_device_family_test: true },
      family_ids: [7],
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('INSERT INTO checkin_call_attempts')) {
          return { rows: [{ id: 'urgent-attempt', ring_deadline: new Date() }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await service.completeTriage({ connect: async () => db }, episode.id, 7, {
      body_location: 'chest',
      symptom: 'shortness_of_breath',
      intensity: 'MILD',
    });

    const triageUpdate = db.query.mock.calls.find(([sql]) => sql.includes('triage_context = $4'));
    expect(triageUpdate[1][1]).toBe('URGENT');
    expect(JSON.parse(triageUpdate[1][3]).intensity).toBe('URGENT');
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes("state = 'URGENT_BROADCAST'"))
    ).toBe(true);
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

  test('single-device test mode calls the same account back as FAMILY after MILD', async () => {
    const episode = {
      id: 'episode-single-device',
      user_id: 7,
      state: 'CONTACT_USER',
      severity: 'NONE',
      config: {
        family_ring_seconds: 60,
        max_rounds: 1,
        test_mode: true,
        single_device_family_test: true,
      },
      family_ids: [7],
      family_index: 0,
      round_number: 1,
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('INSERT INTO checkin_call_attempts')) {
          return { rows: [{ id: 'family-attempt', ring_deadline: new Date() }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await service.answer({ connect: async () => db }, episode.id, 7, 2, 'MILD_FATIGUE');

    const attemptInsert = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO checkin_call_attempts')
    );
    expect(attemptInsert[1]).toEqual([episode.id, 7, 'FAMILY', 1, 60]);
  });

  test('single-device test actor can confirm its synthetic FAMILY attempt', async () => {
    const episode = {
      id: 'episode-single-device-confirm',
      user_id: 7,
      state: 'MILD_FAMILY_ESCALATION',
      severity: 'MILD',
      family_ids: [7],
      config: { test_mode: true, single_device_family_test: true },
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('SELECT 1 FROM checkin_call_attempts')) return { rows: [{ '?column?': 1 }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(async () => db),
      query: jest.fn(async () => ({ rows: [] })),
    };

    const result = await service.confirmFamily(pool, episode.id, 7, 'ACCEPT_AND_CHECK');

    expect(result.state).toBe('RESOLVED');
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes('FROM user_connections'))
    ).toBe(false);
  });

  test('single-device test mode creates one URGENT FAMILY call for the same account', async () => {
    const episode = {
      id: 'episode-single-device-urgent',
      user_id: 7,
      state: 'CONTACT_USER',
      severity: 'NONE',
      config: {
        family_ring_seconds: 60,
        test_mode: true,
        single_device_family_test: true,
      },
      family_ids: [7],
    };
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM checkin_call_episodes')) return { rows: [episode] };
        if (sql.includes('INSERT INTO checkin_call_attempts')) {
          return { rows: [{ id: 'urgent-family-attempt', ring_deadline: new Date() }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await service.answer({ connect: async () => db }, episode.id, 7, 3);

    const attempts = db.query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO checkin_call_attempts')
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0][1]).toEqual([episode.id, 7, 'FAMILY', 1, 60]);
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
    await service.answer({ connect: async () => db }, episode.id, 7, 2, 'MILD_FATIGUE');
    expect(queries.filter((sql) => sql.includes('INSERT INTO checkin_call_attempts'))).toHaveLength(
      1
    );
    expect(queries.some((sql) => sql.includes("state = 'MILD_FAMILY_ESCALATION'"))).toBe(true);
    const issueUpdate = db.query.mock.calls.find(([sql]) =>
      sql.includes("severity = 'MILD'")
    );
    expect(issueUpdate[1]).toEqual([episode.id, 'MILD_FATIGUE']);
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
    await service.answer({ connect: async () => db }, episode.id, 7, 3, 'URGENT_RED_FLAG');
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
