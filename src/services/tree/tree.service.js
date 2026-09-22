/**
 * Tree Service
 * Business logic cho tree (health score) summary and history
 */

const { t } = require('../../i18n');
const { cacheGet, cacheSet } = require('../../lib/redis');
const checkinService = require('../checkin/checkin.service');

const TREE_DASHBOARD_CACHE_TTL_SECONDS = 60;

const DAY_LABEL_KEYS = [
  'tree.day_sun',
  'tree.day_mon',
  'tree.day_tue',
  'tree.day_wed',
  'tree.day_thu',
  'tree.day_fri',
  'tree.day_sat',
];

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function glucoseStatus(value) {
  if (value === null) return 'unavailable';
  if (value < 70 || value > 250) return 'danger';
  if (value >= 200) return 'monitor';
  return 'stable';
}

function bloodPressureStatus(systolic) {
  if (systolic === null) return 'unavailable';
  if (systolic > 180) return 'danger';
  if (systolic >= 140) return 'monitor';
  return 'stable';
}

function metric(value, unit, recordedAt, status, extra = {}) {
  if (value === null) return null;
  return { value, unit, recordedAt, status, ...extra };
}

async function getLatestMetrics(pool, userId) {
  const [glucoseResult, bloodPressureResult, weightResult, waterResult] = await Promise.all([
    pool.query(
      `SELECT gl.value, gl.unit, lc.occurred_at
       FROM glucose_logs gl
       JOIN logs_common lc ON lc.id = gl.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'
       ORDER BY lc.occurred_at DESC LIMIT 1`,
      [userId],
    ),
    pool.query(
      `SELECT bp.systolic, bp.diastolic, bp.pulse, bp.unit, lc.occurred_at
       FROM blood_pressure_logs bp
       JOIN logs_common lc ON lc.id = bp.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'
       ORDER BY lc.occurred_at DESC LIMIT 1`,
      [userId],
    ),
    pool.query(
      `SELECT wl.weight_kg, wl.body_fat_percent, wl.muscle_percent, lc.occurred_at
       FROM weight_logs wl
       JOIN logs_common lc ON lc.id = wl.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'
       ORDER BY lc.occurred_at DESC LIMIT 1`,
      [userId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(wl.volume_ml), 0) AS total_ml,
              MAX(lc.occurred_at) AS occurred_at,
              COUNT(*)::int AS entry_count
       FROM water_logs wl
       JOIN logs_common lc ON lc.id = wl.log_id
       WHERE lc.user_id = $1 AND lc.occurred_at >= NOW() - INTERVAL '24 hours'`,
      [userId],
    ),
  ]);

  const glucoseRow = glucoseResult.rows[0];
  const bloodPressureRow = bloodPressureResult.rows[0];
  const weightRow = weightResult.rows[0];
  const waterRow = waterResult.rows[0];
  const glucoseValue = toFiniteNumber(glucoseRow?.value);
  const systolic = toFiniteNumber(bloodPressureRow?.systolic);
  const diastolic = toFiniteNumber(bloodPressureRow?.diastolic);
  const weight = toFiniteNumber(weightRow?.weight_kg);
  const waterTotal = toFiniteNumber(waterRow?.total_ml);

  return {
    glucose: metric(glucoseValue, glucoseRow?.unit || 'mg/dL', glucoseRow?.occurred_at || null, glucoseStatus(glucoseValue)),
    bloodPressure: bloodPressureRow && systolic !== null && diastolic !== null
      ? metric(
          `${systolic}/${diastolic}`,
          bloodPressureRow.unit || 'mmHg',
          bloodPressureRow.occurred_at,
          bloodPressureStatus(systolic),
          { systolic, diastolic, pulse: toFiniteNumber(bloodPressureRow.pulse) },
        )
      : null,
    weight: metric(weight, 'kg', weightRow?.occurred_at || null, 'available', {
      bodyFatPercent: toFiniteNumber(weightRow?.body_fat_percent),
      musclePercent: toFiniteNumber(weightRow?.muscle_percent),
    }),
    water: waterTotal !== null && waterTotal > 0
      ? metric(waterTotal, 'ml', waterRow.occurred_at, 'available', { entryCount: waterRow.entry_count || 0 })
      : null,
  };
}

async function getTodayCheckin(pool, userId) {
  const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const result = await pool.query(
    `SELECT initial_status, current_status, flow_state, triage_severity,
            emergency_triggered, triage_completed_at, next_checkin_at, created_at
     FROM health_checkins
     WHERE user_id = $1 AND session_date = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, todayVN],
  );
  const row = result.rows[0];
  if (!row) return { done: false, status: null, recordedAt: null };

  const done = row.initial_status === 'fine' ||
    row.triage_completed_at !== null ||
    row.flow_state === 'monitoring' ||
    row.flow_state === 'resolved';

  return {
    done,
    status: row.current_status || row.initial_status,
    flowState: row.flow_state,
    severity: row.triage_severity,
    emergencyTriggered: Boolean(row.emergency_triggered),
    recordedAt: row.created_at,
    completedAt: row.triage_completed_at,
    nextCheckinAt: row.next_checkin_at,
  };
}

async function getSupportingActivity(pool, userId) {
  const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [missionsResult, totalMissionsResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS completed_count
       FROM user_missions
       WHERE user_id = $1 AND status = 'completed' AND last_incremented_date = $2`,
      [userId, todayVN],
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM user_missions WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const completedToday = parseInt(missionsResult.rows[0]?.completed_count || 0, 10);
  const totalMissions = parseInt(totalMissionsResult.rows[0]?.total || 0, 10);
  let streakDays = 0;

  if (totalMissions > 0) {
    const streakResult = await pool.query(
      `SELECT completed_date
       FROM mission_history
       WHERE user_id = $1
         AND completed_date >= (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - INTERVAL '31 days'
       GROUP BY completed_date
       HAVING COUNT(DISTINCT mission_key) >= $2
       ORDER BY completed_date DESC`,
      [userId, totalMissions],
    );
    const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const todayVNMs = Date.UTC(nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate());
    for (let i = 0; i < streakResult.rows.length; i += 1) {
      const date = new Date(streakResult.rows[i].completed_date);
      const dateMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (dateMs !== todayVNMs - i * 86400000) break;
      streakDays += 1;
    }
  }

  return {
    streakDays,
    completedToday,
    totalMissions: totalMissions || 12,
  };
}

/**
 * Get the health dashboard used by the tree screen.
 * Check-in status and recent readings drive the current state. Logs and
 * missions are returned as supporting context only.
 */
async function getTreeSummary(pool, userId) {
  try {
    const cacheKey = `tree:dashboard:v2:${userId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const [healthStatus, checkin, metrics, supporting] = await Promise.all([
      checkinService.getHealthScore(pool, userId),
      getTodayCheckin(pool, userId),
      getLatestMetrics(pool, userId),
      getSupportingActivity(pool, userId),
    ]);

    const result = {
      ok: true,
      generatedAt: new Date().toISOString(),
      status: healthStatus.level,
      healthStatus: {
        level: healthStatus.level,
        factors: healthStatus.factors,
        checkinDone: healthStatus.checkinDone,
      },
      checkin,
      metrics,
      alerts: {
        hasAlerts: healthStatus.factors.length > 0,
        factors: healthStatus.factors,
      },
      supporting,
      // Kept for older clients. New clients must use healthStatus instead of
      // treating this field as a medical score.
      score: null,
      streakDays: supporting.streakDays,
      completedToday: supporting.completedToday,
      totalMissions: supporting.totalMissions,
    };
    await cacheSet(cacheKey, result, TREE_DASHBOARD_CACHE_TTL_SECONDS);
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
        value,
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
  getTreeHistory,
};
