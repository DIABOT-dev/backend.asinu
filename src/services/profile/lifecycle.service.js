'use strict';

/**
 * User Lifecycle Service
 *
 * Phân nhóm user theo mức độ hoạt động:
 *   - active:      check-in trong 1 ngày gần nhất
 *   - semi_active: 2-3 ngày không check-in
 *   - inactive:    4-7 ngày không check-in
 *   - churned:     >7 ngày không check-in
 *
 * Mục đích:
 *   1. R&D cycle chỉ process user active/semi_active → tiết kiệm AI token
 *   2. Script generation chỉ chạy cho active → giảm compute
 *   3. Nền tảng cho re-engagement notification (Phase 2)
 */

// ─── Segment thresholds (ngày) ──────────────────────────────────────────────

const SEGMENT_THRESHOLDS = {
  active: 1,       // <= 1 ngày
  semi_active: 3,  // 2-3 ngày
  inactive: 7,     // 4-7 ngày
  churned: Infinity // >7 ngày
};

// ─── Calculate segment from inactive days ───────────────────────────────────

function calculateSegment(inactiveDays) {
  if (inactiveDays <= SEGMENT_THRESHOLDS.active) return 'active';
  if (inactiveDays <= SEGMENT_THRESHOLDS.semi_active) return 'semi_active';
  if (inactiveDays <= SEGMENT_THRESHOLDS.inactive) return 'inactive';
  return 'churned';
}

// ─── Get lifecycle for a single user ────────────────────────────────────────

async function getLifecycle(pool, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM user_lifecycle WHERE user_id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    // User chưa có record → tạo mới
    return ensureLifecycle(pool, userId);
  }

  return rows[0];
}

// ─── Ensure lifecycle record exists ─────────────────────────────────────────

async function ensureLifecycle(pool, userId) {
  const { rows } = await pool.query(
    `INSERT INTO user_lifecycle (user_id, last_checkin_at, inactive_days, segment)
     SELECT
       $1,
       MAX(hc.session_date)::timestamptz,
       COALESCE(EXTRACT(DAY FROM NOW() - MAX(hc.session_date)::timestamptz)::int, 999),
       CASE
         WHEN MAX(hc.session_date) IS NULL THEN 'inactive'
         WHEN MAX(hc.session_date)::date >= (NOW() - INTERVAL '1 day')::date THEN 'active'
         WHEN MAX(hc.session_date)::date >= (NOW() - INTERVAL '3 days')::date THEN 'semi_active'
         WHEN MAX(hc.session_date)::date >= (NOW() - INTERVAL '7 days')::date THEN 'inactive'
         ELSE 'churned'
       END
     FROM health_checkins hc
     WHERE hc.user_id = $1
     HAVING TRUE
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId]
  );

  if (rows.length === 0) {
    // User chưa từng check-in
    const { rows: inserted } = await pool.query(
      `INSERT INTO user_lifecycle (user_id, inactive_days, segment)
       VALUES ($1, 999, 'inactive')
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId]
    );
    return inserted[0];
  }

  return rows[0];
}

// ─── Mark user as active (gọi khi user check-in) ───────────────────────────

async function markActive(pool, userId) {
  const { rows } = await pool.query(
    `INSERT INTO user_lifecycle (user_id, last_checkin_at, inactive_days, segment)
     VALUES ($1, NOW(), 0, 'active')
     ON CONFLICT (user_id) DO UPDATE SET
       last_checkin_at = NOW(),
       inactive_days = 0,
       segment = 'active',
       updated_at = NOW()
     RETURNING *`,
    [userId]
  );
  return rows[0];
}

// ─── Update all user segments (daily cron) ──────────────────────────────────

async function updateAllSegments(pool) {
  const result = await pool.query(
    `UPDATE user_lifecycle SET
       inactive_days = COALESCE(
         EXTRACT(DAY FROM NOW() - last_checkin_at)::int,
         inactive_days + 1
       ),
       segment = CASE
         WHEN last_checkin_at IS NULL THEN 'inactive'
         WHEN last_checkin_at::date >= (NOW() - INTERVAL '1 day')::date THEN 'active'
         WHEN last_checkin_at::date >= (NOW() - INTERVAL '3 days')::date THEN 'semi_active'
         WHEN last_checkin_at::date >= (NOW() - INTERVAL '7 days')::date THEN 'inactive'
         ELSE 'churned'
       END,
       updated_at = NOW()
     RETURNING user_id, segment, inactive_days`
  );

  // Thống kê
  const stats = { active: 0, semi_active: 0, inactive: 0, churned: 0, total: 0 };
  for (const row of result.rows) {
    stats[row.segment]++;
    stats.total++;
  }

  console.log('[Lifecycle] Updated segments:', stats);
  return stats;
}

// ─── Get users by segment ───────────────────────────────────────────────────

async function getUsersBySegment(pool, segment) {
  const { rows } = await pool.query(
    `SELECT user_id, inactive_days, last_checkin_at FROM user_lifecycle WHERE segment = $1`,
    [segment]
  );
  return rows;
}

// ─── Get active user IDs (for R&D cycle filter) ─────────────────────────────

async function getActiveUserIds(pool) {
  const { rows } = await pool.query(
    `SELECT user_id FROM user_lifecycle WHERE segment IN ('active', 'semi_active')`
  );
  return rows.map(r => r.user_id);
}

// ─── Check if user should get script generation ─────────────────────────────

async function shouldGenerateScript(pool, userId) {
  const lifecycle = await getLifecycle(pool, userId);

  if (lifecycle.segment === 'active') return true;

  if (lifecycle.segment === 'semi_active') {
    // Chỉ generate nếu script cũ > 7 ngày
    const { rows } = await pool.query(
      `SELECT created_at FROM triage_scripts
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return true; // Chưa có script → generate
    const daysSinceScript = (Date.now() - new Date(rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceScript > 7;
  }

  // inactive, churned → không generate
  return false;
}

// ─── Get full lifecycle summary (for API/debug) ─────────────────────────────

async function getLifecycleSummary(pool) {
  const { rows } = await pool.query(
    `SELECT
       ul.user_id,
       u.display_name,
       ul.segment,
       ul.inactive_days,
       ul.last_checkin_at,
       ul.updated_at
     FROM user_lifecycle ul
     JOIN users u ON u.id = ul.user_id
     ORDER BY ul.segment, ul.inactive_days`
  );
  return rows;
}

module.exports = {
  SEGMENT_THRESHOLDS,
  calculateSegment,
  getLifecycle,
  ensureLifecycle,
  markActive,
  updateAllSegments,
  getUsersBySegment,
  getActiveUserIds,
  shouldGenerateScript,
  getLifecycleSummary,
};
