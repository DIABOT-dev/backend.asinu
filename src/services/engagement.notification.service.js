/**
 * Engagement Notification Service
 *
 * Gửi push notification ngoài app được cá nhân hóa bằng AI.
 * AI phân tích hoạt động thực tế của user (log sức khoẻ hôm nay chưa,
 * lần cuối check-in brain, lần cuối vào app...) rồi sinh nội dung phù hợp.
 */

const { getOpenAIReply } = require('./ai/providers/openai');
const { sendPushNotification } = require('./push.notification.service');

const COOLDOWN_HOURS = 48;
const MIN_INACTIVE_HOURS = 24;
const MAX_INACTIVE_HOURS = 30 * 24;

// ─────────────────────────────────────────────────────────────
// DATA FETCHING
// ─────────────────────────────────────────────────────────────

async function getEligibleUsers(pool) {
  const result = await pool.query(
    `SELECT
       u.id,
       COALESCE(u.full_name, u.display_name) AS name,
       u.push_token,
       u.language_preference,
       u.last_engagement_notif_at,
       MAX(al.occurred_at) AS last_app_open,
       EXTRACT(EPOCH FROM (NOW() - MAX(al.occurred_at))) / 3600 AS hours_inactive
     FROM users u
     LEFT JOIN user_activity_logs al
       ON al.user_id = u.id AND al.activity_type = 'APP_OPEN'
     WHERE u.push_token IS NOT NULL
       AND u.deleted_at IS NULL
       AND (
         u.last_engagement_notif_at IS NULL
         OR u.last_engagement_notif_at < NOW() - INTERVAL '${COOLDOWN_HOURS} hours'
       )
     GROUP BY u.id, u.full_name, u.display_name, u.push_token,
              u.language_preference, u.last_engagement_notif_at
     HAVING
       MAX(al.occurred_at) IS NULL
       OR (
         MAX(al.occurred_at) < NOW() - INTERVAL '${MIN_INACTIVE_HOURS} hours'
         AND MAX(al.occurred_at) > NOW() - INTERVAL '${MAX_INACTIVE_HOURS} hours'
       )`,
    []
  );
  return result.rows;
}

/**
 * Lấy toàn bộ context hoạt động của user để AI nhận định
 */
async function getUserContext(pool, userId) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const [
    profileResult,
    todayLogsResult,
    lastLogResult,
    lastBrainResult,
    glucoseResult,
    bpResult,
  ] = await Promise.all([
    // Profile sức khoẻ
    pool.query(
      `SELECT age, gender, goal, body_type, medical_conditions, chronic_symptoms
       FROM user_onboarding_profiles WHERE user_id = $1`,
      [userId]
    ),

    // Hôm nay đã log những gì?
    pool.query(
      `SELECT DISTINCT log_type
       FROM logs_common
       WHERE user_id = $1
         AND occurred_at >= CURRENT_DATE
         AND occurred_at < CURRENT_DATE + INTERVAL '1 day'`,
      [userId]
    ),

    // Lần cuối log bất kỳ là khi nào?
    pool.query(
      `SELECT MAX(occurred_at) AS last_log_at,
              EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at))) / 3600 AS hours_since_log
       FROM logs_common
       WHERE user_id = $1`,
      [userId]
    ),

    // Lần cuối làm brain check-in là khi nào?
    pool.query(
      `SELECT MAX(created_at) AS last_brain_at,
              EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS hours_since_brain
       FROM asinu_brain_sessions
       WHERE user_id = $1`,
      [userId]
    ),

    // Chỉ số đường huyết gần nhất (7 ngày)
    pool.query(
      `SELECT d.value, d.unit, c.occurred_at
       FROM logs_common c
       JOIN glucose_logs d ON d.log_id = c.id
       WHERE c.user_id = $1 AND c.log_type = 'glucose'
         AND c.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY c.occurred_at DESC LIMIT 1`,
      [userId]
    ),

    // Huyết áp gần nhất (7 ngày)
    pool.query(
      `SELECT d.systolic, d.diastolic, c.occurred_at
       FROM logs_common c
       JOIN blood_pressure_logs d ON d.log_id = c.id
       WHERE c.user_id = $1 AND c.log_type = 'bp'
         AND c.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY c.occurred_at DESC LIMIT 1`,
      [userId]
    ),
  ]);

  const todayLogTypes = todayLogsResult.rows.map(r => r.log_type);
  const hoursSinceLog = lastLogResult.rows[0]?.hours_since_log
    ? Math.round(parseFloat(lastLogResult.rows[0].hours_since_log))
    : null;
  const hoursSinceBrain = lastBrainResult.rows[0]?.hours_since_brain
    ? Math.round(parseFloat(lastBrainResult.rows[0].hours_since_brain))
    : null;

  return {
    profile: profileResult.rows[0] || null,
    todayLogTypes,                          // ['glucose', 'bp', ...]
    loggedTodayCount: todayLogTypes.length,
    hoursSinceLastLog: hoursSinceLog,       // null = chưa bao giờ log
    hoursSinceLastBrain: hoursSinceBrain,   // null = chưa bao giờ check-in
    latestGlucose: glucoseResult.rows[0] || null,
    latestBp: bpResult.rows[0] || null,
  };
}

function extractConditions(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .map(i => (typeof i === 'string' ? i : i.label || i.other_text || ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

// ─────────────────────────────────────────────────────────────
// AI GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * AI phân tích activity thực tế → sinh nội dung thông báo cá nhân hóa
 * @returns { shouldSend, title, body }
 */
async function generateEngagementNotification(user, context, lang = 'vi', { isPreview = false } = {}) {
  const {
    profile,
    todayLogTypes,
    loggedTodayCount,
    hoursSinceLastLog,
    hoursSinceLastBrain,
    latestGlucose,
    latestBp,
  } = context;

  const name = user.name || 'bạn';
  const hoursInactive = Math.round(user.hours_inactive || MIN_INACTIVE_HOURS);
  const daysInactive = hoursInactive >= 24 ? Math.round(hoursInactive / 24) : null;
  const goal = profile?.goal || '';
  const conditions = extractConditions(profile?.medical_conditions)
    || extractConditions(profile?.chronic_symptoms);

  // Xây dựng mô tả activity để AI hiểu tình huống
  const activityLines = [];

  if (loggedTodayCount === 0) {
    activityLines.push('- Hôm nay chưa khai báo bất kỳ chỉ số sức khoẻ nào');
  } else {
    activityLines.push(`- Hôm nay đã khai báo: ${todayLogTypes.join(', ')}`);
  }

  if (hoursSinceLastLog === null) {
    activityLines.push('- Chưa bao giờ khai báo chỉ số sức khoẻ');
  } else if (hoursSinceLastLog > 48) {
    activityLines.push(`- Lần cuối khai báo sức khoẻ: ${Math.round(hoursSinceLastLog / 24)} ngày trước`);
  }

  if (hoursSinceLastBrain === null) {
    activityLines.push('- Chưa bao giờ làm check-in sức khoẻ với Asinu Brain');
  } else if (hoursSinceLastBrain > 24) {
    activityLines.push(`- Lần cuối check-in với Asinu: ${hoursSinceLastBrain > 48 ? Math.round(hoursSinceLastBrain / 24) + ' ngày' : Math.round(hoursSinceLastBrain) + ' giờ'} trước`);
  }

  if (daysInactive) {
    activityLines.push(`- Chưa mở app: ${daysInactive} ngày`);
  }

  const isEn = lang === 'en';

  const prompt = isEn
    ? `You are Asinu, a friendly health assistant app.

USER: ${name}${goal ? `, goal: "${goal}"` : ''}${conditions ? `, conditions: ${conditions}` : ''}

USER ACTIVITY TODAY:
${activityLines.join('\n')}

TASK: Generate a personalized re-engagement push notification to nudge the user to open the app.
- Be warm and personal, like a caring friend
- Reference their specific missing action (e.g. "you haven't logged your blood pressure today")
- Max 80 characters for body
- Do NOT mention specific health numbers
${isPreview ? '- This is a PREVIEW/TEST — always generate content, always return shouldSend: true' : '- If inactive > 14 days → return shouldSend: false (user likely churned)'}

Reply in strict JSON only (no extra text):
{"shouldSend": true, "title": "Asinu", "body": "notification text here"}`
    : `Bạn là Asinu — ứng dụng trợ lý sức khoẻ cá nhân.

NGƯỜI DÙNG: ${name}${goal ? `, mục tiêu: "${goal}"` : ''}${conditions ? `, bệnh lý: ${conditions}` : ''}

HOẠT ĐỘNG THỰC TẾ:
${activityLines.join('\n')}

NHIỆM VỤ: Sinh 1 thông báo push cá nhân hóa để níu kéo người dùng mở app.
- Giọng thân thiện như bạn bè quan tâm, KHÔNG như robot
- Đề cập đúng hành động còn thiếu hôm nay (ví dụ "hôm nay bạn chưa khai báo đường huyết")
- Tối đa 80 ký tự phần body
- KHÔNG đề cập số liệu cụ thể
${isPreview ? '- Đây là PREVIEW/TEST — luôn sinh nội dung, luôn trả về shouldSend: true' : '- Nếu không vào app > 14 ngày → trả về shouldSend: false'}
- Đa dạng nội dung, không lặp lại kiểu mẫu cũ

Chỉ trả về JSON thuần (không có text thừa):
{"shouldSend": true, "title": "Asinu", "body": "nội dung thông báo"}`;

  const aiResponse = await getOpenAIReply({
    message: prompt,
    userId: String(user.id),
    sessionId: `engagement-${user.id}-${Date.now()}`,
    temperature: 0.9,
  });

  const text = aiResponse.reply.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`[engagement] Could not parse AI response for user ${user.id}:`, text);
    return { shouldSend: false };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      shouldSend: !!parsed.shouldSend,
      title: parsed.title || 'Asinu',
      body: parsed.body || '',
    };
  } catch {
    console.warn(`[engagement] JSON parse failed for user ${user.id}`);
    return { shouldSend: false };
  }
}

// ─────────────────────────────────────────────────────────────
// PREVIEW (dùng cho test — không gửi push thật)
// ─────────────────────────────────────────────────────────────

/**
 * Sinh nội dung AI cho user nhưng KHÔNG gửi push.
 * Dùng cho nút test trong app.
 * @returns { title, body, context } — frontend tự show local notification
 */
async function previewEngagementNotification(pool, userId) {
  const [userResult, context] = await Promise.all([
    pool.query(
      `SELECT
         u.id,
         COALESCE(u.full_name, u.display_name) AS name,
         u.language_preference,
         EXTRACT(EPOCH FROM (NOW() - MAX(al.occurred_at))) / 3600 AS hours_inactive
       FROM users u
       LEFT JOIN user_activity_logs al
         ON al.user_id = u.id AND al.activity_type = 'APP_OPEN'
       WHERE u.id = $1
       GROUP BY u.id, u.full_name, u.display_name, u.language_preference`,
      [userId]
    ),
    getUserContext(pool, userId),
  ]);

  const userRow = userResult.rows[0];
  if (!userRow) throw new Error(`User ${userId} not found`);

  const user = {
    id: userId,
    name: userRow.name,
    hours_inactive: Math.max(userRow.hours_inactive ? Math.round(parseFloat(userRow.hours_inactive)) : 0, MIN_INACTIVE_HOURS),
    language_preference: userRow.language_preference || 'vi',
  };

  const decision = await generateEngagementNotification(
    user,
    context,
    user.language_preference,
    { isPreview: true }
  );

  if (!decision.body) {
    throw new Error('AI did not generate notification content');
  }

  return {
    title: decision.title || 'Asinu',
    body: decision.body,
    activitySummary: {
      loggedTodayCount: context.loggedTodayCount,
      todayLogTypes: context.todayLogTypes,
      hoursSinceLastLog: context.hoursSinceLastLog,
      hoursSinceLastBrain: context.hoursSinceLastBrain,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN RUN (dùng cho cron)
// ─────────────────────────────────────────────────────────────

async function markNotificationSent(pool, userId) {
  await pool.query(
    `UPDATE users SET last_engagement_notif_at = NOW() WHERE id = $1`,
    [userId]
  );
}

async function runEngagementNotifications(pool) {
  console.log('[engagement] Starting engagement notification run...');

  const users = await getEligibleUsers(pool);
  console.log(`[engagement] Found ${users.length} eligible users`);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const context = await getUserContext(pool, user.id);
      const lang = user.language_preference || 'vi';
      const decision = await generateEngagementNotification(user, context, lang);

      if (!decision.shouldSend) {
        console.log(`[engagement] AI skipped user ${user.id}`);
        skipped++;
        continue;
      }

      const result = await sendPushNotification(
        [user.push_token],
        decision.title,
        decision.body,
        { type: 'engagement' }
      );

      if (result.ok) {
        await markNotificationSent(pool, user.id);
        console.log(`[engagement] Sent to user ${user.id}: "${decision.body}"`);
        sent++;
      } else {
        console.warn(`[engagement] Push failed for user ${user.id}:`, result.error);
        errors++;
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {
      console.error(`[engagement] Error user ${user.id}:`, err?.message || err);
      errors++;
    }
  }

  console.log(`[engagement] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}`);
  return { ok: true, total: users.length, sent, skipped, errors };
}

module.exports = {
  runEngagementNotifications,
  generateEngagementNotification,
  getUserContext,
  previewEngagementNotification,
};
