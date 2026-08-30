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
const {
  runCheckinFollowUps,
  runMorningCheckin,
  runAlertConfirmationFollowUps,
} = require('../checkin/checkin.service');
const { getHonorifics } = require('../../lib/honorifics');
const { generateMessage } = require('./notification-intelligence.service');
const { runReengagement } = require('./reengagement.service');
const logger = require('../../lib/logger');
const { canSendNonUrgent } = require('./notification.policy');

const TZ = 'Asia/Ho_Chi_Minh';

// ─── Priority map ────────────────────────────────────────────────
const TYPE_PRIORITY = {
  emergency: 'critical',
  checkin_followup_urgent: 'critical',
  health_alert: 'high',
  caregiver_alert: 'high',
  checkin_followup: 'high',
  reengagement: 'medium',
  morning_checkin: 'medium',
  care_circle_invitation: 'medium',
  care_circle_accepted: 'medium',
  care_circle_rejected: 'low',
  care_circle_removed: 'medium',
  care_circle_permission_changed: 'medium',
  // Subscription / Payment
  subscription_activated: 'high',
  subscription_expiring_soon: 'high',
  subscription_expired: 'high',
  payment_failed: 'high',
  wallet_topup_success: 'medium',
  wallet_low_balance: 'medium',
  // Engagement
  weekly_wellness_summary: 'low',
  profile_incomplete: 'low',
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
  doctor_message: 'high',
};

const ALWAYS_DELIVER_TYPES = new Set(['doctor_message']);

// ─── Exact HH:MM match helpers ────────────────────────────────────
// Matches both hour AND minute so notifications fire at the exact configured time.
// When no time is set (NULL), falls back to default HH:00.
const safeTime = (field) =>
  `(CASE WHEN ${field} IS NOT NULL
          AND BTRIM(${field}::text) ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
         THEN ${field}::time END)`;

const morningMatch = (defH = 8) => `
  COALESCE(EXTRACT(HOUR   FROM ${safeTime('np.morning_time')})::int, np.morning_hour, np.inferred_morning_hour, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM ${safeTime('np.morning_time')})::int, 0) = $2`;
const afternoonMatch = (defH = 14) => `
  COALESCE(EXTRACT(HOUR   FROM ${safeTime('np.afternoon_time')})::int, EXTRACT(HOUR   FROM ${safeTime('np.inferred_afternoon_time')})::int, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM ${safeTime('np.afternoon_time')})::int, EXTRACT(MINUTE FROM ${safeTime('np.inferred_afternoon_time')})::int, 0) = $2`;
const eveningMatch = (defH = 21) => `
  COALESCE(EXTRACT(HOUR   FROM ${safeTime('np.evening_time')})::int, np.evening_hour, np.inferred_evening_hour, ${defH}) = $1
  AND COALESCE(EXTRACT(MINUTE FROM ${safeTime('np.evening_time')})::int, 0) = $2`;
const remindersEnabled = () => `COALESCE(np.reminders_enabled, false) = true`;

function nowVN() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(new Date())) parts[type] = value;
  // Build from numeric parts to avoid Invalid Date edge-cases (e.g. unexpected "24" hour output).
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const hh = Number(parts.hour);
  const mm = Number(parts.minute);
  const ss = Number(parts.second);

  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    !Number.isFinite(ss)
  ) {
    return new Date();
  }

  // Some runtimes can emit hour=24; normalize to 00 of next day.
  const base = new Date(y, m - 1, d, 0, mm, ss, 0);
  if (hh === 24) {
    base.setDate(base.getDate() + 1);
    return base;
  }

  return new Date(y, m - 1, d, hh, mm, ss, 0);
}

// ─── Core dispatch ─────────────────────────────────────────────────

/**
 * Core dispatch: send push + save in-app notification.
 * Accepts either a user object (with .id and .push_token) or a plain userId (number).
 * Optional `overridePriority` lets callers (e.g. NotificationOrchestrator) set priority explicitly.
 */
// Reminder types that should be spaced apart (5 min gap between any two)
const REMINDER_TYPES = new Set([
  'reminder_morning_summary',
  'reminder_afternoon',
  'reminder_evening_summary',
  'reminder_log_morning',
  'reminder_log_evening',
  'reminder_glucose',
  'reminder_bp',
  'reminder_medication_morning',
  'reminder_medication_evening',
  'morning_checkin',
  'streak_7',
  'streak_14',
  'streak_30',
  'weekly_recap',
]);
const CROSS_TYPE_GAP_MINUTES = 5;

// Notification chỉ in-app (không push) — vẫn insert DB để hiện trong
// notification bell, nhưng KHÔNG gửi push tránh spam điện thoại user.
const IN_APP_ONLY_TYPES = new Set([
  'wallet_topup_success', // app đã có UI confirm khi nạp xong
  'wallet_low_balance', // nudge nhẹ — chỉ banner trong wallet screen
  'care_circle_permission_changed', // ít khi xảy ra, in-app badge đủ
  'profile_incomplete', // onboarding nudge — show banner trong home
  'weekly_wellness_summary', // weekly content — chỉ tạo report card trong /report
  'reengagement', // đã có nhiều reminder routines
  'engagement', // tương tự
]);

async function sendAndSave(pool, userOrId, type, title, body, data = {}, overridePriority = null) {
  const isObject = typeof userOrId === 'object' && userOrId !== null;
  const userId = isObject ? userOrId.id : userOrId;
  const pushToken = isObject ? userOrId.push_token : null;

  const priority = overridePriority || TYPE_PRIORITY[type] || 'low';

  // Non-urgent reminders require an explicit opt-in and are subject to a
  // daily cap. Emergency/health/caregiver alerts are intentionally exempt.
  if (!ALWAYS_DELIVER_TYPES.has(type) && !(await canSendNonUrgent(pool, userId, type))) return false;

  // Cross-type spacing: skip if user received any reminder push in last 5 minutes
  if (REMINDER_TYPES.has(type)) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1
           AND type = ANY($2::text[])
           AND created_at >= NOW() - make_interval(mins => $3) LIMIT 1`,
        [userId, [...REMINDER_TYPES], CROSS_TYPE_GAP_MINUTES]
      );
      if (rows.length > 0) return false;
    } catch (err) {
      logger.error('notification.spacing_check_failed', { userId, type, err });
      return false;
    }
  }

  // Same-type dedup: skip if exact same type was sent to this user in the last 5 minutes
  if (!ALWAYS_DELIVER_TYPES.has(type)) {
    try {
      const { rows: dup } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2
           AND created_at >= NOW() - make_interval(mins => 5) LIMIT 1`,
        [userId, type]
      );
      if (dup.length > 0) {
        logger.debug('notification.dedup_skipped', { userId, type });
        return false;
      }
    } catch (err) {
      logger.warn('notification.dedup_check_failed', { userId, type, err });
      return false;
    }
  }

  // Insert DB record FIRST, only push if insert succeeds
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, type, title, body, JSON.stringify(data), priority]
    );
  } catch (err) {
    logger.error('notification.insert_failed', { userId, type, err });
    return false;
  }

  // In-app only types: skip push, chỉ giữ DB record (notification bell)
  if (IN_APP_ONLY_TYPES.has(type)) {
    return true;
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

function _getGreeting(lang, hour) {
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
         uop.birth_year, uop.gender,
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

const _NO_LOG_TODAY = (logType = null) =>
  logType
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
  const { rows } = await pool.query(
    `
    SELECT u.id, u.push_token,
           COALESCE(u.language_preference,'vi') AS lang,
           u.display_name, u.full_name,
           uop.medical_conditions,
           uop.birth_year, uop.gender,
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
             SELECT 1 FROM logs_common lc WHERE lc.user_id = u.id AND lc.log_type = 'bp'
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
  `,
    [hour, minute]
  );

  let sent = 0;
  for (const user of rows) {
    const { honorific, CallName } = getHonorifics(user);
    const conditions = parseConditions(user.medical_conditions);
    const isEn = user.lang === 'en';

    // Build task list based on what user needs to do today
    const tasks = [];
    if (conditions.hasDiabetes && user.no_glucose_today) {
      const prev = user.last_glucose
        ? isEn
          ? ` (last: ${user.last_glucose})`
          : ` (gần nhất: ${user.last_glucose})`
        : '';
      tasks.push(isEn ? `blood glucose${prev}` : `đo đường huyết${prev}`);
    }
    if (conditions.hasHypertension && user.no_bp_today) {
      const prev = user.last_bp
        ? isEn
          ? ` (last: ${user.last_bp})`
          : ` (gần nhất: ${user.last_bp})`
        : '';
      tasks.push(isEn ? `blood pressure${prev}` : `đo huyết áp${prev}`);
    }
    if (conditions.hasAny && user.no_medication_today) {
      tasks.push(isEn ? 'take medication' : 'uống thuốc');
    }
    if (user.no_log_today && tasks.length === 0) {
      tasks.push(isEn ? 'log your health stats' : 'ghi chỉ số sức khỏe');
    }

    // Skip if nothing to remind
    if (tasks.length === 0) continue;

    const title = isEn ? '☀️ Morning health update' : '☀️ Cập nhật sức khỏe buổi sáng';

    // Personalized body from Intelligence Layer
    let body;
    try {
      const msg = await generateMessage(pool, user.id, 'morning', user, {
        tasks: tasks.join(', '),
      });
      body =
        msg.text +
        (tasks.length > 0
          ? isEn
            ? ` Still to do: ${tasks.join(', ')}.`
            : ` Còn thiếu: ${tasks.join(', ')}.`
          : '');
    } catch {
      // Fallback
      if (user.last_symptom) {
        body = isEn
          ? `You recently recorded ${user.last_symptom}. Still to do: ${tasks.join(', ')}.`
          : `${CallName} ơi, lần trước ${honorific} ghi nhận ${user.last_symptom}. Hôm nay còn thiếu ${tasks.join(', ')}; cập nhật để Asinu theo dõi tiếp nhé.`;
      } else {
        body = isEn
          ? `There is no health data for today yet. Still to do: ${tasks.join(', ')}.`
          : `${CallName} ơi, hôm nay chưa có dữ liệu sức khỏe. Cập nhật nhanh để Asinu theo dõi tiếp nhé.`;
      }
    }

    // Build missing types for deep link
    const missingTypes = [];
    if (conditions.hasDiabetes && user.no_glucose_today) missingTypes.push('glucose');
    if (conditions.hasHypertension && user.no_bp_today) missingTypes.push('blood_pressure');
    if (conditions.hasAny && user.no_medication_today) missingTypes.push('medication');

    if (
      await sendAndSave(pool, user, 'reminder_morning_summary', title, body, {
        type: 'reminder_morning_summary',
        missingTypes,
        firstMissing: missingTypes[0] || 'checkin',
      })
    )
      sent++;
  }
  return { type: 'morning_summary', total: rows.length, sent };
}

// ─── 2. Afternoon reminder (NEW — uses afternoon_time) ───────────

async function runAfternoon(pool, hour, minute) {
  const { rows } = await pool.query(
    `
    ${USER_SELECT}
    AND ${afternoonMatch(14)}
    ${NOT_SENT_TODAY('reminder_afternoon')}
  `,
    [hour, minute]
  );

  let sent = 0;
  for (const user of rows) {
    const { CallName } = getHonorifics(user);
    const conditions = parseConditions(user.medical_conditions);
    const isEn = user.lang === 'en';
    const title = isEn ? '🌤️ Afternoon health update' : '🌤️ Cập nhật sức khỏe buổi chiều';
    // Personalized body from Intelligence Layer
    let body;
    try {
      const msg = await generateMessage(pool, user.id, 'afternoon', user);
      body = msg.text + ' 😊';
    } catch {
      // Fallback
      if (conditions.hasDiabetes) {
        body = isEn
          ? `If needed, drink some water and check your blood glucose today.`
          : `${CallName} ơi, uống nước và đo đường huyết hôm nay nếu chưa đo nhé.`;
      } else if (conditions.hasHypertension) {
        body = isEn
          ? `Take a short break and check your blood pressure if you have not done so today.`
          : `${CallName} ơi, nghỉ vài phút rồi đo huyết áp nếu hôm nay chưa đo nhé.`;
      } else {
        body = isEn
          ? `Take a few minutes to rest and drink some water before continuing your day.`
          : `${CallName} ơi, nghỉ một chút và uống nước trước khi tiếp tục ngày nhé.`;
      }
    }
    const target = conditions.hasDiabetes
      ? 'glucose'
      : conditions.hasHypertension
        ? 'blood_pressure'
        : 'home';
    if (
      await sendAndSave(pool, user, 'reminder_afternoon', title, body, {
        type: 'reminder_afternoon',
        target,
      })
    )
      sent++;
  }
  return { type: 'afternoon', total: rows.length, sent };
}

// ─── 3. Evening summary (merged: log + medication) ────────────────

async function runEveningSummary(pool, hour, minute) {
  const { rows } = await pool.query(
    `
    SELECT u.id, u.push_token,
           COALESCE(u.language_preference,'vi') AS lang,
           u.display_name, u.full_name,
           uop.medical_conditions,
           uop.birth_year, uop.gender,
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
  `,
    [hour, minute]
  );

  let sent = 0;
  for (const user of rows) {
    const { honorific, CallName } = getHonorifics(user);
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

    const title = isEn ? '🌙 Evening health update' : '🌙 Cập nhật sức khỏe buổi tối';

    // Personalized body from Intelligence Layer
    let body;
    try {
      const msg = await generateMessage(pool, user.id, 'evening', user, {
        tasks: tasks.join(', '),
      });
      body = msg.text + ' 🌙';
    } catch {
      // Fallback
      if (user.last_symptom) {
        body = isEn
          ? `You recently recorded ${user.last_symptom}. Still to do before bed: ${tasks.join(', ')}.`
          : `${CallName} ơi, lần trước ${honorific} ghi nhận ${user.last_symptom}. Còn thiếu ${tasks.join(', ')}; cập nhật để Asinu theo dõi tiếp nhé.`;
      } else {
        body = isEn
          ? `Still to do before bed: ${tasks.join(', ')}. Complete today's record before you rest.`
          : `${CallName} ơi, hôm nay còn thiếu ${tasks.join(', ')}. Ghi thêm trước khi nghỉ để Asinu theo dõi đủ dữ liệu nhé.`;
      }
    }

    const missingTypes = [];
    if (conditions.hasAny && user.no_medication_today) missingTypes.push('medication');
    if (user.no_evening_log) missingTypes.push('log');

    if (
      await sendAndSave(pool, user, 'reminder_evening_summary', title, body, {
        type: 'reminder_evening_summary',
        missingTypes,
        firstMissing: missingTypes[0] || 'home',
      })
    )
      sent++;
  }
  return { type: 'evening_summary', total: rows.length, sent };
}

// ─── (Glucose, BP, Medication morning/evening — merged into morning/evening summary above) ──

// ─── 7. Streak milestones ─────────────────────────────────────────

const STREAK_MILESTONES = [7, 14, 30];

async function getUserStreak(pool, userId) {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT DATE(occurred_at AT TIME ZONE '${TZ}') AS log_date
    FROM logs_common WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '35 days'
    ORDER BY log_date DESC
  `,
    [userId]
  );
  if (!rows.length) return 0;
  const today = nowVN();
  today.setHours(0, 0, 0, 0);
  let streak = 0;
  const expected = new Date(today);
  for (const r of rows) {
    const d = new Date(r.log_date);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() === expected.getTime()) {
      streak++;
      expected.setDate(expected.getDate() - 1);
    } else if (d < expected) break;
  }
  return streak;
}

async function runStreakMilestones(pool, hour, minute) {
  const { rows: activeUsers } = await pool.query(
    `
    ${USER_SELECT}
    AND ${morningMatch(8)}
  `,
    [hour, minute]
  );

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
    const title = user.lang === 'en' ? `Health log: ${streak} days` : `Ghi log: ${streak} ngày`;
    const body =
      user.lang === 'en'
        ? `You logged health data for ${streak} days in a row. Keep the routine going.`
        : `Bạn đã ghi log sức khỏe ${streak} ngày liên tiếp. Tiếp tục duy trì thói quen này.`;
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
    const title = user.lang === 'en' ? 'Weekly health summary' : 'Tổng kết sức khỏe tuần';
    let body;
    if (days === 7) {
      body =
        user.lang === 'en'
          ? "You logged health data on all 7 days. This week's record is complete."
          : 'Bạn đã ghi log sức khỏe đủ 7/7 ngày. Dữ liệu tuần này đã đầy đủ.';
    } else if (days >= 5) {
      body =
        user.lang === 'en'
          ? `${days}/7 days logged this week. A few more updates will make next week easier to track.`
          : `Bạn đã ghi log ${days}/7 ngày. Thêm vài lần cập nhật để theo dõi đều hơn tuần tới.`;
    } else if (days >= 3) {
      body =
        user.lang === 'en'
          ? `${days}/7 days logged this week. More regular updates will make your trend easier to follow.`
          : `Bạn đã ghi log ${days}/7 ngày. Cập nhật đều hơn sẽ giúp theo dõi xu hướng rõ hơn.`;
    } else {
      body =
        user.lang === 'en'
          ? `${days}/7 days logged this week. You can start a new record today.`
          : `Tuần này có ${days}/7 ngày được ghi nhận. Bạn có thể bắt đầu cập nhật từ hôm nay.`;
    }
    if (await sendAndSave(pool, user, 'weekly_recap', title, body, { days_logged: days })) sent++;
  }
  return { type: 'weekly_recap', total: rows.length, sent };
}

// ─── Condition parser ─────────────────────────────────────────────

function parseConditions(medicalConditions) {
  const text = (
    Array.isArray(medicalConditions) ? medicalConditions.join(' ') : String(medicalConditions || '')
  ).toLowerCase();
  return {
    hasDiabetes: text.includes('tiểu đường') || text.includes('diabetes'),
    hasHypertension:
      text.includes('huyết áp') || text.includes('hypertension') || text.includes('blood pressure'),
    hasAny: text.length > 2 && text !== '[]',
  };
}

// ─── Preferred hour helper (personalized timing) ─────────────────

async function getPreferredHour(pool, userId, defaultHour) {
  try {
    const res = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE '${TZ}') as hour, COUNT(*) as cnt
       FROM health_checkins
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
         AND no_response_count = 0
       GROUP BY hour ORDER BY cnt DESC LIMIT 1`,
      [userId]
    );
    const hour = Number(res.rows[0]?.hour);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : defaultHour;
  } catch {
    return defaultHour;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────

async function runBasicNotifications(pool, forceHour = null, forceMinute = null) {
  const vn = nowVN();
  const currentHour = vn.getHours();
  const currentMinute = vn.getMinutes();
  const validateTimePart = (value, name, max) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') {
      throw new Error(`Invalid ${name}`);
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > max) {
      throw new Error(`Invalid ${name}`);
    }
    return number;
  };
  const requestedHour = validateTimePart(forceHour, 'hour', 23);
  const requestedMinute = validateTimePart(forceMinute, 'minute', 59);
  const hour = requestedHour ?? (Number.isFinite(currentHour) ? currentHour : 0);
  const minute = requestedMinute ?? (Number.isFinite(currentMinute) ? currentMinute : 0);
  const dow = vn.getDay(); // 0 = Sunday

  const runTask = async (name, handler) => {
    try {
      return await handler();
    } catch (err) {
      // A malformed preference or one broken notification family must not
      // abort the remaining families in this minute's batch.
      logger.error('basic_notifications.task_failed', { task: name, err });
      return { type: name, total: 0, sent: 0, failed: true };
    }
  };

  // Quiet hours 22:00–05:00 VN: only run urgent jobs, skip all reminders
  const isQuietHours = hour >= 22 || hour < 5;
  if (isQuietHours) {
    const results = await Promise.all([
      runTask('checkin_followups', () => runCheckinFollowUps(pool)),
      runTask('alert_confirmation_followups', () => runAlertConfirmationFollowUps(pool)),
    ]);
    const totalSent = results.reduce((s, r) => s + (r?.sent || 0), 0);
    return { ok: true, hour, minute, quietHours: true, results, totalSent, totalEligible: 0 };
  }

  // Run sequentially so cross-type 5-min gap works (earlier job blocks later ones for same user)
  const results = [];
  results.push(await runTask('morning_checkin', () => runMorningCheckin(pool, hour)));
  results.push(await runTask('morning_summary', () => runMorningSummary(pool, hour, minute)));
  results.push(await runTask('afternoon', () => runAfternoon(pool, hour, minute)));
  results.push(await runTask('evening_summary', () => runEveningSummary(pool, hour, minute)));
  results.push(await runTask('streak_milestones', () => runStreakMilestones(pool, hour, minute)));
  if (hour === 20 && minute < 5 && dow === 0)
    results.push(await runTask('weekly_recap', () => runWeeklyRecap(pool)));
  // Re-engagement: chạy 1 lần/ngày vào 9:00 sáng VN
  if (hour === 9 && minute < 5)
    results.push(await runTask('reengagement', () => runReengagement(pool, sendAndSave)));
  // Context-based alerts (severity high, trend worsening)
  results.push(await runTask('context_alerts', () => runContextAlerts(pool)));
  // Checkin follow-ups are urgent — run independently (not subject to reminder gap)
  const [followUps, alertFollowUps] = await Promise.all([
    runTask('checkin_followups', () => runCheckinFollowUps(pool)),
    runTask('alert_confirmation_followups', () => runAlertConfirmationFollowUps(pool)),
  ]);
  results.push(followUps, alertFollowUps);

  const totalSent = results.reduce((s, r) => s + (r?.sent || 0), 0);
  const totalEligible = results.reduce((s, r) => s + (r?.total || 0), 0);

  return { ok: true, hour, minute, results, totalSent, totalEligible };
}

// ─── 9. Context-based alerts (event-triggered, not time-based) ───

const {
  checkAlertTriggers,
  generateMessage: genAlertMsg,
} = require('./notification-intelligence.service');

async function runContextAlerts(pool) {
  // Query active users with recent check-in activity
  const { rows: users } = await pool.query(`
    SELECT u.id, u.push_token,
           COALESCE(u.language_preference,'vi') AS lang,
           u.display_name, u.full_name,
           uop.birth_year, uop.gender
    FROM users u
    JOIN user_onboarding_profiles uop ON uop.user_id = u.id
    JOIN user_lifecycle ul ON ul.user_id = u.id
    LEFT JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.push_token IS NOT NULL
      AND u.deleted_at IS NULL
      AND uop.onboarding_completed_at IS NOT NULL
      AND COALESCE(np.reminders_enabled, false) = true
      AND ul.segment IN ('active', 'semi_active')
  `);

  let sent = 0;
  for (const user of users) {
    try {
      const result = await checkAlertTriggers(pool, user.id);
      if (!result) continue;

      const notifType = 'health_alert';

      // Dedup: skip if same alert sent in last 12 hours
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2
         AND created_at >= NOW() - INTERVAL '12 hours' LIMIT 1`,
        [user.id, notifType]
      );
      if (recent.length > 0) continue;

      const msg = await genAlertMsg(pool, user.id, result.trigger, user);
      const title = user.lang === 'en' ? 'Health alert' : 'Cần chú ý sức khỏe';

      if (
        await sendAndSave(pool, user, notifType, title, msg.text, {
          type: notifType,
          templateId: msg.templateId,
          trigger: result.trigger,
        })
      )
        sent++;
    } catch (err) {
      console.warn(`[ContextAlert] Failed for user ${user.id}:`, err.message);
    }
  }
  return { type: 'context_alerts', total: users.length, sent };
}

module.exports = {
  runBasicNotifications,
  sendAndSave,
  getPreferredHour,
  runContextAlerts,
  runReengagement,
};
