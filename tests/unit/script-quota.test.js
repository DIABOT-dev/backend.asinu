process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';

jest.mock('../../src/services/payment/subscription.service', () => ({
  isPremium: jest.fn(),
}));

const {
  getMonthlyRegenCount,
  recordRegeneration,
  getScriptRegenStatus,
} = require('../../src/services/checkin/script-quota.service');
const { isPremium } = require('../../src/services/payment/subscription.service');

function poolReturning(rows) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SCRIPT_REGEN_LIMIT_FREE = '2';
  process.env.SCRIPT_REGEN_LIMIT_PREMIUM = '10';
});

describe('getMonthlyRegenCount', () => {
  test('returns count from DB', async () => {
    const pool = poolReturning([{ n: 3 }]);
    expect(await getMonthlyRegenCount(pool, 1)).toBe(3);
  });

  test('fail-open returns 0 on DB error', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await getMonthlyRegenCount(pool, 1)).toBe(0);
  });
});

describe('getScriptRegenStatus', () => {
  test('premium with 5 used -> allowed', async () => {
    isPremium.mockResolvedValue(true);
    const pool = poolReturning([{ n: 5 }]);
    const r = await getScriptRegenStatus(pool, 1);
    expect(r).toMatchObject({ used: 5, limit: 10, allowed: true, tier: 'premium' });
  });

  test('free with 2 used -> blocked', async () => {
    isPremium.mockResolvedValue(false);
    const pool = poolReturning([{ n: 2 }]);
    const r = await getScriptRegenStatus(pool, 1);
    expect(r).toMatchObject({ used: 2, limit: 2, allowed: false, tier: 'free' });
  });

  test('isPremium error treated as free', async () => {
    isPremium.mockRejectedValue(new Error('x'));
    const pool = poolReturning([{ n: 0 }]);
    const r = await getScriptRegenStatus(pool, 1);
    expect(r.tier).toBe('free');
    expect(r.limit).toBe(2);
  });
});

describe('recordRegeneration', () => {
  test('inserts a row', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    await recordRegeneration(pool, 1, 'headache', 'new_symptom');
    expect(pool.query).toHaveBeenCalled();
    expect(pool.query.mock.calls[0][1]).toEqual([1, 'headache', 'new_symptom', expect.any(String)]);
  });

  test('swallows DB error', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('down')) };
    await expect(recordRegeneration(pool, 1, 'x')).resolves.toBeUndefined();
  });
});
