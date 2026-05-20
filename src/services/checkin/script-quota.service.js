/**
 * Monthly quota for AI script regenerations. Implements MVP audit FIX #2:
 *
 *   "Mỗi user chỉ được generate script một số lần nhất định trong tháng.
 *    Không cho regenerate liên tục."
 *
 * Free vs Premium budgets are env-driven so product can retune. Quota
 * lookups are best-effort: if the ledger table is missing or the DB is
 * down we DO NOT block check-in — instead we fall back to the existing
 * script/rule path so the user is never stuck.
 */

const logger = require('../../lib/logger');
const { isPremium } = require('../payment/subscription.service');

const DEFAULT_FREE_LIMIT    = Number(process.env.SCRIPT_REGEN_LIMIT_FREE || 2);
const DEFAULT_PREMIUM_LIMIT = Number(process.env.SCRIPT_REGEN_LIMIT_PREMIUM || 10);

function thisMonthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function getMonthlyRegenCount(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INTEGER AS n
         FROM script_regeneration_log
        WHERE user_id = $1 AND month_key = $2`,
      [userId, thisMonthKey()]
    );
    return rows[0]?.n || 0;
  } catch (err) {
    // Missing table or transient DB error — fail-open so we don't strand
    // a real user mid-check-in.
    logger.warn('script_quota.count_failed', { user_id: userId, err });
    return 0;
  }
}

async function recordRegeneration(pool, userId, clusterKey, trigger = 'manual') {
  try {
    await pool.query(
      `INSERT INTO script_regeneration_log (user_id, cluster_key, trigger, month_key)
       VALUES ($1, $2, $3, $4)`,
      [userId, clusterKey, trigger, thisMonthKey()]
    );
  } catch (err) {
    logger.warn('script_quota.record_failed', { user_id: userId, cluster_key: clusterKey, err });
  }
}

/**
 * Returns the user's current quota status. The caller decides whether to
 * generate a new script or fall back to a static script.
 *
 * @returns {Promise<{ used: number, limit: number, allowed: boolean }>}
 */
async function getScriptRegenStatus(pool, userId) {
  const [premium, used] = await Promise.all([
    isPremium(pool, userId).catch(() => false),
    getMonthlyRegenCount(pool, userId),
  ]);

  const limit = premium ? DEFAULT_PREMIUM_LIMIT : DEFAULT_FREE_LIMIT;
  return { used, limit, allowed: used < limit, tier: premium ? 'premium' : 'free' };
}

module.exports = {
  getMonthlyRegenCount,
  recordRegeneration,
  getScriptRegenStatus,
};
