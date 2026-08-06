const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getRedis } = require('../lib/redis');

const REDIS_INCREMENT_SCRIPT = `
  local hits = redis.call('INCR', KEYS[1])
  if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return { hits, redis.call('PTTL', KEYS[1]) }
`;

const keyHash = (key) => crypto.createHash('sha256').update(key).digest('hex');

class RedisRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.redis = getRedis();
    this.fallback = new rateLimit.MemoryStore();
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  redisKey(key) {
    return `asinu:rate-limit:${this.prefix}:${keyHash(key)}`;
  }

  async increment(key) {
    try {
      const [totalHits, ttl] = await this.redis.eval(
        REDIS_INCREMENT_SCRIPT,
        1,
        this.redisKey(key),
        this.windowMs
      );
      return {
        totalHits: Number(totalHits),
        resetTime: new Date(Date.now() + Math.max(Number(ttl), 0)),
      };
    } catch {
      const result = await this.fallback.increment(key);
      return { ...result };
    }
  }

  async decrement(key) {
    try {
      await this.redis.decr(this.redisKey(key));
    } catch {
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key) {
    try {
      await this.redis.del(this.redisKey(key));
    } catch {
      await this.fallback.resetKey(key);
    }
  }

  async resetAll() {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `asinu:rate-limit:${this.prefix}:*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch {
      await this.fallback.resetAll();
    }
  }
}

const createRateLimitStore = (prefix) => new RedisRateLimitStore(prefix);

module.exports = { createRateLimitStore, RedisRateLimitStore };
