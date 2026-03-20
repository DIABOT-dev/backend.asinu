const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client = null;

function getRedis() {
  if (!client) {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.warn('[Redis] Connection error:', err.message);
    });

    client.on('connect', () => {
      console.log('[Redis] Connected');
    });
  }
  return client;
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

/**
 * Get cached value (parsed JSON) or null
 */
async function cacheGet(key) {
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Set cache with TTL (seconds)
 */
async function cacheSet(key, value, ttlSeconds = 300) {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch { /* ignore */ }
}

/**
 * Delete cache key(s)
 */
async function cacheDel(...keys) {
  try {
    if (keys.length > 0) await getRedis().del(...keys);
  } catch { /* ignore */ }
}

/**
 * Delete all keys matching pattern (e.g. "user:42:*")
 */
async function cacheDelPattern(pattern) {
  try {
    const redis = getRedis();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch { /* ignore */ }
}

/**
 * Get-or-set pattern: return cached value or compute & cache it
 */
async function cacheGetOrSet(key, computeFn, ttlSeconds = 300) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const value = await computeFn();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

module.exports = {
  getRedis,
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
  cacheGetOrSet,
};
