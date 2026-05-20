/**
 * Per-user, per-day quota for phone-number search.
 *
 * Why: phone search returns minimal user data, but without a limit an
 * attacker can enumerate the database by trying random numbers. Combined
 * with the exact-match-only change in auth.service.searchUsers, this
 * caps a single account at PHONE_SEARCH_DAILY_LIMIT lookups per day.
 *
 * Uses a tiny phone_search_log table (one row per user per day).
 */

const { t, getLang } = require('../i18n');
const logger = require('../lib/logger');

const DEFAULT_LIMIT = 20;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function phoneSearchRateLimit(pool) {
  const limit = Number(process.env.PHONE_SEARCH_DAILY_LIMIT || DEFAULT_LIMIT);

  return async function phoneSearchRateLimitMiddleware(req, res, next) {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
    }

    try {
      // Atomic increment-or-insert. We check the resulting count to decide.
      const { rows } = await pool.query(
        `INSERT INTO phone_search_log (user_id, day_key, search_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, day_key)
         DO UPDATE SET search_count = phone_search_log.search_count + 1,
                       updated_at   = NOW()
         RETURNING search_count`,
        [userId, todayKey()]
      );

      const count = rows[0]?.search_count || 1;
      if (count > limit) {
        return res.status(429).json({
          ok: false,
          code: 'PHONE_SEARCH_LIMIT',
          error: t('error.phone_search_limit', getLang(req)) ||
                 'Đã đạt giới hạn tìm kiếm số điện thoại trong ngày.',
          limit,
          used: count,
        });
      }

      req.phoneSearchUsage = { used: count, limit };
      return next();
    } catch (err) {
      // If the limiter table is missing or DB is down, fail open with a log.
      // We'd rather degrade gracefully than block a legitimate user.
      logger.warn('phone_search.rate_limit_failed', { user_id: userId, err });
      return next();
    }
  };
}

module.exports = { phoneSearchRateLimit };
