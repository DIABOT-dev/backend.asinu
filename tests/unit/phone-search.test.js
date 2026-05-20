/**
 * The phone normalization helper inside auth.service is private, but we can
 * exercise the public searchUsers signature with a mocked pool to verify
 * the new "exact match only" behavior.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_unit_tests_only';
const { searchUsers } = require('../../src/services/auth/auth.service');
const { phoneSearchRateLimit } = require('../../src/middleware/phone-search.middleware');

function poolReturning(rows) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('searchUsers (phone-only, exact match)', () => {
  test('rejects partial phone (returns empty)', async () => {
    const pool = poolReturning([]);
    const r = await searchUsers(pool, 1, '0901');
    expect(r).toEqual([]);
    // Should not even hit the database for an invalid phone.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects letters', async () => {
    const pool = poolReturning([]);
    const r = await searchUsers(pool, 1, 'foo');
    expect(r).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('accepts full 10-digit local form', async () => {
    const pool = poolReturning([
      { id: 42, phone_number: '0901234567', display_name: 'Đức', email: null, full_name: null },
    ]);
    const r = await searchUsers(pool, 1, '0901234567');
    expect(r).toHaveLength(1);
    expect(r[0].phone).toBe('0901234567');
    // SQL uses = not LIKE
    expect(pool.query.mock.calls[0][1]).toEqual([1, '0901234567']);
  });

  test('accepts +84 form, normalizes to 0', async () => {
    const pool = poolReturning([
      { id: 42, phone_number: '0901234567', display_name: 'Đức', email: null, full_name: null },
    ]);
    const r = await searchUsers(pool, 1, '+84901234567');
    expect(r).toHaveLength(1);
    expect(pool.query.mock.calls[0][1]).toEqual([1, '0901234567']);
  });

  test('strips spaces / dashes / parentheses', async () => {
    const pool = poolReturning([]);
    await searchUsers(pool, 1, '090 123-4567');
    expect(pool.query.mock.calls[0][1]).toEqual([1, '0901234567']);
  });
});

describe('phoneSearchRateLimit middleware', () => {
  function makeReqRes() {
    const req = { user: { id: 1 }, headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    return { req, res, next };
  }

  beforeEach(() => {
    process.env.PHONE_SEARCH_DAILY_LIMIT = '3';
  });

  test('passes when under limit', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ search_count: 2 }] }) };
    const { req, res, next } = makeReqRes();
    await phoneSearchRateLimit(pool)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.phoneSearchUsage).toEqual({ used: 2, limit: 3 });
  });

  test('blocks when over limit', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ search_count: 4 }] }) };
    const { req, res, next } = makeReqRes();
    await phoneSearchRateLimit(pool)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PHONE_SEARCH_LIMIT' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('fails open if DB errors', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('down')) };
    const { req, res, next } = makeReqRes();
    await phoneSearchRateLimit(pool)(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
