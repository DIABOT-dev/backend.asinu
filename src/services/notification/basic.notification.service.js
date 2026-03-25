/**
 * Basic Notification Service — rule-based notifications with HH:MM support
 *
 * 3 time slots: morning / afternoon / evening
 * Personalized: name, symptoms, conditions
 * HH:MM matching: uses morning_time/afternoon_time/evening_time with hour fallback
 *
 * Called by cron every hour. Each function filters users by their effective hour.
 */

const { sendPushNotification } = require('./push.notification.service');
const { runCheckinFollowUps, runMorningCheckin, runAlertConfirmationFollowUps } = require('../checkin/checkin.service');
const { t } = require('../../i18n');

const TZ = 'Asia/Ho_Chi_Minh';

// ─── Priority map ────────────────────────────────────────────────
const TYPE_PRIORITY = {
  emergency: 'critical',
  checkin_followup_urgent: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  morning_checkin: 'medium',
  care_circle_invitation: 'medium',
  care_circle_accepted: 'medium',
  reminder_glucose: 'medium',
  reminder_bp: 'medium',
  reminder_medication: 'medium',
  reminder_afternoon: 'low',
  reminder_morning: 'low',
  evening_checkin: 'low',
  caregiver_confirmed: 'low',
  milestone: 'low',
  streak_start: 'low',
  streak_milestone: 'low',
  weekly_recap: 'low',
  engagement: 'low',
};

// ─── Exact HH:MM match helpers ────────────────────────────────────
// Matches both hour AND minute so notifications fire at the exact configured time.
// When no time is set (NULL), falls back to default HH:00.
const morningMatch = (defH = 8) => `
  COALESCE(EXTRACT(HOUR   FROM np.morning_time::time)::int, np.morning_hour, np.inferred_morning_hour, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM np.morning_time::time)::int, 0) = $2`;
const afternoonMatch = (defH = 14) => `
  COALESCE(EXTRACT(HOUR   FROM np.afternoon_time::time)::int, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM np.afternoon_time::time)::int, 0) = $2`;
const eveningMatch = (defH = 21) => `
  COALESCE(EXTRACT(HOUR   FROM np.evening_time::time)::int, np.evening_hour, np.inferred_evening_hour, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM np.evening_time::time)::int, 0) = $2`;
const remindersEnabled = () => `COALESCE(np.reminders_enabled, true) = true`;

function nowVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

// ─── Core dispatch ─────────────────────────────────────────────────

/**
 * Core dispatch: send push + save in-app notification.
 * Accepts either a user object (with .id and .push_token) or a plain userId (number).
 * Optional `overridePriority` lets callers (e.g. NotificationOrchestrator) set priority explicitly.
 */
async function sendAndSave(pool, userOrId, type, title, body, data = {}, overridePriority = null) {
  const isObject = typeof userOrId === 'object' && userOrId !== null;
  const userId = isObject ? userOrId.id : userOrId;
  const pushToken = isObject ? userOrId.push_token : null;

  const priority = overridePriority || TYPE_PRIORITY[type] || 'low';

  const tasks = [
    pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, type, title, body, JSON.stringify(data), priority]
    ),
  ];
  if (pushToken) {
    tasks.push(sendPushNotification([pushToken], title, body, { type, ...data }));
  }

  const results = await Promise.allSettled(tasks);
  // Return true if push was sent successfully (or no push needed)
  if (!pushToken) return true;
  const pushResult = results[1];
  return pushResult?.status === 'fulfilled' && pushResult?.value?.ok;
}

// ─── Personalization helpers ──────────────────────────────────────

function getUserName(user) {
  return user.display_name || user.full_name || '';
}

function getGreeting(lang, hour) {
  if (hour < 12) return lang === 'en' ? 'Good morning' : 'Chào buổi sáng';
  if (hour < 18) return lang === 'en' ? 'Good afternoon' : 'Chào buổi chiều';
  return lang === 'en' ? 'Good evening' : 'Chào buổi tối';
}

// ─── User query with name + conditions + last checkin ─────────────

const USER_SELECT = `
  SELECT u.id, u.push_token,
         COALESCE(u.language_preference,'vi') AS lang,
         u.display_name, u.full_name,
         uop.medical_conditions,
         (SELECT triage_summary FROM health_checkins hc
          WHERE hc.user_id = u.id AND hc.triage_summary IS NOT NULL
          ORDER BY hc.session_date DESC LIMIT 1) AS last_symptom
  FROM users u
  JOIN user_onboarding_profiles uop ON uop.user_id = u.id
  LEFT JOIN user_notification_preferences np ON np.user_id = u.id
  WHERE u.push_token IS NOT NULL
    AND u.deleted_at IS NULL
    AND uop.onboarding_completed_at IS NOT NULL
    AND ${remindersEnabled()}`;

const NOT_SENT_TODAY = (type) => `
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = u.id AND n.type = '${type}'
        AND DATE(n.created_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
    )`;

const NO_LOG_TODAY = (logType = null) => logType
  ? `AND NOT EXISTS (
      SELECT 1 FROM logs_common lc
      WHERE lc.user_id = u.id AND lc.log_type = '${logType}'
        AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
    )`
  : `AND NOT EXISTS (
      SELECT 1 FROM logs_common lc
      WHERE lc.user_id = u.id
        AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
    )`;

// ─── 1. Morning log reminder ──────────────────────────────────────

async function runMorningLog(pool, hour, minute) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${morningMatch(8)}
    ${NOT_SENT_TODAY('reminder_log_morning')}
    ${NO_LOG_TODAY()}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const greeting = getGreeting(user.lang, hour);
    const title = user.lang === 'en'
      ? `${greeting}${name ? ', ' + name : ''}!`
      : `${greeting}${name ? ' ' + name : ''}!`;
    const body = user.last_symptom
      ? (user.lang === 'en'
        ? `How are you feeling today? Yesterday: ${user.last_symptom}. Log your health stats.`
        : `Hôm nay bạn thế nào? Hôm qua: ${user.last_symptom}. Hãy ghi lại chỉ số sức khỏe.`)
      : t('push.reminder_log_morning_body', user.lang);
    if (await sendAndSave(pool, user, 'reminder_log_morning', title, body)) sent++;
  }
  return { type: 'morning_log', total: rows.length, sent };
}

// ─── 2. Afternoon reminder (NEW — uses afternoon_time) ───────────

async function runAfternoon(pool, hour, minute) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${afternoonMatch(14)}
    ${NOT_SENT_TODAY('reminder_afternoon')}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const title = user.lang === 'en'
      ? `Afternoon check${name ? ', ' + name : ''}`
      : `Nhắc buổi chiều${name ? ' ' + name : ''}`;
    const conditions = parseConditions(user.medical_conditions);
    let body;
    if (conditions.hasDiabetes) {
      body = user.lang === 'en'
        ? 'Have you had enough water? Check your blood sugar if needed.'
        : 'Bạn đã uống đủ nước chưa? Nhớ kiểm tra đường huyết nếu cần.';
    } else if (conditions.hasHypertension) {
      body = user.lang === 'en'
        ? 'Stay hydrated and take a moment to rest if you feel tired.'
        : 'Nhớ uống đủ nước và nghỉ ngơi nếu thấy mệt nhé.';
    } else {
      body = user.lang === 'en'
        ? 'How are you this afternoon? Stay hydrated and take care of yourself.'
        : 'Buổi chiều bạn thế nào? Nhớ uống nước và chăm sóc bản thân nhé.';
    }
    if (await sendAndSave(pool, user, 'reminder_afternoon', title, body)) sent++;
  }
  return { type: 'afternoon', total: rows.length, sent };
}

// ─── 3. Evening log reminder ──────────────────────────────────────

async function runEveningLog(pool, hour, minute) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${eveningMatch(21)}
    ${NOT_SENT_TODAY('reminder_log_evening')}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const greeting = getGreeting(user.lang, hour);
    const title = user.lang === 'en'
      ? `${greeting}${name ? ', ' + name : ''}`
      : `${greeting}${name ? ' ' + name : ''}`;
    const body = user.last_symptom
      ? (user.lang === 'en'
        ? `End your day with a health update. Recent: ${user.last_symptom}`
        : `Hãy cập nhật sức khỏe cuối ngày. Gần đây: ${user.last_symptom}`)
      : t('push.reminder_log_evening_body', user.lang);
    if (await sendAndSave(pool, user, 'reminder_log_evening', title, body)) sent++;
  }
  return { type: 'evening_log', total: rows.length, sent };
}

// ─── 4. Glucose reminder — diabetes only ─────────────────────────

async function runGlucose(pool, hour, minute) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${morningMatch(8)}
    AND (
      LOWER(uop.medical_conditions::text) LIKE '%ti%u đường%'
      OR LOWER(uop.medical_conditions::text) LIKE '%diabetes%'
      OR LOWER(uop.raw_profile::text) LIKE '%ti%u đường%'
      OR LOWER(uop.raw_profile::text) LIKE '%diabetes%'
    )
    ${NOT_SENT_TODAY('reminder_glucose')}
    ${NO_LOG_TODAY('glucose')}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const title = user.lang === 'en'
      ? `Blood glucose check${name ? ', ' + name : ''}`
      : `Nhắc đo đường huyết${name ? ' ' + name : ''}`;
    if (await sendAndSave(pool, user, 'reminder_glucose', title,
      t('push.reminder_glucose_body', user.lang))) sent++;
  }
  return { type: 'glucose', total: rows.length, sent };
}

// ─── 5. Blood pressure reminder — hypertension only ──────────────

async function runBP(pool, hour, minute) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${morningMatch(8)}
    AND (
      LOWER(uop.medical_conditions::text) LIKE '%huy%t áp%'
      OR LOWER(uop.medical_conditions::text) LIKE '%hypertension%'
      OR LOWER(uop.medical_conditions::text) LIKE '%blood pressure%'
      OR LOWER(uop.raw_profile::text) LIKE '%huy%t áp%'
      OR LOWER(uop.raw_profile::text) LIKE '%hypertension%'
    )
    ${NOT_SENT_TODAY('reminder_bp')}
    ${NO_LOG_TODAY('blood_pressure')}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const title = user.lang === 'en'
      ? `Blood pressure check${name ? ', ' + name : ''}`
      : `Nhắc đo huyết áp${name ? ' ' + name : ''}`;
    if (await sendAndSave(pool, user, 'reminder_bp', title,
      t('push.reminder_bp_body', user.lang))) sent++;
  }
  return { type: 'bp', total: rows.length, sent };
}

// ─── 6. Medication reminder ───────────────────────────────────────

async function runMedication(pool, slot, hour, minute) {
  const type = `reminder_medication_${slot}`;
  const timeMatch = slot === 'morning' ? morningMatch(8) : eveningMatch(21);

  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND ${timeMatch}
    AND uop.medical_conditions::text != '[]'
    ${NOT_SENT_TODAY(type)}
    ${NO_LOG_TODAY('medication')}
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const slotLabel = slot === 'morning'
      ? (user.lang === 'en' ? 'morning' : 'sáng')
      : (user.lang === 'en' ? 'evening' : 'tối');
    const title = user.lang === 'en'
      ? `${slotLabel.charAt(0).toUpperCase() + slotLabel.slice(1)} medication${name ? ', ' + name : ''}`
      : `Nhắc thuốc buổi ${slotLabel}${name ? ' ' + name : ''}`;
    const body = user.lang === 'en'
      ? `Remember to take your ${slotLabel} medication on time.`
      : `Nhớ uống thuốc buổi ${slotLabel} đúng giờ nhé.`;
    if (await sendAndSave(pool, user, type, title, body)) sent++;
  }
  return { type, total: rows.length, sent };
}

// ─── 7. Streak milestones ─────────────────────────────────────────

const STREAK_MILESTONES = [7, 14, 30];

async function getUserStreak(pool, userId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT DATE(occurred_at AT TIME ZONE '${TZ}') AS log_date
    FROM logs_common WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '35 days'
    ORDER BY log_date DESC
  `, [userId]);
  if (!rows.length) return 0;
  const today = nowVN(); today.setHours(0, 0, 0, 0);
  let streak = 0, expected = new Date(today);
  for (const r of rows) {
    const d = new Date(r.log_date); d.setHours(0, 0, 0, 0);
    if (d.getTime() === expected.getTime()) { streak++; expected.setDate(expected.getDate() - 1); }
    else if (d < expected) break;
  }
  return streak;
}

async function runStreakMilestones(pool, hour, minute) {
  const { rows: activeUsers } = await pool.query(`
    ${USER_SELECT}
    AND ${morningMatch(8)}
  `, [hour, minute]);

  let sent = 0;
  for (const user of activeUsers) {
    const streak = await getUserStreak(pool, user.id);
    if (!STREAK_MILESTONES.includes(streak)) continue;
    const type = `streak_${streak}`;
    const { rows: already } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id=$1 AND type=$2 AND created_at >= NOW() - INTERVAL '25 days'`,
      [user.id, type]
    );
    if (already.length) continue;
    const name = getUserName(user);
    const title = user.lang === 'en'
      ? `${streak}-day streak${name ? ', ' + name : ''}! 🎉`
      : `Chuỗi ${streak} ngày${name ? ' ' + name : ''}! 🎉`;
    const body = user.lang === 'en'
      ? `Amazing! You've logged health data for ${streak} days in a row. Keep it up!`
      : `Tuyệt vời! Bạn đã ghi log ${streak} ngày liên tục. Hãy tiếp tục phát huy!`;
    if (await sendAndSave(pool, user, type, title, body, { streak })) sent++;
  }
  return { type: 'streak', total: activeUsers.length, sent };
}

// ─── 8. Weekly recap — Sunday 20:00 ──────────────────────────────

async function runWeeklyRecap(pool) {
  const { rows } = await pool.query(`
    ${USER_SELECT}
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = u.id AND n.type = 'weekly_recap' AND n.created_at >= NOW() - INTERVAL '6 days'
    )
  `);

  // Get days logged per user
  let sent = 0;
  for (const user of rows) {
    const { rows: logDays } = await pool.query(
      `SELECT COUNT(DISTINCT DATE(occurred_at AT TIME ZONE '${TZ}'))::int AS days
       FROM logs_common WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '7 days'`,
      [user.id]
    );
    const days = logDays[0]?.days || 0;
    const name = getUserName(user);
    const title = user.lang === 'en'
      ? `Weekly health summary${name ? ', ' + name : ''}`
      : `Tổng kết tuần${name ? ' ' + name : ''}`;
    let body;
    if (days === 7) {
      body = user.lang === 'en'
        ? `Perfect week! You logged health data all 7 days. Outstanding commitment!`
        : `Tuần hoàn hảo! Bạn đã ghi log đủ 7/7 ngày. Tuyệt vời!`;
    } else if (days >= 5) {
      body = user.lang === 'en'
        ? `Great week! ${days}/7 days logged. Almost perfect!`
        : `Tuần tốt! ${days}/7 ngày đã ghi log. Gần hoàn hảo!`;
    } else if (days >= 3) {
      body = user.lang === 'en'
        ? `${days}/7 days logged this week. Try to log a bit more next week!`
        : `${days}/7 ngày đã ghi log tuần này. Cố gắng thêm tuần sau nhé!`;
    } else {
      body = user.lang === 'en'
        ? `Only ${days}/7 days logged. Your health matters — let's do better next week!`
        : `Mới ${days}/7 ngày ghi log. Sức khỏe của bạn quan trọng — tuần sau cố gắng hơn nhé!`;
    }
    if (await sendAndSave(pool, user, 'weekly_recap', title, body, { days_logged: days })) sent++;
  }
  return { type: 'weekly_recap', total: rows.length, sent };
}

// ─── Condition parser ─────────────────────────────────────────────

function parseConditions(medicalConditions) {
  const text = (Array.isArray(medicalConditions) ? medicalConditions.join(' ') : String(medicalConditions || '')).toLowerCase();
  return {
    hasDiabetes: text.includes('tiểu đường') || text.includes('diabetes'),
    hasHypertension: text.includes('huyết áp') || text.includes('hypertension') || text.includes('blood pressure'),
    hasAny: text.length > 2 && text !== '[]',
  };
}

// ─── Preferred hour helper (personalized timing) ─────────────────

async function getPreferredHour(pool, userId, defaultHour) {
  try {
    const res = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as cnt
       FROM health_checkins
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
         AND no_response_count = 0
       GROUP BY hour ORDER BY cnt DESC LIMIT 1`,
      [userId]
    );
    return res.rows[0] ? parseInt(res.rows[0].hour) : defaultHour;
  } catch {
    return defaultHour;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────

async function runBasicNotifications(pool, forceHour = null, forceMinute = null) {
  const vn = nowVN();
  const hour   = forceHour   !== null ? forceHour   : vn.getHours();
  const minute = forceMinute !== null ? forceMinute : vn.getMinutes();
  const dow = vn.getDay(); // 0 = Sunday

  const jobs = [
    runMorningLog(pool, hour, minute),
    runAfternoon(pool, hour, minute),
    runEveningLog(pool, hour, minute),
    runGlucose(pool, hour, minute),
    runBP(pool, hour, minute),
    runMedication(pool, 'morning', hour, minute),
    runMedication(pool, 'evening', hour, minute),
    runStreakMilestones(pool, hour, minute),
    runMorningCheckin(pool, hour),
    runCheckinFollowUps(pool),
    runAlertConfirmationFollowUps(pool),
    ...(hour === 20 && minute === 0 && dow === 0 ? [runWeeklyRecap(pool)] : []),
  ];

  const results = await Promise.all(jobs);
  const totalSent = results.reduce((s, r) => s + (r.sent || 0), 0);
  const totalEligible = results.reduce((s, r) => s + (r.total || 0), 0);

  return { ok: true, hour, minute, results, totalSent, totalEligible };
}

module.exports = { runBasicNotifications, sendAndSave, getPreferredHour };
