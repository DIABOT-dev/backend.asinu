'use strict';

/**
 * Script Cache Service — Phase 6 #15
 *
 * Quản lý reuse cached scripts để tiết kiệm AI token + giảm compute.
 *
 * Khi user inactive/churned quay lại check-in:
 *   1. Tìm script cached gần nhất cho cluster (is_active = TRUE)
 *   2. Nếu có → reuse, increment reuse_count, update last_reused_at
 *   3. Nếu không có → fall through (caller có thể generate mới)
 *
 * Khác với getScriptForCluster:
 *   - getScriptForCluster: chỉ fetch cached script (read-only)
 *   - getOrReuseScript: fetch + track reuse + auto reactivate nếu cần
 */

// ─── Get cached script for cluster (read-only) ──────────────────────────────

async function getCachedScript(pool, userId, clusterKey, scriptType = 'initial') {
  const { rows } = await pool.query(
    `SELECT id, user_id, cluster_id, cluster_key, script_type, script_data, version,
            generated_by, is_active, reuse_count, last_reused_at, created_at
     FROM triage_scripts
     WHERE user_id = $1 AND cluster_key = $2 AND script_type = $3 AND is_active = TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [userId, clusterKey, scriptType]
  );
  return rows[0] || null;
}

// ─── Reuse cached script (mark + increment) ─────────────────────────────────

/**
 * Reuse cached script: tăng reuse_count + cập nhật last_reused_at.
 * Trả về null nếu không có cached script.
 */
async function reuseScript(pool, userId, clusterKey, scriptType = 'initial') {
  const cached = await getCachedScript(pool, userId, clusterKey, scriptType);
  if (!cached) return null;

  await pool.query(
    `UPDATE triage_scripts
     SET reuse_count = reuse_count + 1,
         last_reused_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [cached.id]
  );

  // Refresh row with updated counters
  cached.reuse_count = (cached.reuse_count || 0) + 1;
  cached.last_reused_at = new Date();

  return cached;
}

// ─── Get or reuse script ────────────────────────────────────────────────────

/**
 * Hàm chính: tìm script + reuse nếu có, fallback tạo mới nếu không có.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} clusterKey
 * @param {object} options
 *   - scriptType: 'initial' | 'followup' (default 'initial')
 *   - allowGenerate: bool (default true) — false để chỉ check cache
 *   - generator: async function(pool, userId, clusterKey) → script (optional)
 * @returns {Promise<{ script, source: 'cache_reused' | 'cache_first' | 'generated' | 'none' }>}
 */
async function getOrReuseScript(pool, userId, clusterKey, options = {}) {
  const { scriptType = 'initial', allowGenerate = true, generator = null } = options;

  // 1. Try cached
  const cached = await getCachedScript(pool, userId, clusterKey, scriptType);

  if (cached) {
    // Reuse only if been reused before OR cluster has had multiple checks
    // (avoid double-counting on first use)
    if (cached.reuse_count > 0 || cached.last_reused_at) {
      const reused = await reuseScript(pool, userId, clusterKey, scriptType);
      return { script: reused, source: 'cache_reused' };
    }

    // First use — increment to mark as used
    await pool.query(
      `UPDATE triage_scripts SET reuse_count = reuse_count + 1, last_reused_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [cached.id]
    );
    cached.reuse_count = (cached.reuse_count || 0) + 1;
    return { script: cached, source: 'cache_first' };
  }

  // 2. No cached script — generate if allowed
  if (allowGenerate && generator) {
    try {
      const generated = await generator(pool, userId, clusterKey);
      return { script: generated, source: 'generated' };
    } catch (err) {
      console.warn(`[ScriptCache] Generator failed for ${clusterKey}:`, err.message);
      return { script: null, source: 'none', error: err.message };
    }
  }

  return { script: null, source: 'none' };
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

async function getReuseStatsForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_scripts,
       COALESCE(SUM(reuse_count), 0)::int AS total_reuses,
       MAX(reuse_count)::int AS max_reuses,
       MAX(last_reused_at) AS last_reuse,
       COUNT(*) FILTER (WHERE reuse_count > 0)::int AS reused_scripts
     FROM triage_scripts
     WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );
  return rows[0] || { total_scripts: 0, total_reuses: 0, max_reuses: 0, reused_scripts: 0 };
}

async function getTopReusedScripts(pool, limit = 10) {
  const { rows } = await pool.query(
    `SELECT ts.id, ts.user_id, ts.cluster_key, ts.reuse_count, ts.last_reused_at,
            u.display_name
     FROM triage_scripts ts
     JOIN users u ON u.id = ts.user_id
     WHERE ts.is_active = TRUE AND ts.reuse_count > 0
     ORDER BY ts.reuse_count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getGlobalReuseStats(pool) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_active_scripts,
       COALESCE(SUM(reuse_count), 0)::int AS total_reuses,
       COUNT(*) FILTER (WHERE reuse_count > 0)::int AS scripts_reused_at_least_once,
       COUNT(*) FILTER (WHERE reuse_count = 0)::int AS scripts_never_reused,
       AVG(reuse_count)::numeric(10,2) AS avg_reuse_count
     FROM triage_scripts
     WHERE is_active = TRUE`
  );
  return rows[0];
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getCachedScript,
  reuseScript,
  getOrReuseScript,
  getReuseStatsForUser,
  getTopReusedScripts,
  getGlobalReuseStats,
};
