const { buildCaregiverStatus, userHasActiveCaregiver } = require('../../src/services/care-circle/caregiver-status.service');

function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('userHasActiveCaregiver', () => {
  test('true when at least one accepted alert-receiving connection exists', async () => {
    const pool = mockPool([{ '?column?': 1 }]);
    expect(await userHasActiveCaregiver(pool, 42)).toBe(true);
  });

  test('false when no rows', async () => {
    const pool = mockPool([]);
    expect(await userHasActiveCaregiver(pool, 42)).toBe(false);
  });

  test('fail-open (returns true) when DB throws', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    expect(await userHasActiveCaregiver(pool, 42)).toBe(true);
  });
});

describe('buildCaregiverStatus', () => {
  test('connected user, no urgent warning', async () => {
    const pool = mockPool([{ '?column?': 1 }]);
    const r = await buildCaregiverStatus(pool, 1, { riskTier: 'low' });
    expect(r.caregiver_status).toBe('connected');
    expect(r.needs_caregiver_cta).toBe(false);
    expect(r.show_urgent_caregiver_warning).toBe(false);
  });

  test('no caregiver + low risk -> CTA but no urgent warning', async () => {
    const pool = mockPool([]);
    const r = await buildCaregiverStatus(pool, 1, { riskTier: 'low' });
    expect(r.caregiver_status).toBe('no_caregiver_connected');
    expect(r.needs_caregiver_cta).toBe(true);
    expect(r.show_urgent_caregiver_warning).toBe(false);
  });

  test('no caregiver + high risk -> urgent warning', async () => {
    const pool = mockPool([]);
    const r = await buildCaregiverStatus(pool, 1, { riskTier: 'high' });
    expect(r.show_urgent_caregiver_warning).toBe(true);
  });

  test('no caregiver + emergency -> urgent warning', async () => {
    const pool = mockPool([]);
    const r = await buildCaregiverStatus(pool, 1, { riskTier: 'EMERGENCY' });
    expect(r.show_urgent_caregiver_warning).toBe(true);
  });
});
