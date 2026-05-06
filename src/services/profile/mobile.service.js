/**
 * Mobile Logs Service
 * Business logic cho health logs từ mobile app
 */

const { t } = require('../../i18n');
const { cacheDel } = require('../../lib/redis');
const { sendAndSave } = require('../notification/basic.notification.service');

const VALID_LOG_TYPES = new Set([
  'glucose',
  'bp',
  'weight',
  'water',
  'meal',
  'insulin',
  'medication',
  'care_pulse',
]);

const DETAIL_TABLES = {
  glucose: { table: 'glucose_logs', columns: ['value', 'unit', 'context', 'meal_tag'] },
  bp: { table: 'blood_pressure_logs', columns: ['systolic', 'diastolic', 'pulse', 'unit'] },
  weight: { table: 'weight_logs', columns: ['weight_kg', 'body_fat_percent', 'muscle_percent'] },
  water: { table: 'water_logs', columns: ['volume_ml'] },
  meal: { table: 'meal_logs', columns: ['calories_kcal', 'carbs_g', 'protein_g', 'fat_g', 'meal_text', 'photo_url'] },
  insulin: { table: 'insulin_logs', columns: ['insulin_type', 'dose_units', 'unit', 'timing', 'injection_site'] },
  medication: { table: 'medication_logs', columns: ['med_name', 'dose_text', 'dose_value', 'dose_unit', 'frequency_text'] },
  care_pulse: { table: 'care_pulse_logs', columns: ['status', 'sub_status', 'trigger_source', 'escalation_sent', 'silence_count'] },
};

const MISSION_MAPPING = {
  'glucose': { key: 'log_glucose', goal: 2 },
  'bp': { key: 'log_bp', goal: 2 },
  'weight': { key: 'log_weight', goal: 1 },
  'water': { key: 'log_water', goal: 4 },
  'meal': { key: 'log_meal', goal: 3 },
  'insulin': { key: 'log_insulin', goal: 1 },
  'medication': { key: 'log_medication', goal: 1 }
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Insert detail log into specific table
 */
async function insertDetailLog(client, logType, logId, data) {
  switch (logType) {
    case 'glucose': {
      await client.query(
        `INSERT INTO glucose_logs (log_id, value, unit, context, meal_tag)
         VALUES ($1, $2, $3, $4, $5)`,
        [logId, data.value, data.unit || 'mg/dL', data.context || null, data.meal_tag || null]
      );
      break;
    }
    case 'bp': {
      await client.query(
        `INSERT INTO blood_pressure_logs (log_id, systolic, diastolic, pulse, unit)
         VALUES ($1, $2, $3, $4, $5)`,
        [logId, data.systolic, data.diastolic, data.pulse || null, data.unit || 'mmHg']
      );
      break;
    }
    case 'weight': {
      await client.query(
        `INSERT INTO weight_logs (log_id, weight_kg, body_fat_percent, muscle_percent)
         VALUES ($1, $2, $3, $4)`,
        [logId, data.weight_kg, data.body_fat_percent || null, data.muscle_percent || null]
      );
      break;
    }
    case 'water': {
      await client.query(
        `INSERT INTO water_logs (log_id, volume_ml)
         VALUES ($1, $2)`,
        [logId, data.volume_ml]
      );
      break;
    }
    case 'meal': {
      await client.query(
        `INSERT INTO meal_logs (log_id, calories_kcal, carbs_g, protein_g, fat_g, meal_text, photo_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          logId,
          data.calories_kcal ?? null,
          data.carbs_g ?? null,
          data.protein_g ?? null,
          data.fat_g ?? null,
          data.meal_text || null,
          data.photo_url || null
        ]
      );
      break;
    }
    case 'insulin': {
      await client.query(
        `INSERT INTO insulin_logs (log_id, insulin_type, dose_units, unit, timing, injection_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          logId,
          data.insulin_type || null,
          data.dose_units,
          data.unit || 'U',
          data.timing || null,
          data.injection_site || null
        ]
      );
      break;
    }
    case 'medication': {
      await client.query(
        `INSERT INTO medication_logs (log_id, med_name, dose_text, dose_value, dose_unit, frequency_text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          logId,
          data.med_name,
          data.dose_text,
          data.dose_value ?? null,
          data.dose_unit || null,
          data.frequency_text || null
        ]
      );
      break;
    }
    case 'care_pulse': {
      await client.query(
        `INSERT INTO care_pulse_logs (log_id, status, sub_status, trigger_source, escalation_sent, silence_count)
         VALUES ($1, $2, $3, $4, FALSE, 0)`,
        [logId, data.status, data.sub_status || null, data.trigger_source]
      );
      break;
    }
    default:
      throw new Error(t('error.unsupported_log_type'));
  }
}

/**
 * Check critical health values after logging and alert care circle caregivers.
 * Runs async (fire-and-forget) so it doesn't block the log response.
 */
async function checkAndAlertCareCircle(pool, userId, logType, data) {
  let severity = null;
  let title = '';
  let body = '';

  if (logType === 'glucose' && data.value) {
    const v = parseFloat(data.value);
    if (v > 250 || v < 70) {
      severity = 'critical';
      title = v > 250 ? 'Đường huyết rất cao' : 'Đường huyết rất thấp';
      body = `Chỉ số đường huyết: ${v} mg/dL`;
    }
  }

  if (logType === 'bp' && data.systolic && data.diastolic) {
    const sys = parseFloat(data.systolic);
    const dia = parseFloat(data.diastolic);
    if (sys >= 180 || dia >= 110) {
      severity = 'critical';
      title = 'Huyết áp nguy hiểm';
      body = `Huyết áp: ${sys}/${dia} mmHg`;
    }
  }

  if (!severity) return;

  // Skip if health_alert was already sent for this user in the last 10 minutes
  const { rows: recentAlert } = await pool.query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'health_alert'
       AND created_at >= NOW() - make_interval(mins => 10) LIMIT 1`,
    [userId]
  );
  if (recentAlert.length > 0) return;

  // Get user name
  const { rows: [user] } = await pool.query(
    'SELECT full_name, display_name FROM users WHERE id = $1', [userId]
  );
  const name = user?.full_name || user?.display_name || `User ${userId}`;

  // Notify the user themselves
  await sendAndSave(pool, { id: userId, push_token: null }, 'health_alert',
    title, body, { alertType: logType, severity });

  // Find care circle caregivers with alert permission
  const { rows: caregivers } = await pool.query(
    `SELECT u.id, u.push_token
     FROM user_connections uc
     JOIN users u ON (
       CASE WHEN uc.requester_id = $1 THEN uc.addressee_id ELSE uc.requester_id END = u.id
     )
     WHERE uc.status = 'accepted'
       AND (uc.requester_id = $1 OR uc.addressee_id = $1)
       AND u.deleted_at IS NULL
       AND (uc.permissions->>'can_receive_alerts')::boolean = true`,
    [userId]
  );

  for (const cg of caregivers) {
    await sendAndSave(pool, cg, 'health_alert',
      `${name}: ${title}`, body,
      { alertType: logType, severity, patientId: userId });
  }
}

/**
 * Create a new mobile log
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} payload - Log payload (validated)
 * @returns {Promise<Object>} - { ok, logId, logType, error }
 */
async function createLog(pool, userId, payload) {
  const { updateMissionProgress } = require('../missions/missions.service');
  
  const logType = payload.log_type;
  const occurredAt = payload.occurred_at;
  const source = payload.source || 'manual';
  const note = payload.note || null;
  const metadata = isObject(payload.metadata) ? payload.metadata : {};
  const data = payload.data;

  const occurredDate = new Date(occurredAt);
  if (Number.isNaN(occurredDate.getTime())) {
    return { ok: false, error: t('error.invalid_time'), statusCode: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const commonResult = await client.query(
      `INSERT INTO logs_common (user_id, log_type, occurred_at, source, note, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, logType, occurredDate.toISOString(), source, note, metadata]
    );

    const logId = commonResult.rows[0].id;

    await insertDetailLog(client, logType, logId, data);

    await client.query('COMMIT');

    // Update mission progress based on log type
    try {
      const mission = MISSION_MAPPING[logType];
      if (mission) {
        await updateMissionProgress(pool, userId, mission.key, 1, { goal: mission.goal, now: occurredDate });

      }

      // Also update daily_checkin for any health log
      await updateMissionProgress(pool, userId, 'daily_checkin', 1, { goal: 1, now: occurredDate });
    } catch (missionErr) {

    }

    // Invalidate related caches when new health log is created
    await cacheDel(
      `tree:summary:${userId}`, `tree:history:${userId}`,
      `health:score:${userId}`, `missions:${userId}`
    );

    // Check critical health values and alert care circle
    checkAndAlertCareCircle(pool, userId, logType, data).catch(() => {});

    return { ok: true, logId, logType };
  } catch (err) {
    await client.query('ROLLBACK');

    const message = err.message || t('error.invalid_payload');
    const isValidationError = message.startsWith('Missing') || message.startsWith('Invalid');
    return { ok: false, error: message, statusCode: isValidationError ? 400 : 500 };
  } finally {
    client.release();
  }
}

/**
 * Get recent logs for a user
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} options - { type, limit }
 * @returns {Promise<Object>} - { ok, logs, error }
 */
async function getRecentLogs(pool, userId, options = {}) {
  const { type, limit: limitRaw = 50 } = options;
  const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);

  if (type && !VALID_LOG_TYPES.has(type)) {
    return { ok: false, error: t('error.invalid_log_type'), statusCode: 400 };
  }

  // History filter: 7 days for free, 365 days for premium
  let historyFilter = `AND occurred_at > NOW() - INTERVAL '7 days'`; // default free
  try {
    const tierRow = await pool.query(
      `SELECT subscription_tier, subscription_expires_at FROM users WHERE id = $1`,
      [userId]
    );
    const row = tierRow.rows[0];
    const isUserPremium = row?.subscription_tier === 'premium' && row?.subscription_expires_at && new Date(row.subscription_expires_at) > new Date();
    historyFilter = isUserPremium
      ? `AND occurred_at > NOW() - INTERVAL '365 days'`
      : `AND occurred_at > NOW() - INTERVAL '7 days'`;
  } catch (_) { /* fall through — keep 7-day default */ }

  try {
    if (!type) {
      // Fetch all recent logs with details

      const commonResult = await pool.query(
        `SELECT id, log_type, occurred_at, source, note, metadata, created_at
         FROM logs_common
         WHERE user_id = $1 ${historyFilter}
         ORDER BY occurred_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      // Fetch details for each log type
      const logs = await Promise.all(
        commonResult.rows.map(async (commonLog) => {
          const detailData = {};
          const detail = DETAIL_TABLES[commonLog.log_type];
          
          if (detail) {
            const detailResult = await pool.query(
              `SELECT ${detail.columns.join(', ')} FROM ${detail.table} WHERE log_id = $1`,
              [commonLog.id]
            );
            
            if (detailResult.rows.length > 0) {
              detail.columns.forEach(col => {
                detailData[col] = detailResult.rows[0][col];
              });
            }
          }
          
          return {
            ...commonLog,
            detail: detailData
          };
        })
      );

      return { ok: true, logs };
    }

    // Fetch specific type with join
    const detail = DETAIL_TABLES[type];
    const detailColumns = detail.columns.map((col) => `d.${col}`).join(', ');

    const result = await pool.query(
      `SELECT c.id, c.log_type, c.occurred_at, c.source, c.note, c.metadata, c.created_at, ${detailColumns}
       FROM logs_common c
       JOIN ${detail.table} d ON d.log_id = c.id
       WHERE c.user_id = $1 AND c.log_type = $2 ${historyFilter}
       ORDER BY c.occurred_at DESC
       LIMIT $3`,
      [userId, type, limit]
    );

    const logs = result.rows.map((row) => {
      const detailData = {};
      for (const col of detail.columns) {
        detailData[col] = row[col];
        delete row[col];
      }
      return { ...row, detail: detailData };
    });

    return { ok: true, logs };
  } catch (err) {

    return { ok: false, error: t('error.server') };
  }
}

/**
 * Lấy logs của ngày hôm nay (timezone VN)
 */
async function getTodayLogs(pool, userId, options = {}) {
  const { type } = options;

  if (type && !VALID_LOG_TYPES.has(type)) {
    return { ok: false, error: t('error.invalid_log_type'), statusCode: 400 };
  }

  try {
    const todayCondition = "DATE(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = CURRENT_DATE";

    if (!type) {
      // Lấy tất cả logs hôm nay

      const commonResult = await pool.query(
        `SELECT id, log_type, occurred_at, source, note, metadata, created_at
         FROM logs_common
         WHERE user_id = $1 AND ${todayCondition}
         ORDER BY occurred_at DESC`,
        [userId]
      );

      // Lấy chi tiết cho từng log
      const logs = await Promise.all(
        commonResult.rows.map(async (commonLog) => {
          const detailData = {};
          const detail = DETAIL_TABLES[commonLog.log_type];
          
          if (detail) {
            const detailResult = await pool.query(
              `SELECT ${detail.columns.join(', ')} FROM ${detail.table} WHERE log_id = $1`,
              [commonLog.id]
            );
            
            if (detailResult.rows.length > 0) {
              detail.columns.forEach(col => {
                detailData[col] = detailResult.rows[0][col];
              });
            }
          }
          
          return {
            ...commonLog,
            detail: detailData
          };
        })
      );

      // Thống kê theo loại
      const typeCount = {};
      logs.forEach(log => {
        typeCount[log.log_type] = (typeCount[log.log_type] || 0) + 1;
      });

      return { ok: true, logs, count: logs.length, breakdown: typeCount };
    }

    // Lấy logs hôm nay theo loại cụ thể
    const detail = DETAIL_TABLES[type];
    const detailColumns = detail.columns.map((col) => `d.${col}`).join(', ');
    
    const result = await pool.query(
      `SELECT c.id, c.log_type, c.occurred_at, c.source, c.note, c.metadata, c.created_at, ${detailColumns}
       FROM logs_common c
       JOIN ${detail.table} d ON d.log_id = c.id
       WHERE c.user_id = $1 AND c.log_type = $2 AND ${todayCondition}
       ORDER BY c.occurred_at DESC`,
      [userId, type]
    );

    const logs = result.rows.map((row) => {
      const detailData = {};
      for (const col of detail.columns) {
        detailData[col] = row[col];
        delete row[col];
      }
      return { ...row, detail: detailData };
    });

    return { ok: true, logs, count: logs.length };
  } catch (err) {

    return { ok: false, error: t('error.get_today_logs'), statusCode: 500 };
  }
}

/**
 * Check if log type is valid
 */
function isValidLogType(type) {
  return VALID_LOG_TYPES.has(type);
}

module.exports = {
  createLog,
  getRecentLogs,
  getTodayLogs,
  isValidLogType,
  VALID_LOG_TYPES,
  DETAIL_TABLES,
  MISSION_MAPPING
};
