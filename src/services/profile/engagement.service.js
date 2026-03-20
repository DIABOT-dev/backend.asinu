/**
 * User Engagement Service
 * Tracks user behavior patterns for smarter notifications.
 */

const { cacheGet, cacheSet, cacheDel } = require('../../lib/redis');

async function trackEvent(pool, userId, eventType, metadata = {}) {
  await pool.query(
    `INSERT INTO user_engagement (user_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
    [userId, eventType, JSON.stringify(metadata)]
  );
}

async function getUserPattern(pool, userId) {
  const cached = await cacheGet(`engagement:pattern:${userId}`);
  if (cached) return cached;

  // Get most active hours (last 14 days)
  const hourRes = await pool.query(
    `SELECT EXTRACT(HOUR FROM occurred_at) as hour, COUNT(*) as cnt
     FROM user_engagement
     WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '14 days'
     GROUP BY hour ORDER BY cnt DESC LIMIT 3`,
    [userId]
  );

  // Get response rate
  const responseRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE no_response_count = 0) as responded,
       COUNT(*) as total
     FROM health_checkins
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'`,
    [userId]
  );

  const activeHours = hourRes.rows.map(r => parseInt(r.hour));
  const total = parseInt(responseRes.rows[0]?.total || 0);
  const responded = parseInt(responseRes.rows[0]?.responded || 0);
  const responseRate = total > 0 ? responded / total : 1;

  const result = {
    activeHours,
    responseRate,
    totalCheckins: total,
    isActive: total >= 3, // has enough data
  };
  await cacheSet(`engagement:pattern:${userId}`, result, 86400); // 24 hours
  return result;
}

async function getOptimalNotificationTime(pool, userId) {
  const pattern = await getUserPattern(pool, userId);

  if (!pattern.isActive || pattern.activeHours.length === 0) {
    // Default: 8am, 12pm, 8pm
    return { morning: 8, afternoon: 12, evening: 20 };
  }

  // Use most active hours
  const sorted = pattern.activeHours.sort((a, b) => a - b);
  return {
    morning: sorted.find(h => h >= 6 && h <= 10) || 8,
    afternoon: sorted.find(h => h >= 11 && h <= 15) || 12,
    evening: sorted.find(h => h >= 17 && h <= 22) || 20,
  };
}

module.exports = { trackEvent, getUserPattern, getOptimalNotificationTime };
