/**
 * Engagement Notification Service
 *
 * Gửi push notification ngoài app được cá nhân hóa bằng AI.
 * AI phân tích hoạt động thực tế của user (log sức khoẻ hôm nay chưa,
 * lần cuối check-in brain, lần cuối vào app...) rồi sinh nội dung phù hợp.
 */

const { getOpenAIReply } = require('../ai/providers/openai');
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
 * Lấy context của MỘT user (dùng cho preview).
 */
async function getUserContext(pool, userId) {
  const map = await getBatchContexts(pool, [userId]);
  return map.get(userId) ?? {
    profile: null, todayLogTypes: [], loggedTodayCount: 0,
    hoursSinceLastLog: null, hoursSinceLastBrain: null,
    latestGlucose: null, latestBp: null,
  };
}

/**
 * Lấy context của NHIỀU user cùng lúc — 6 queries thay vì 6 × N queries.
 * @param {object} pool
 * @param {number[]} userIds
 * @returns {Map<number, object>} userId → context
 */
async function getBatchContexts(pool, userIds) {
  if (!userIds.length) return new Map();

  const ids = userIds; // dùng với ANY($1::int[])

  const [
    profileRows,
    todayLogRows,
    lastLogRows,
    lastBrainRows,
    glucoseRows,
    bpRows,
  ] = await Promise.all([
    // 1. Profiles
    pool.query(
      `SELECT user_id, age, gender, goal, body_type, medical_conditions, chronic_symptoms
       FROM user_onboarding_profiles
       WHERE user_id = ANY($1::int[])`,
      [ids]
    ),

    // 2. Log types hôm nay (group by user + type)
    pool.query(
      `SELECT user_id, log_type
       FROM logs_common
       WHERE user_id = ANY($1::int[])
         AND occurred_at >= CURRENT_DATE
         AND occurred_at < CURRENT_DATE + INTERVAL '1 day'
       GROUP BY user_id, log_type`,
      [ids]
    ),

    // 3. Lần cuối log
    pool.query(
      `SELECT user_id,
              EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at))) / 3600 AS hours_since_log
       FROM logs_common
       WHERE user_id = ANY($1::int[])
       GROUP BY user_id`,
      [ids]
    ),

    // 4. Lần cuối brain check-in
    pool.query(
      `SELECT user_id,
              EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS hours_since_brain
       FROM asinu_brain_sessions
       WHERE user_id = ANY($1::int[])
       GROUP BY user_id`,
      [ids]
    ),

    // 5. Glucose gần nhất mỗi user (7 ngày) — DISTINCT ON lấy row mới nhất
    pool.query(
      `SELECT DISTINCT ON (c.user_id)
              c.user_id, d.value, d.unit, c.occurred_at
       FROM logs_common c
       JOIN glucose_logs d ON d.log_id = c.id
       WHERE c.user_id = ANY($1::int[])
         AND c.log_type = 'glucose'
         AND c.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY c.user_id, c.occurred_at DESC`,
      [ids]
    ),

    // 6. Huyết áp gần nhất mỗi user (7 ngày)
    pool.query(
      `SELECT DISTINCT ON (c.user_id)
              c.user_id, d.systolic, d.diastolic, c.occurred_at
       FROM logs_common c
       JOIN blood_pressure_logs d ON d.log_id = c.id
       WHERE c.user_id = ANY($1::int[])
         AND c.log_type = 'bp'
         AND c.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY c.user_id, c.occurred_at DESC`,
      [ids]
    ),
  ]);

  // Index các kết quả theo user_id
  const profiles    = new Map(profileRows.rows.map(r => [r.user_id, r]));
  const lastLogs    = new Map(lastLogRows.rows.map(r => [r.user_id, r]));
  const lastBrains  = new Map(lastBrainRows.rows.map(r => [r.user_id, r]));
  const glucoses    = new Map(glucoseRows.rows.map(r => [r.user_id, r]));
  const bps         = new Map(bpRows.rows.map(r => [r.user_id, r]));

  // today log types: group by user_id → string[]
  const todayLogs = new Map();
  for (const r of todayLogRows.rows) {
    if (!todayLogs.has(r.user_id)) todayLogs.set(r.user_id, []);
    todayLogs.get(r.user_id).push(r.log_type);
  }

  // Assemble context map
  const result = new Map();
  for (const uid of userIds) {
    const ll  = lastLogs.get(uid);
    const lb  = lastBrains.get(uid);
    const types = todayLogs.get(uid) ?? [];
    result.set(uid, {
      profile:           profiles.get(uid)  ?? null,
      todayLogTypes:     types,
      loggedTodayCount:  types.length,
      hoursSinceLastLog: ll  ? Math.round(parseFloat(ll.hours_since_log))   : null,
      hoursSinceLastBrain: lb ? Math.round(parseFloat(lb.hours_since_brain)) : null,
      latestGlucose:     glucoses.get(uid)  ?? null,
      latestBp:          bps.get(uid)       ?? null,
    });
  }
  return result;
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

  const angles = isEn
    ? [
        goal ? `their goal: "${goal}"` : null,
        conditions ? `their condition: ${conditions}` : null,
        loggedTodayCount === 0 ? 'they haven\'t logged any health data today' : null,
        hoursSinceLastBrain !== null && hoursSinceLastBrain > 24 ? 'they haven\'t checked in with Asinu recently' : null,
        'general encouragement to stay consistent with their health journey',
      ].filter(Boolean)
    : [
        goal ? `mục tiêu "${goal}" của họ` : null,
        conditions ? `bệnh lý ${conditions} của họ` : null,
        loggedTodayCount === 0 ? 'hôm nay chưa khai báo chỉ số sức khoẻ nào' : null,
        hoursSinceLastBrain !== null && hoursSinceLastBrain > 24 ? 'chưa check-in với Asinu gần đây' : null,
        'động lực duy trì thói quen sức khoẻ hàng ngày',
      ].filter(Boolean);

  const prompt = isEn
    ? `You are Asinu, a warm and caring health companion app.

USER: ${name}${goal ? `, goal: "${goal}"` : ''}${conditions ? `, conditions: ${conditions}` : ''}

RECENT ACTIVITY:
${activityLines.join('\n')}

POSSIBLE ANGLES (pick ONE that feels most natural and personal for this user):
${angles.map((a, i) => `${i + 1}. Focus on ${a}`).join('\n')}

TASK: Write ONE short push notification to bring the user back to the app.
- Sound like a caring friend, NOT a reminder bot
- Be creative — avoid generic "you haven't logged" phrasing
- Personalize using their name, goal, or health condition when relevant
- Max 80 characters for body
- Do NOT mention specific numbers or values
${isPreview ? '- PREVIEW mode — always generate content, always return shouldSend: true' : '- If inactive > 14 days → return shouldSend: false (user likely churned)'}

Reply in strict JSON only (no extra text):
{"shouldSend": true, "title": "Asinu", "body": "notification text here"}`
    : `Bạn là Asinu — người bạn đồng hành sức khoẻ ấm áp và quan tâm.

NGƯỜI DÙNG: ${name}${goal ? `, mục tiêu: "${goal}"` : ''}${conditions ? `, bệnh lý: ${conditions}` : ''}

HOẠT ĐỘNG GẦN ĐÂY:
${activityLines.join('\n')}

CÁC GÓC ĐỘ CÓ THỂ DÙNG (chọn MỘT góc tự nhiên và phù hợp nhất với người dùng này):
${angles.map((a, i) => `${i + 1}. Tập trung vào ${a}`).join('\n')}

NHIỆM VỤ: Viết MỘT thông báo push ngắn để kéo người dùng mở app.
- Giọng như người bạn quan tâm, KHÔNG như bot nhắc nhở
- Sáng tạo — tránh câu kiểu "bạn chưa khai báo..." nhàm chán
- Cá nhân hoá bằng tên, mục tiêu, hoặc bệnh lý khi phù hợp
- Tối đa 80 ký tự phần body
- KHÔNG đề cập số liệu cụ thể
${isPreview ? '- Chế độ PREVIEW — luôn sinh nội dung, luôn trả về shouldSend: true' : '- Nếu không vào app > 14 ngày → trả về shouldSend: false'}

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

  const users = await getEligibleUsers(pool);

  // Batch: lấy context của tất cả users trong 6 queries thay vì 6×N
  const contextMap = await getBatchContexts(pool, users.map(u => u.id));

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const context = contextMap.get(user.id);
      const lang = user.language_preference || 'vi';
      const decision = await generateEngagementNotification(user, context, lang);

      if (!decision.shouldSend) {

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

        sent++;
      } else {

        errors++;
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {

      errors++;
    }
  }

  return { ok: true, total: users.length, sent, skipped, errors };
}

module.exports = {
  runEngagementNotifications,
  generateEngagementNotification,
  getUserContext,
  getBatchContexts,
  previewEngagementNotification,
};
