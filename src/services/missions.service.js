const { t } = require('../i18n');
﻿function resolveClient(poolOrClient) {
  if (poolOrClient && typeof poolOrClient.query === 'function') {
    return poolOrClient;
  }
  throw new Error('Invalid db client');
}

function toDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Mission translations for better UX
const MISSION_TITLES = {
  'log_glucose': t('mission.log_glucose'),
  'log_bp': t('mission.log_bp'),
  'log_weight': t('mission.log_weight'),
  'log_water': t('mission.log_water'),
  'log_meal': t('mission.log_meal'),
  'log_insulin': t('mission.log_insulin'),
  'log_medication': t('mission.log_medication'),
  'daily_checkin': t('mission.daily_checkin')
};

const MISSION_DESCRIPTIONS = {
  'log_glucose': t('mission.desc_glucose'),
  'log_bp': t('mission.desc_bp'),
  'log_weight': t('mission.desc_weight'),
  'log_water': t('mission.desc_water'),
  'log_meal': t('mission.desc_meal'),
  'log_insulin': t('mission.desc_insulin'),
  'log_medication': t('mission.desc_medication'),
  'daily_checkin': t('mission.desc_checkin')
};

async function getMissions(pool, userId) {
  const client = resolveClient(pool);
  
  // Reset ALL missions if it's a new day (not just completed ones)
  const today = toDateOnly(new Date());
  await client.query(
    `UPDATE user_missions
     SET progress = 0, status = 'active', updated_at = NOW()
     WHERE user_id = $1
       AND last_incremented_date IS NOT NULL
       AND last_incremented_date::text < $2`,
    [userId, today]
  );
  
  const result = await client.query(
    `SELECT mission_key, status, progress, goal, updated_at
     FROM user_missions
     WHERE user_id = $1
     ORDER BY mission_key ASC`,
    [userId]
  );
  
  // Add titles and descriptions
  const missionsWithTitles = result.rows.map(mission => ({
    ...mission,
    title: MISSION_TITLES[mission.mission_key] || mission.mission_key,
    description: MISSION_DESCRIPTIONS[mission.mission_key] || null,
    id: `${userId}-${mission.mission_key}` // Add unique id for React keys
  }));
  
  return missionsWithTitles;
}

async function updateMissionProgress(clientOrPool, userId, missionKey, delta, opts = {}) {
  const client = resolveClient(clientOrPool);
  const now = opts.now ? new Date(opts.now) : new Date();
  const goal = Number(opts.goal || 1);
  const today = toDateOnly(now);

  const existing = await client.query(
    `SELECT * FROM user_missions WHERE user_id = $1 AND mission_key = $2 FOR UPDATE`,
    [userId, missionKey]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.last_incremented_date && String(row.last_incremented_date).slice(0, 10) === today) {
      return row;
    }
    const nextProgress = Math.min(Number(row.progress || 0) + delta, goal);
    const status = nextProgress >= goal ? 'completed' : 'active';
    const updated = await client.query(
      `UPDATE user_missions
       SET progress = $3,
           goal = $4,
           status = $5,
           last_incremented_date = $6,
           updated_at = $7
       WHERE user_id = $1 AND mission_key = $2
       RETURNING *`,
      [userId, missionKey, nextProgress, goal, status, today, now]
    );
    return updated.rows[0];
  }

  const startProgress = Math.min(Math.max(delta, 0), goal);
  const status = startProgress >= goal ? 'completed' : 'active';
  const inserted = await client.query(
    `INSERT INTO user_missions (user_id, mission_key, status, progress, goal, last_incremented_date, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, missionKey, status, startProgress, goal, today, now]
  );
  return inserted.rows[0];
}

/**
 * Get mission history
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {number} days - Number of days to retrieve (default 30)
 * @returns {Promise<Object>} - { ok, history }
 */
async function getMissionHistory(pool, userId, days = 30) {
  try {
    const client = resolveClient(pool);
    const result = await client.query(
      `SELECT 
        mission_key, 
        completed_date, 
        progress, 
        goal,
        created_at
      FROM mission_history
      WHERE user_id = $1
        AND completed_date >= CURRENT_DATE - $2::integer
      ORDER BY completed_date DESC, mission_key ASC`,
      [userId, days]
    );
    
    return { 
      ok: true, 
      history: result.rows 
    };
  } catch (err) {
    console.error('[missions.service] getMissionHistory failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Get mission statistics
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, stats }
 */
async function getMissionStats(pool, userId) {
  try {
    const client = resolveClient(pool);
    const result = await client.query(
      `SELECT 
        mission_key,
        COUNT(*) as total_completions,
        MAX(completed_date) as last_completed,
        MIN(completed_date) as first_completed
      FROM mission_history
      WHERE user_id = $1
      GROUP BY mission_key
      ORDER BY mission_key ASC`,
      [userId]
    );
    
    return { 
      ok: true, 
      stats: result.rows 
    };
  } catch (err) {
    console.error('[missions.service] getMissionStats failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

module.exports = {
  getMissions,
  updateMissionProgress,
  getMissionHistory,
  getMissionStats
};
