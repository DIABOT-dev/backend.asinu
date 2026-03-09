/**
 * Basic Notification Service — 8 rule-based notifications
 *
 * Rules:
 *  1. Morning log reminder  — user's morning_hour (default 08:00), no logs today
 *  2. Evening log reminder  — user's evening_hour (default 21:00), < 2 logs today
 *  3. Water reminder        — user's water_hour (default 14:00), no water log today
 *  4. Glucose reminder      — user's morning_hour (default 08:00), diabetes, no glucose today
 *  5. BP reminder           — user's morning_hour (default 08:00), hypertension, no BP today
 *  6. Medication reminder   — user's morning_hour + evening_hour, has conditions, no med log
 *  7. Streak milestone      — user's morning_hour (default 08:00), streak hits 7/14/30
 *  8. Weekly recap          — Sunday 20:00 (fixed, not personalized)
 *
 * Called by cron every hour. Each function filters users by their effective hour
 * (user-set → auto-inferred from behavior → system default).
 */

const { sendPushNotification } = require('./push.notification.service');
const { runCheckinFollowUps, runMorningCheckin, runAlertConfirmationFollowUps } = require('./checkin.service');
const { t } = require('../i18n');

const TZ = 'Asia/Ho_Chi_Minh';

// Effective-hour SQL snippet helpers
// COALESCE(user-set, inferred, default) = $N
const morningHourExpr  = (def = 8)  => `COALESCE(np.morning_hour, np.inferred_morning_hour, ${def})`;
const eveningHourExpr  = (def = 21) => `COALESCE(np.evening_hour, np.inferred_evening_hour, ${def})`;
const waterHourExpr    = (def = 14) => `COALESCE(np.water_hour,   np.inferred_water_hour,   ${def})`;
// Only send reminders when user hasn't disabled task reminders (null = default true)
const remindersEnabled = () => `COALESCE(np.reminders_enabled, true) = true`;

// ─── Timezone helper ───────────────────────────────────────────────

function nowVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

// ─── Core dispatch ─────────────────────────────────────────────────

async function sendAndSave(pool, user, type, title, body, data = {}) {
  const [pushResult] = await Promise.allSettled([
    sendPushNotification([user.push_token], title, body, { type, ...data }),
    pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, type, title, body, JSON.stringify(data)]
    ),
  ]);
  return pushResult.status === 'fulfilled' && pushResult.value?.ok;
}

// ─── 1. Morning log reminder ──────────────────────────────────────

async function runMorningLog(pool, hour) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${morningHourExpr(8)} = $1
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_log_morning'
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour]);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_log_morning',
      t('push.reminder_log_morning_title', user.lang),
      t('push.reminder_log_morning_body',  user.lang)
    )) sent++;
  }
  return { type: 'morning_log', total: rows.length, sent };
}

// ─── 2. Evening log reminder ──────────────────────────────────────

async function runEveningLog(pool, hour) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${eveningHourExpr(21)} = $1
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_log_evening'
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND (
        SELECT COUNT(*) FROM logs_common lc
        WHERE lc.user_id = u.id
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      ) < 2
  `, [hour]);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_log_evening',
      t('push.reminder_log_evening_title', user.lang),
      t('push.reminder_log_evening_body',  user.lang)
    )) sent++;
  }
  return { type: 'evening_log', total: rows.length, sent };
}

// ─── 3. Water reminder ────────────────────────────────────────────

async function runWater(pool, hour) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${waterHourExpr(14)} = $1
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_water'
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id AND lc.log_type = 'water'
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour]);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_water',
      t('push.reminder_water_title', user.lang),
      t('push.reminder_water_body',  user.lang)
    )) sent++;
  }
  return { type: 'water', total: rows.length, sent };
}

// ─── 4. Glucose reminder — diabetes only ─────────────────────────

async function runGlucose(pool, hour) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${morningHourExpr(8)} = $1
      AND (
        LOWER(uop.medical_conditions::text) LIKE '%ti%u đường%'
        OR LOWER(uop.medical_conditions::text) LIKE '%diabetes%'
        OR LOWER(uop.raw_profile::text)       LIKE '%ti%u đường%'
        OR LOWER(uop.raw_profile::text)       LIKE '%diabetes%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_glucose'
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id AND lc.log_type = 'glucose'
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour]);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_glucose',
      t('push.reminder_glucose_title', user.lang),
      t('push.reminder_glucose_body',  user.lang)
    )) sent++;
  }
  return { type: 'glucose', total: rows.length, sent };
}

// ─── 5. Blood pressure reminder — hypertension only ──────────────

async function runBP(pool, hour) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${morningHourExpr(8)} = $1
      AND (
        LOWER(uop.medical_conditions::text) LIKE '%huy%t áp%'
        OR LOWER(uop.medical_conditions::text) LIKE '%hypertension%'
        OR LOWER(uop.medical_conditions::text) LIKE '%blood pressure%'
        OR LOWER(uop.raw_profile::text)       LIKE '%huy%t áp%'
        OR LOWER(uop.raw_profile::text)       LIKE '%hypertension%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_bp'
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id AND lc.log_type = 'blood_pressure'
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour]);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_bp',
      t('push.reminder_bp_title', user.lang),
      t('push.reminder_bp_body',  user.lang)
    )) sent++;
  }
  return { type: 'bp', total: rows.length, sent };
}

// ─── 6. Medication reminder ───────────────────────────────────────

async function runMedication(pool, slot, hour) {
  const type      = `reminder_medication_${slot}`;
  const hourExpr  = slot === 'morning' ? morningHourExpr(8) : eveningHourExpr(21);

  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${hourExpr} = $1
      AND uop.medical_conditions::text != '[]'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = $2
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id AND lc.log_type = 'medication'
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour, type]);

  let sent = 0;
  for (const user of rows) {
    const titleKey = slot === 'morning' ? 'push.reminder_medication_morning_title' : 'push.reminder_medication_evening_title';
    const bodyKey  = slot === 'morning' ? 'push.reminder_medication_morning_body'  : 'push.reminder_medication_evening_body';
    if (await sendAndSave(pool, user, type,
      t(titleKey, user.lang),
      t(bodyKey,  user.lang)
    )) sent++;
  }
  return { type, total: rows.length, sent };
}

// ─── 7. Streak milestones ─────────────────────────────────────────

const STREAK_MILESTONES = [7, 14, 30];

async function getUserStreak(pool, userId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT DATE(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS log_date
    FROM logs_common
    WHERE user_id = $1
      AND occurred_at >= NOW() - INTERVAL '35 days'
    ORDER BY log_date DESC
  `, [userId]);

  if (!rows.length) return 0;

  const today = nowVN();
  today.setHours(0, 0, 0, 0);

  let streak = 0;
  let expected = new Date(today);

  for (const row of rows) {
    const logDate = new Date(row.log_date);
    logDate.setHours(0, 0, 0, 0);
    if (logDate.getTime() === expected.getTime()) {
      streak++;
      expected.setDate(expected.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

async function runStreakMilestones(pool, hour) {
  const { rows: activeUsers } = await pool.query(`
    SELECT DISTINCT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${morningHourExpr(8)} = $1
      AND EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [hour]);

  let sent = 0;
  for (const user of activeUsers) {
    const streak = await getUserStreak(pool, user.id);
    if (!STREAK_MILESTONES.includes(streak)) continue;

    const notifType = `streak_${streak}`;
    const { rows: existing } = await pool.query(`
      SELECT 1 FROM notifications
      WHERE user_id = $1 AND type = $2
        AND created_at >= NOW() - INTERVAL '${streak} days'
      LIMIT 1
    `, [user.id, notifType]);
    if (existing.length) continue;

    if (await sendAndSave(pool, user, notifType,
      t(`push.streak_${streak}_title`, user.lang),
      t(`push.streak_${streak}_body`,  user.lang),
      { streak }
    )) sent++;
  }
  return { type: 'streak', total: activeUsers.length, sent };
}

// ─── 8. Weekly recap — Sunday 20:00 (fixed) ──────────────────────

async function runWeeklyRecap(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang,
      (
        SELECT COUNT(DISTINCT DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh'))
        FROM logs_common lc
        WHERE lc.user_id = u.id
          AND lc.occurred_at >= NOW() - INTERVAL '7 days'
      ) AS days_logged
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'weekly_recap'
          AND n.created_at >= NOW() - INTERVAL '6 days'
      )
  `);

  let sent = 0;
  for (const user of rows) {
    const days = Number(user.days_logged);
    const bodyKey = days === 7  ? 'push.weekly_recap_body_7'
                  : days >= 5   ? 'push.weekly_recap_body_good'
                  : days >= 3   ? 'push.weekly_recap_body_ok'
                  :               'push.weekly_recap_body_low';
    if (await sendAndSave(pool, user, 'weekly_recap',
      t('push.weekly_recap_title', user.lang),
      t(bodyKey, user.lang, { days }),
      { days_logged: days }
    )) sent++;
  }
  return { type: 'weekly_recap', total: rows.length, sent };
}

// ─── Main orchestrator ────────────────────────────────────────────

/**
 * Chạy tất cả notifications mỗi giờ.
 * Mỗi hàm tự filter user theo effective hour của họ.
 * @param {object} pool
 * @param {number|null} forceHour - ghi đè giờ VN (để test)
 */
async function runBasicNotifications(pool, forceHour = null) {
  const vn   = nowVN();
  const hour = forceHour !== null ? forceHour : vn.getHours();
  const dow  = vn.getDay(); // 0 = Sunday

  const jobs = [
    runMorningLog(pool, hour),
    runEveningLog(pool, hour),
    runWater(pool, hour),
    runGlucose(pool, hour),
    runBP(pool, hour),
    runMedication(pool, 'morning', hour),
    runMedication(pool, 'evening', hour),
    runStreakMilestones(pool, hour),
    runMorningCheckin(pool, hour),             // 7am health check-in push
    runCheckinFollowUps(pool),                 // follow-up + escalation (every hour)
    runAlertConfirmationFollowUps(pool),       // nhắc caregiver chưa xác nhận sau 30 phút
    ...(hour === 20 && dow === 0 ? [runWeeklyRecap(pool)] : []),
  ];

  const results = await Promise.all(jobs);

  const totalSent     = results.reduce((s, r) => s + (r.sent  || 0), 0);
  const totalEligible = results.reduce((s, r) => s + (r.total || 0), 0);

  return { ok: true, hour, results, totalSent, totalEligible };
}

module.exports = { runBasicNotifications };
