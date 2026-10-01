process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';

const {
  getMonthlyRegenCount,
  recordRegeneration,
  getScriptRegenStatus,
} = require('../../src/services/checkin/script-quota.service');

function poolReturning(rows) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('getMonthlyRegenCount', () => {
  test('returns count from DB', async () => {
    expect(await getMonthlyRegenCount(poolReturning([{ n: 3 }]), 1)).toBe(3);
  });

  test('fails open when the DB is unavailable', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await getMonthlyRegenCount(pool, 1)).toBe(0);
  });
});

describe('getScriptRegenStatus', () => {
  test('uses one operational limit for every account', async () => {
    expect(await getScriptRegenStatus(poolReturning([{ n: 5 }]), 1))
      .toEqual({ used: 5, limit: 10, allowed: true });
  });

  test('blocks only when the shared operational limit is reached', async () => {
    expect(await getScriptRegenStatus(poolReturning([{ n: 10 }]), 1))
      .toEqual({ used: 10, limit: 10, allowed: false });
  });
});

describe('recordRegeneration', () => {
  test('records capacity usage', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    await recordRegeneration(pool, 1, 'headache', 'new_symptom');
    expect(pool.query.mock.calls[0][1])
      .toEqual([1, 'headache', 'new_symptom', expect.any(String)]);
  });

  test('does not block check-in on a ledger error', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('down')) };
    await expect(recordRegeneration(pool, 1, 'x')).resolves.toBeUndefined();
  });
});
