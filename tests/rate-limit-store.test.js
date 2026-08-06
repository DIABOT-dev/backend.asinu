const { RedisRateLimitStore } = require('../src/middleware/rate-limit-store');

describe('Redis rate-limit store', () => {
  test('returns a shared hit count and reset time from Redis', async () => {
    const store = new RedisRateLimitStore('test');
    store.redis = {
      eval: jest.fn().mockResolvedValue(['3', '59900']),
    };
    store.init({ windowMs: 60_000 });

    const result = await store.increment('203.0.113.10');

    expect(result.totalHits).toBe(3);
    expect(result.resetTime.getTime()).toBeGreaterThan(Date.now() - 1_000);
    expect(store.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^asinu:rate-limit:test:/),
      60_000
    );
  });

  test('falls back to the local store if Redis is unavailable', async () => {
    const store = new RedisRateLimitStore('test-fallback');
    store.redis = {
      eval: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    store.init({ windowMs: 60_000 });

    const first = await store.increment('203.0.113.11');
    const second = await store.increment('203.0.113.11');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });
});
