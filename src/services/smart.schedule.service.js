/**
 * Smart Schedule Service
 *
 * Học từ hành vi thực tế của user (logs_common.occurred_at) để suy ra
 * khung giờ tối ưu cho từng loại thông báo.
 *
 * Effective hour = user-set → inferred → system default
 */

const DEFAULTS = { morning: 8, evening: 21, water: 14 };

// Số log tối thiểu để infer (tránh kết luận từ quá ít data)
const MIN_LOGS_MORNING = 5;
const MIN_LOGS_EVENING = 5;
const MIN_LOGS_WATER   = 3;

// Không re-infer nếu đã infer trong vòng 7 ngày
const INFER_STALE_DAYS = 7;

// ─── Core inference ────────────────────────────────────────────────

/**
 * Phân tích log history 60 ngày để tìm khung giờ đỉnh.
 * @returns {{ morning_hour, evening_hour, water_hour }} — null nếu không đủ data
 */
async function inferHours(pool, userId) {
  const { rows } = await pool.query(
    `SELECT
       EXTRACT(HOUR FROM occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::smallint AS hour,
       log_type,
       COUNT(*)::int AS cnt
     FROM logs_common
     WHERE user_id = $1
       AND occurred_at >= NOW() - INTERVAL '60 days'
     GROUP BY hour, log_type`,
    [userId]
  );

  // Tổng count theo giờ trong một khung (có thể lọc theo log_type)
  function sumByHour(minH, maxH, typeFilter = null) {
    const map = {};
    for (const r of rows) {
      if (r.hour < minH || r.hour > maxH) continue;
      if (typeFilter && r.log_type !== typeFilter) continue;
      map[r.hour] = (map[r.hour] || 0) + r.cnt;
    }
    return map;
  }

  function peakHour(byHour, minCount) {
    const total = Object.values(byHour).reduce((s, c) => s + c, 0);
    if (total < minCount) return null;
    const [hour] = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    return parseInt(hour);
  }

  return {
    morning_hour: peakHour(sumByHour(5,  11),       MIN_LOGS_MORNING),
    evening_hour: peakHour(sumByHour(17, 23),        MIN_LOGS_EVENING),
    water_hour:   peakHour(sumByHour(10, 18, 'water'), MIN_LOGS_WATER),
  };
}

// ─── DB operations ─────────────────────────────────────────────────

/**
 * Refresh inferred hours nếu đã cũ hơn INFER_STALE_DAYS.
 * Truyền force=true để luôn re-infer.
 */
async function refreshInferredHours(pool, userId, { force = false } = {}) {
  if (!force) {
    const { rows } = await pool.query(
      `SELECT inferred_at FROM user_notification_preferences WHERE user_id = $1`,
      [userId]
    );
    const inferredAt = rows[0]?.inferred_at;
    if (inferredAt) {
      const ageDays = (Date.now() - new Date(inferredAt).getTime()) / 86_400_000;
      if (ageDays < INFER_STALE_DAYS) return null;
    }
  }

  const { morning_hour, evening_hour, water_hour } = await inferHours(pool, userId);

  await pool.query(
    `INSERT INTO user_notification_preferences
       (user_id, inferred_morning_hour, inferred_evening_hour, inferred_water_hour, inferred_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       inferred_morning_hour = $2,
       inferred_evening_hour = $3,
       inferred_water_hour   = $4,
       inferred_at           = NOW()`,
    [userId, morning_hour, evening_hour, water_hour]
  );

  return { morning_hour, evening_hour, water_hour };
}

/**
 * Lấy preferences của user + effective hours để trả về frontend.
 */
async function getPreferences(pool, userId) {
  await refreshInferredHours(pool, userId);

  const { rows } = await pool.query(
    `SELECT morning_hour, evening_hour, water_hour,
            inferred_morning_hour, inferred_evening_hour, inferred_water_hour,
            inferred_at, updated_at, reminders_enabled
     FROM user_notification_preferences
     WHERE user_id = $1`,
    [userId]
  );

  const p = rows[0] || {};
  return {
    morning_hour: p.morning_hour ?? null,
    evening_hour: p.evening_hour ?? null,
    water_hour:   p.water_hour   ?? null,

    inferred_morning_hour: p.inferred_morning_hour ?? null,
    inferred_evening_hour: p.inferred_evening_hour ?? null,
    inferred_water_hour:   p.inferred_water_hour   ?? null,
    inferred_at:           p.inferred_at           ?? null,

    // Giờ thực tế sẽ dùng: user-set → inferred → default
    effective_morning_hour: p.morning_hour ?? p.inferred_morning_hour ?? DEFAULTS.morning,
    effective_evening_hour: p.evening_hour ?? p.inferred_evening_hour ?? DEFAULTS.evening,
    effective_water_hour:   p.water_hour   ?? p.inferred_water_hour   ?? DEFAULTS.water,

    reminders_enabled: p.reminders_enabled !== false, // default true if no row yet
  };
}

/**
 * Lưu preferences do user chọn. Truyền null để reset về auto.
 */
async function updatePreferences(pool, userId, { morning_hour, evening_hour, water_hour, reminders_enabled }) {
  const hasReminders = reminders_enabled !== undefined;
  await pool.query(
    `INSERT INTO user_notification_preferences
       (user_id, morning_hour, evening_hour, water_hour, reminders_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       morning_hour      = $2,
       evening_hour      = $3,
       water_hour        = $4,
       reminders_enabled = CASE WHEN $6 THEN $5 ELSE user_notification_preferences.reminders_enabled END,
       updated_at        = NOW()`,
    [userId, morning_hour ?? null, evening_hour ?? null, water_hour ?? null,
     hasReminders ? reminders_enabled : true, hasReminders]
  );
}

module.exports = { getPreferences, updatePreferences, refreshInferredHours, DEFAULTS };
