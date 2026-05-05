/**
 * Lifecycle Notifications — daily cron
 *
 * Bao gồm:
 *  - subscription_expiring_soon (3 ngày trước hết hạn, dedup theo expires_at)
 *  - subscription_expired (sau khi hết hạn, một lần duy nhất)
 *  - weekly_wellness_summary (Chủ nhật)
 *  - profile_incomplete (3 ngày sau signup, chỉ 1 lần)
 */

const { sendAndSave } = require('./basic.notification.service');
const { t } = require('../../i18n');

const EXPIRING_DAYS_BEFORE = 3;
const PROFILE_INCOMPLETE_DAYS_AFTER_SIGNUP = 3;

/**
 * Notify Premium users whose subscription expires in EXPIRING_DAYS_BEFORE days.
 * Dedup via notifications table (same-type 24h check).
 */
async function runSubscriptionExpiringSoon(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.push_token, u.subscription_expires_at,
            COALESCE(u.language_preference, 'vi') AS lang
     FROM users u
     WHERE u.subscription_tier = 'premium'
       AND u.subscription_expires_at IS NOT NULL
       AND u.subscription_expires_at > NOW()
       AND u.subscription_expires_at <= NOW() + INTERVAL '${EXPIRING_DAYS_BEFORE} days'
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = u.id
           AND n.type = 'subscription_expiring_soon'
           AND n.created_at >= NOW() - INTERVAL '24 hours'
       )`
  );

  let sent = 0;
  for (const u of rows) {
    const lang = u.lang;
    const days = Math.max(1, Math.ceil((new Date(u.subscription_expires_at) - new Date()) / (24 * 60 * 60 * 1000)));
    const ok = await sendAndSave(
      pool, { id: u.id, push_token: u.push_token }, 'subscription_expiring_soon',
      t('push.subscription_expiring_title', lang),
      t('push.subscription_expiring_body', lang, { days }),
      { expiresAt: new Date(u.subscription_expires_at).toISOString(), days: String(days) }
    );
    if (ok) sent++;
  }
  return { checked: rows.length, sent };
}

/**
 * Notify users whose Premium just expired (within last 24 hours), once.
 * Note: backend logic should already downgrade them at expires_at.
 */
async function runSubscriptionExpired(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.push_token, COALESCE(u.language_preference, 'vi') AS lang
     FROM users u
     WHERE u.subscription_expires_at IS NOT NULL
       AND u.subscription_expires_at <= NOW()
       AND u.subscription_expires_at >= NOW() - INTERVAL '24 hours'
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = u.id
           AND n.type = 'subscription_expired'
           AND n.created_at >= u.subscription_expires_at
       )`
  );

  let sent = 0;
  for (const u of rows) {
    const lang = u.lang;
    const ok = await sendAndSave(
      pool, { id: u.id, push_token: u.push_token }, 'subscription_expired',
      t('push.subscription_expired_title', lang),
      t('push.subscription_expired_body', lang),
      {}
    );
    if (ok) sent++;
  }
  return { checked: rows.length, sent };
}

/**
 * Weekly wellness summary — Sunday 19:00 VN.
 * Counts logs from last 7 days. Skip users with 0 logs to avoid noise.
 */
async function runWeeklyWellnessSummary(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.push_token,
            COALESCE(u.display_name, u.full_name, u.email) AS name,
            COALESCE(u.language_preference, 'vi') AS lang,
            COALESCE((
              SELECT COUNT(*) FROM logs l
              WHERE l.user_id = u.id
                AND l.created_at >= NOW() - INTERVAL '7 days'
            ), 0) AS log_count
     FROM users u
     WHERE u.deleted_at IS NULL
       AND u.push_token IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = u.id
           AND n.type = 'weekly_wellness_summary'
           AND n.created_at >= NOW() - INTERVAL '6 days'
       )`
  );

  let sent = 0;
  for (const u of rows) {
    if (Number(u.log_count) === 0) continue; // Skip users with no activity
    const lang = u.lang;
    const shortName = (u.name || '').split(/\s+/).pop() || u.name || '';
    const ok = await sendAndSave(
      pool, { id: u.id, push_token: u.push_token }, 'weekly_wellness_summary',
      t('push.weekly_wellness_title', lang),
      t('push.weekly_wellness_body', lang, { name: shortName, count: u.log_count }),
      { weekLogs: String(u.log_count) }
    );
    if (ok) sent++;
  }
  return { checked: rows.length, sent };
}

/**
 * Profile incomplete reminder — 3 days after signup, once.
 * Definition of incomplete: missing display_name OR no onboarding profile row.
 */
async function runProfileIncomplete(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.push_token, COALESCE(u.language_preference, 'vi') AS lang
     FROM users u
     LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
     WHERE u.deleted_at IS NULL
       AND u.created_at <= NOW() - INTERVAL '${PROFILE_INCOMPLETE_DAYS_AFTER_SIGNUP} days'
       AND u.created_at >= NOW() - INTERVAL '${PROFILE_INCOMPLETE_DAYS_AFTER_SIGNUP + 1} days'
       AND (u.display_name IS NULL OR uop.user_id IS NULL OR uop.gender IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = u.id AND n.type = 'profile_incomplete'
       )`
  );

  let sent = 0;
  for (const u of rows) {
    const lang = u.lang;
    const ok = await sendAndSave(
      pool, { id: u.id, push_token: u.push_token }, 'profile_incomplete',
      t('push.profile_incomplete_title', lang),
      t('push.profile_incomplete_body', lang),
      {}
    );
    if (ok) sent++;
  }
  return { checked: rows.length, sent };
}

/**
 * Run all daily lifecycle notifications. Call once per day.
 */
async function runDailyLifecycleNotifications(pool, { dayOfWeek = null } = {}) {
  const results = {
    expiringSoon: await runSubscriptionExpiringSoon(pool).catch(e => ({ error: e.message })),
    expired: await runSubscriptionExpired(pool).catch(e => ({ error: e.message })),
    profileIncomplete: await runProfileIncomplete(pool).catch(e => ({ error: e.message })),
  };
  // Weekly summary only on Sunday (dayOfWeek=0)
  if (dayOfWeek === 0) {
    results.weeklyWellness = await runWeeklyWellnessSummary(pool).catch(e => ({ error: e.message }));
  }
  return results;
}

module.exports = {
  runSubscriptionExpiringSoon,
  runSubscriptionExpired,
  runWeeklyWellnessSummary,
  runProfileIncomplete,
  runDailyLifecycleNotifications,
};
