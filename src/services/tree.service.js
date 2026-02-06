/**
 * Tree Service
 * Business logic cho tree (health score) summary and history
 */

const DAYS_IN_WEEK = 7;
const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

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
    const now = new Date();
    const startOfWeek = getStartOfWeek(now);

    // Get missions completed this week
    const missionsResult = await pool.query(
      `SELECT COUNT(*) as completed_count
       FROM user_missions
       WHERE user_id = $1
         AND status = 'completed'
         AND updated_at >= $2`,
      [userId, startOfWeek.toISOString()]
    );

    // Get total active missions count
    const totalMissionsResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM user_missions
       WHERE user_id = $1`,
      [userId]
    );

    // Calculate streak days based on consecutive daily activity
    const streakResult = await pool.query(
      `SELECT DISTINCT DATE(occurred_at) as log_date
       FROM logs_common
       WHERE user_id = $1
       ORDER BY log_date DESC
       LIMIT 30`,
      [userId]
    );

    let streakDays = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < streakResult.rows.length; i++) {
      const logDate = new Date(streakResult.rows[i].log_date);
      logDate.setHours(0, 0, 0, 0);
      
      const expectedDate = new Date(today);
      expectedDate.setDate(expectedDate.getDate() - i);
      
      if (logDate.getTime() === expectedDate.getTime()) {
        streakDays++;
      } else {
        break;
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

    return {
      ok: true,
      score,
      streakDays,
      completedThisWeek: completedCount,
      totalMissions: totalMissions || 12
    };
  } catch (err) {
    console.error('[tree.service] getTreeSummary failed:', err);
    return { ok: false, error: 'Server error' };
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
    // Get daily log counts for the past 7 days
    const result = await pool.query(
      `SELECT DATE(occurred_at) as log_date, COUNT(*) as count
       FROM logs_common
       WHERE user_id = $1
         AND occurred_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(occurred_at)
       ORDER BY log_date ASC`,
      [userId]
    );

    const logsByDate = {};
    for (const row of result.rows) {
      const dateStr = new Date(row.log_date).toISOString().split('T')[0];
      logsByDate[dateStr] = parseInt(row.count);
    }

    // Build history for the past 7 days
    const history = [];
    const today = new Date();
    
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayIndex = date.getDay();
      
      const count = logsByDate[dateStr] || 0;
      // Convert count to a score (0-100)
      const value = Math.min(count * 25, 100);
      
      history.push({
        label: DAY_LABELS[dayIndex],
        value
      });
    }

    return { ok: true, history };
  } catch (err) {
    console.error('[tree.service] getTreeHistory failed:', err);
    return { ok: false, error: 'Server error' };
  }
}

module.exports = {
  getTreeSummary,
  getTreeHistory
};
