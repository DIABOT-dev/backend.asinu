/**
 * Tree Service
 * Business logic cho tree (health score) summary and history
 */

const { t } = require('../../i18n');
const { cacheGet, cacheSet } = require('../../lib/redis');

const DAYS_IN_WEEK = 7;
const DAY_LABEL_KEYS = [
  'tree.day_sun', 'tree.day_mon', 'tree.day_tue', 'tree.day_wed',
  'tree.day_thu', 'tree.day_fri', 'tree.day_sat',
];

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get tree summary with score, streak, missions
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, score, streakDays, completedThisWeek, totalMissions, error }
 */
async function getTreeSummary(pool, userId) {
  try {
    const cached = await cacheGet(`tree:summary:${userId}`);
    if (cached) return cached;

    // Vietnam timezone (UTC+7) — phải nhất quán với missions.service.js
    const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const todayVN = `${nowVN.getUTCFullYear()}-${String(nowVN.getUTCMonth() + 1).padStart(2, '0')}-${String(nowVN.getUTCDate()).padStart(2, '0')}`;

    // Get missions completed TODAY (last_incremented_date lưu theo giờ VN)
    const missionsResult = await pool.query(
      `SELECT COUNT(*) as completed_count
       FROM user_missions
       WHERE user_id = $1
         AND status = 'completed'
         AND last_incremented_date = $2`,
      [userId, todayVN]
    );

    // Get total active missions count for today
    const totalMissionsResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM user_missions
       WHERE user_id = $1`,
      [userId]
    );

    // Calculate streak: consecutive days where ALL missions were completed
    // Uses mission_history which records each mission completion with completed_date
    const totalForStreak = parseInt(totalMissionsResult.rows[0]?.total || 0);

    let streakDays = 0;
    if (totalForStreak > 0) {
      const streakResult = await pool.query(
        `SELECT completed_date
         FROM mission_history
         WHERE user_id = $1
           AND completed_date >= (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - INTERVAL '31 days'
         GROUP BY completed_date
         HAVING COUNT(DISTINCT mission_key) >= $2
         ORDER BY completed_date DESC`,
        [userId, totalForStreak]
      );

      // So sánh ngày theo VN timezone — tránh lệch ngày khi server chạy UTC
      const todayVNMs = Date.UTC(nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate());

      for (let i = 0; i < streakResult.rows.length; i++) {
        const d = new Date(streakResult.rows[i].completed_date);
        const logMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const expectedMs = todayVNMs - i * 86400000;

        if (logMs === expectedMs) {
          streakDays++;
        } else {
          break;
        }
      }
    }

    // Calculate health score based on recent activity
    const recentLogsResult = await pool.query(
      `SELECT COUNT(*) as log_count
       FROM logs_common
       WHERE user_id = $1
         AND occurred_at >= NOW() - INTERVAL '7 days'`,
      [userId]
    );

    const logCount = parseInt(recentLogsResult.rows[0]?.log_count || 0);
    const completedCount = parseInt(missionsResult.rows[0]?.completed_count || 0);
    const totalMissions = parseInt(totalMissionsResult.rows[0]?.total || 0);

    // Score calculation: max 1.0
    // - 50% from logs (max 14 logs per week = 2 per day)
    // - 50% from missions completed
    const logScore = Math.min(logCount / 14, 1) * 0.5;
    const missionScore = totalMissions > 0 ? (completedCount / totalMissions) * 0.5 : 0;
    const score = Math.round((logScore + missionScore) * 100) / 100;

    const result = {
      ok: true,
      score,
      streakDays,
      completedToday: completedCount,
      totalMissions: totalMissions || 12
    };
    await cacheSet(`tree:summary:${userId}`, result, 1800); // 30 min
    return result;
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Get tree history for past 7 days
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, history, error }
 */
async function getTreeHistory(pool, userId) {
  try {
    const cached = await cacheGet(`tree:history:${userId}`);
    if (cached) return cached;

    // Get daily log counts for the past 7 days (Vietnam timezone)
    const result = await pool.query(
      `SELECT DATE(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') as log_date, COUNT(*) as count
       FROM logs_common
       WHERE user_id = $1
         AND occurred_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
       ORDER BY log_date ASC`,
      [userId]
    );

    const logsByDate = {};
    for (const row of result.rows) {
      const dateStr = new Date(row.log_date).toISOString().split('T')[0];
      logsByDate[dateStr] = parseInt(row.count);
    }

    // Build history for the past 7 days (Vietnam timezone)
    const history = [];
    const today = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);

    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayIndex = date.getDay();
      
      const count = logsByDate[dateStr] || 0;
      // Convert count to a score (0-100)
      const value = Math.min(count * 25, 100);
      
      history.push({
        label: t(DAY_LABEL_KEYS[dayIndex]),
        value
      });
    }

    const historyResult = { ok: true, history };
    await cacheSet(`tree:history:${userId}`, historyResult, 1800); // 30 min
    return historyResult;
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

module.exports = {
  getTreeSummary,
  getTreeHistory
};
