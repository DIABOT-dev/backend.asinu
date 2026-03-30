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
  COALESCE(EXTRACT(HOUR   FROM np.afternoon_time::time)::int, EXTRACT(HOUR   FROM np.inferred_afternoon_time::time)::int, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM np.afternoon_time::time)::int, EXTRACT(MINUTE FROM np.inferred_afternoon_time::time)::int, 0) = $2`;
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
// Reminder types that should be spaced apart (5 min gap between any two)
const REMINDER_TYPES = new Set([
  'reminder_morning_summary', 'reminder_afternoon', 'reminder_evening_summary',
  'reminder_log_morning', 'reminder_log_evening',
  'reminder_glucose', 'reminder_bp', 'reminder_medication_morning', 'reminder_medication_evening',
  'morning_checkin', 'streak_7', 'streak_14', 'streak_30', 'weekly_recap',
]);
const CROSS_TYPE_GAP_MINUTES = 5;

async function sendAndSave(pool, userOrId, type, title, body, data = {}, overridePriority = null) {
  const isObject = typeof userOrId === 'object' && userOrId !== null;
  const userId = isObject ? userOrId.id : userOrId;
  const pushToken = isObject ? userOrId.push_token : null;

  const priority = overridePriority || TYPE_PRIORITY[type] || 'low';

  // Cross-type spacing: skip if user received any reminder push in last 5 minutes
  if (REMINDER_TYPES.has(type)) {
    const { rows } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1
         AND type = ANY($2::text[])
         AND created_at >= NOW() - make_interval(mins => $3) LIMIT 1`,
      [userId, [...REMINDER_TYPES], CROSS_TYPE_GAP_MINUTES]
    );
    if (rows.length > 0) return false;
  }

  // Same-type dedup: skip if exact same type was sent to this user in the last 5 minutes
  try {
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2
         AND created_at >= NOW() - make_interval(mins => 5) LIMIT 1`,
      [userId, type]
    );
    if (dup.length > 0) {
      console.log(`[sendAndSave] Skipped ${type} for user ${userId} (same-type dedup 5min)`);
      return false;
    }
  } catch {}

  // Insert DB record FIRST, only push if insert succeeds
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, type, title, body, JSON.stringify(data), priority]
    );
  } catch (err) {
    console.error(`[sendAndSave] DB insert failed for ${type} user=${userId}:`, err.message);
    return false;
  }

  if (pushToken) {
    try {
      const result = await sendPushNotification([pushToken], title, body, { type, ...data });
      return result?.ok || false;
    } catch {
      return false;
    }
  }
  return true;
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

// ─── 1. Morning summary (merged: log + glucose + bp + medication) ──

async function runMorningSummary(pool, hour, minute) {
  // Query all users whose morning time matches, not yet sent today
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token,
           COALESCE(u.language_preference,'vi') AS lang,
           u.display_name, u.full_name,
           uop.medical_conditions,
           (SELECT triage_summary FROM health_checkins hc
            WHERE hc.user_id = u.id AND hc.triage_summary IS NOT NULL
            ORDER BY hc.session_date DESC LIMIT 1) AS last_symptom,
           (SELECT lg.value FROM glucose_logs lg
            JOIN logs_common lc ON lc.id = lg.log_id
            WHERE lc.user_id = u.id ORDER BY lc.occurred_at DESC LIMIT 1) AS last_glucose,
           (SELECT lb.systolic || '/' || lb.diastolic FROM blood_pressure_logs lb
            JOIN logs_common lc ON lc.id = lb.log_id
            WHERE lc.user_id = u.id ORDER BY lc.occurred_at DESC LIMIT 1) AS last_bp,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
           ) AS no_log_today,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id AND lc.log_type = 'glucose'
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
           ) AS no_glucose_today,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id AND lc.log_type = 'blood_pressure'
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
           ) AS no_bp_today,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id AND lc.log_type = 'medication'
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
           ) AS no_medication_today
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${morningMatch(8)}
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_morning_summary'
          AND DATE(n.created_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
      )
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const greeting = getGreeting(user.lang, hour);
    const conditions = parseConditions(user.medical_conditions);
    const isEn = user.lang === 'en';

    // Build task list based on what user needs to do today
    const tasks = [];
    if (conditions.hasDiabetes && user.no_glucose_today) {
      const prev = user.last_glucose ? (isEn ? ` (last: ${user.last_glucose})` : ` (gần nhất: ${user.last_glucose})`) : '';
      tasks.push(isEn ? `blood glucose 🩸${prev}` : `đo đường huyết 🩸${prev}`);
    }
    if (conditions.hasHypertension && user.no_bp_today) {
      const prev = user.last_bp ? (isEn ? ` (last: ${user.last_bp})` : ` (gần nhất: ${user.last_bp})`) : '';
      tasks.push(isEn ? `blood pressure 💓${prev}` : `đo huyết áp 💓${prev}`);
    }
    if (conditions.hasAny && user.no_medication_today) {
      tasks.push(isEn ? 'take medication 💊' : 'uống thuốc 💊');
    }
    if (user.no_log_today && tasks.length === 0) {
      tasks.push(isEn ? 'log your health stats 📋' : 'ghi chỉ số sức khỏe 📋');
    }

    // Skip if nothing to remind
    if (tasks.length === 0) continue;

    const title = isEn
      ? `☀️ ${greeting}${name ? ' ' + name : ''}!`
      : `☀️ ${greeting}${name ? ' ' + name : ''}!`;

    let body;
    if (user.last_symptom) {
      body = isEn
        ? `Yesterday you mentioned ${user.last_symptom} — how are you feeling today? Don't forget: ${tasks.join(', ')}. Asinu is here for you 💙`
        : `Hôm qua bạn có nói bị ${user.last_symptom} — hôm nay thấy đỡ hơn chưa? Nhớ ${tasks.join(', ')} nha. Asinu luôn bên bạn 💙`;
    } else {
      body = isEn
        ? `A new day begins! Let's take care of your health together: ${tasks.join(', ')}. You're doing great 💪`
        : `Ngày mới rồi! Mình cùng chăm sóc sức khoẻ nhé: ${tasks.join(', ')}. Bạn đang làm rất tốt 💪`;
    }

    // Build missing types for deep link
    const missingTypes = [];
    if (conditions.hasDiabetes && user.no_glucose_today) missingTypes.push('glucose');
    if (conditions.hasHypertension && user.no_bp_today) missingTypes.push('blood_pressure');
    if (conditions.hasAny && user.no_medication_today) missingTypes.push('medication');

    if (await sendAndSave(pool, user, 'reminder_morning_summary', title, body, {
      type: 'reminder_morning_summary',
      missingTypes,
      firstMissing: missingTypes[0] || 'checkin',
    })) sent++;
  }
  return { type: 'morning_summary', total: rows.length, sent };
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
    const conditions = parseConditions(user.medical_conditions);
    const isEn = user.lang === 'en';
    const title = isEn
      ? `🌤️ Hey${name ? ' ' + name : ''}, afternoon check-in`
      : `🌤️ Chiều rồi${name ? ' ' + name + ' ơi' : ''}!`;
    let body;
    if (conditions.hasDiabetes) {
      body = isEn
        ? `How are you feeling this afternoon? Remember to drink water and check your blood sugar if you haven't yet. Your body will thank you 😊`
        : `Chiều nay bạn thấy thế nào? Nhớ uống nước đều đặn và kiểm tra đường huyết nếu chưa nha. Cơ thể bạn sẽ cảm ơn vì điều đó 😊`;
    } else if (conditions.hasHypertension) {
      body = isEn
        ? `Take a little break if you can — rest is just as important as medicine. Have you had enough water today? 💧`
        : `Nghỉ tay chút đi nha — nghỉ ngơi cũng quan trọng như uống thuốc vậy. Hôm nay bạn uống đủ nước chưa? 💧`;
    } else {
      body = isEn
        ? `How's your afternoon going? Take a moment to stretch, drink some water, and breathe. Small habits make a big difference 🌿`
        : `Buổi chiều của bạn thế nào rồi? Đứng dậy vươn vai tí, uống ngụm nước, hít thở sâu nha. Những thói quen nhỏ tạo thay đổi lớn lắm 🌿`;
    }
    const target = conditions.hasDiabetes ? 'glucose' : conditions.hasHypertension ? 'blood_pressure' : 'home';
    if (await sendAndSave(pool, user, 'reminder_afternoon', title, body, {
      type: 'reminder_afternoon',
      target,
    })) sent++;
  }
  return { type: 'afternoon', total: rows.length, sent };
}

// ─── 3. Evening summary (merged: log + medication) ────────────────

async function runEveningSummary(pool, hour, minute) {
  const { rows } = await pool.query(`
    SELECT u.id, u.push_token,
           COALESCE(u.language_preference,'vi') AS lang,
           u.display_name, u.full_name,
           uop.medical_conditions,
           (SELECT triage_summary FROM health_checkins hc
            WHERE hc.user_id = u.id AND hc.triage_summary IS NOT NULL
            ORDER BY hc.session_date DESC LIMIT 1) AS last_symptom,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
               AND EXTRACT(HOUR FROM lc.occurred_at AT TIME ZONE '${TZ}') >= 17
           ) AS no_evening_log,
           NOT EXISTS (
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id AND lc.log_type = 'medication'
               AND DATE(lc.occurred_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
           ) AS no_medication_today
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND ${remindersEnabled()}
      AND ${eveningMatch(21)}
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'reminder_evening_summary'
          AND DATE(n.created_at AT TIME ZONE '${TZ}') = DATE(NOW() AT TIME ZONE '${TZ}')
      )
  `, [hour, minute]);

  let sent = 0;
  for (const user of rows) {
    const name = getUserName(user);
    const conditions = parseConditions(user.medical_conditions);
    const isEn = user.lang === 'en';

    const tasks = [];
    if (conditions.hasAny && user.no_medication_today) {
      tasks.push(isEn ? 'take evening medication 💊' : 'uống thuốc tối 💊');
    }
    if (user.no_evening_log) {
      tasks.push(isEn ? 'log your health stats 📋' : 'ghi chỉ số sức khỏe 📋');
    }

    if (tasks.length === 0) continue;

    const title = isEn
      ? `🌙 Good evening${name ? ' ' + name : ''}!`
      : `🌙 Tối rồi${name ? ' ' + name + ' ơi' : ''}!`;

    let body;
    if (user.last_symptom) {
      body = isEn
        ? `Before you rest tonight: ${tasks.join(', ')}. You mentioned ${user.last_symptom} recently — hope you're feeling better. Sleep well 💙`
        : `Trước khi nghỉ ngơi tối nay nhớ: ${tasks.join(', ')} nha. Gần đây bạn có bị ${user.last_symptom} — mong bạn đã đỡ hơn rồi. Ngủ ngon 💙`;
    } else {
      body = isEn
        ? `You did great today! Before bed, just remember: ${tasks.join(', ')}. Rest well, tomorrow is a new day 🌟`
        : `Hôm nay bạn đã rất giỏi rồi! Trước khi ngủ nhớ: ${tasks.join(', ')} nha. Nghỉ ngơi thật ngon, ngày mai lại là ngày mới 🌟`;
    }

    const missingTypes = [];
    if (conditions.hasAny && user.no_medication_today) missingTypes.push('medication');
    if (user.no_evening_log) missingTypes.push('log');

    if (await sendAndSave(pool, user, 'reminder_evening_summary', title, body, {
      type: 'reminder_evening_summary',
      missingTypes,
      firstMissing: missingTypes[0] || 'home',
    })) sent++;
  }
  return { type: 'evening_summary', total: rows.length, sent };
}

// ─── (Glucose, BP, Medication morning/evening — merged into morning/evening summary above) ──

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

  // Quiet hours 22:00–05:00 VN: only run urgent jobs, skip all reminders
  const isQuietHours = hour >= 22 || hour < 5;
  if (isQuietHours) {
    const results = await Promise.all([
      runCheckinFollowUps(pool),
      runAlertConfirmationFollowUps(pool),
    ]);
    const totalSent = results.reduce((s, r) => s + (r.sent || 0), 0);
    return { ok: true, hour, minute, quietHours: true, results, totalSent, totalEligible: 0 };
  }

  // Run sequentially so cross-type 5-min gap works (earlier job blocks later ones for same user)
  const results = [];
  results.push(await runMorningCheckin(pool, hour));
  results.push(await runMorningSummary(pool, hour, minute));
  results.push(await runAfternoon(pool, hour, minute));
  results.push(await runEveningSummary(pool, hour, minute));
  results.push(await runStreakMilestones(pool, hour, minute));
  if (hour === 20 && minute === 0 && dow === 0) results.push(await runWeeklyRecap(pool));
  // Checkin follow-ups are urgent — run independently (not subject to reminder gap)
  const [followUps, alertFollowUps] = await Promise.all([
    runCheckinFollowUps(pool),
    runAlertConfirmationFollowUps(pool),
  ]);
  results.push(followUps, alertFollowUps);

  const totalSent = results.reduce((s, r) => s + (r.sent || 0), 0);
  const totalEligible = results.reduce((s, r) => s + (r.total || 0), 0);

  return { ok: true, hour, minute, results, totalSent, totalEligible };
}

module.exports = { runBasicNotifications, sendAndSave, getPreferredHour };
