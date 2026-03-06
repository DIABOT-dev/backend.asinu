/**
 * Basic Notification Service — 8 hard-coded rule-based notifications
 *
 * Rules:
 *  1. Morning log reminder  — 08:00, no logs today
 *  2. Evening log reminder  — 21:00, < 2 logs today
 *  3. Water reminder        — 14:00, no water log today
 *  4. Glucose reminder      — 07:00, has diabetes, no glucose log today
 *  5. BP reminder           — 07:00, has hypertension, no BP log today
 *  6. Medication reminder   — 08:00 + 20:00, has conditions, no medication log today
 *  7. Streak milestone      — 08:00, streak hits 7 / 14 / 30 days
 *  8. Weekly recap          — Sunday 20:00, always
 *
 * Called by cron: POST /api/notifications/basic/run
 * Cron runs every hour — this service decides what to send based on Vietnam time.
 */

const { sendPushNotification } = require('./push.notification.service');
const { t } = require('../i18n');

const TZ = 'Asia/Ho_Chi_Minh';

// ─── Timezone helpers ──────────────────────────────────────────────

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

// ─── 1. Morning log reminder — 08:00 ─────────────────────────────

async function runMorningLog(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
  `);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_log_morning',
      t('push.reminder_log_morning_title', user.lang),
      t('push.reminder_log_morning_body', user.lang)
    )) sent++;
  }
  return { type: 'morning_log', total: rows.length, sent };
}

// ─── 2. Evening log reminder — 21:00 ─────────────────────────────

async function runEveningLog(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
  `);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_log_evening',
      t('push.reminder_log_evening_title', user.lang),
      t('push.reminder_log_evening_body', user.lang)
    )) sent++;
  }
  return { type: 'evening_log', total: rows.length, sent };
}

// ─── 3. Water reminder — 14:00 ────────────────────────────────────

async function runWater(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
  `);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_water',
      t('push.reminder_water_title', user.lang),
      t('push.reminder_water_body', user.lang)
    )) sent++;
  }
  return { type: 'water', total: rows.length, sent };
}

// ─── 4. Glucose reminder — 07:00 — diabetes only ──────────────────

async function runGlucose(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
  `);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_glucose',
      t('push.reminder_glucose_title', user.lang),
      t('push.reminder_glucose_body', user.lang)
    )) sent++;
  }
  return { type: 'glucose', total: rows.length, sent };
}

// ─── 5. Blood pressure reminder — 07:00 — hypertension only ───────

async function runBP(pool) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
  `);

  let sent = 0;
  for (const user of rows) {
    if (await sendAndSave(pool, user, 'reminder_bp',
      t('push.reminder_bp_title', user.lang),
      t('push.reminder_bp_body', user.lang)
    )) sent++;
  }
  return { type: 'bp', total: rows.length, sent };
}

// ─── 6. Medication reminder — 08:00 + 20:00 ───────────────────────

async function runMedication(pool, slot) {
  // slot: 'morning' | 'evening'
  const type = `reminder_medication_${slot}`;

  const { rows } = await pool.query(`
    SELECT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND uop.medical_conditions::text != '[]'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = $1
          AND DATE(n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
      AND NOT EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id AND lc.log_type = 'medication'
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `, [type]);

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

// ─── 7. Streak milestones — 08:00 ────────────────────────────────

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

async function runStreakMilestones(pool) {
  // Only check users who logged today
  const { rows: activeUsers } = await pool.query(`
    SELECT DISTINCT u.id, u.push_token, COALESCE(u.language_preference,'vi') AS lang
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM logs_common lc
        WHERE lc.user_id = u.id
          AND DATE(lc.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )
  `);

  let sent = 0;
  for (const user of activeUsers) {
    const streak = await getUserStreak(pool, user.id);
    if (!STREAK_MILESTONES.includes(streak)) continue;

    const notifType = `streak_${streak}`;
    // Check not already sent for this milestone
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

// ─── 8. Weekly recap — Sunday 20:00 ──────────────────────────────

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
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
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
 * Chạy các thông báo cứng dựa trên giờ hiện tại (múi giờ Việt Nam).
 * Cron gọi mỗi giờ — service tự quyết định loại nào cần chạy.
 * @param {object} pool - pg Pool
 * @param {number|null} forceHour - Bỏ qua giờ thực, dùng giờ này (để test)
 */
async function runBasicNotifications(pool, forceHour = null) {
  const vn   = nowVN();
  const hour = forceHour !== null ? forceHour : vn.getHours();
  const dow  = vn.getDay(); // 0 = Sunday

  const results = [];

  if (hour === 7) {
    results.push(await runGlucose(pool));
    results.push(await runBP(pool));
  }

  if (hour === 8) {
    results.push(await runMorningLog(pool));
    results.push(await runMedication(pool, 'morning'));
    results.push(await runStreakMilestones(pool));
  }

  if (hour === 14) {
    results.push(await runWater(pool));
  }

  if (hour === 20) {
    results.push(await runMedication(pool, 'evening'));
    if (dow === 0) {
      results.push(await runWeeklyRecap(pool));
    }
  }

  if (hour === 21) {
    results.push(await runEveningLog(pool));
  }

  const totalSent    = results.reduce((s, r) => s + (r.sent  || 0), 0);
  const totalEligible = results.reduce((s, r) => s + (r.total || 0), 0);

  return { ok: true, hour, results, totalSent, totalEligible };
}

module.exports = { runBasicNotifications };
