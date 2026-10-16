'use strict';
const { randomUUID } = require('node:crypto');
const { getRedis } = require('../../lib/redis');
const ACQUIRE = `
 if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
 if tonumber(redis.call('GET', KEYS[2]) or '0') >= 10 or tonumber(redis.call('GET', KEYS[3]) or '0') >= 100 then return 0 end
 redis.call('SET', KEYS[1], ARGV[1], 'PX', 65000)
 for i = 2,3 do local hits = redis.call('INCR', KEYS[i]); if hits == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[i]) end end
 return 1`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
async function acquireOnboardingBudget(userId) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw new Error('Invalid AI account');
  const prefix = `asinu:onboarding-ai:${userId}`;
  const now = Date.now();
  const lease = `${prefix}:lease`;
  const token = randomUUID();
  const redis = getRedis();
  // Shared quotas across replicas; an unavailable counter fails closed.
  const acquired = await redis.eval(ACQUIRE, 3, lease, `${prefix}:minute:${Math.floor(now / 60000)}`,
    `${prefix}:day:${Math.floor(now / 86400000)}`, token, 60000, 86400000);
  if (Number(acquired) !== 1) throw Object.assign(new Error('AI request limit reached.'), { statusCode: 429 });
  return async () => { await redis.eval(RELEASE, 1, lease, token); };
}
module.exports = { acquireOnboardingBudget };
