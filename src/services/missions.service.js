function resolveClient(poolOrClient) {
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
  'log_glucose': 'Đo đường huyết',
  'log_bp': 'Đo huyết áp',
  'log_weight': 'Cân nặng',
  'log_water': 'Uống nước',
  'log_meal': 'Ghi bữa ăn',
  'log_insulin': 'Ghi Insulin',
  'log_medication': 'Ghi thuốc',
  'daily_checkin': 'Điểm danh'
};

const MISSION_DESCRIPTIONS = {
  'log_glucose': 'Đo và ghi lại chỉ số đường huyết 2 lần/ngày',
  'log_bp': 'Theo dõi huyết áp định kỳ 2 lần/ngày',
  'log_weight': 'Cân nặng và ghi lại 1 lần/ngày',
  'log_water': 'Uống đủ nước, mục tiêu 4 ly/ngày',
  'log_meal': 'Ghi chép bữa ăn, mục tiêu 3 bữa/ngày',
  'log_insulin': 'Ghi chép liều insulin đã tiêm 1 lần/ngày',
  'log_medication': 'Ghi chép thuốc đã uống 1 lần/ngày',
  'daily_checkin': 'Mở app và ghi ít nhất 1 log'
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

module.exports = {
  getMissions,
  updateMissionProgress
};
