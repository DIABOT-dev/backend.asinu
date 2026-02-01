const { logBaseSchema, logDataSchemas } = require('../validation/validation.schemas');
const { updateMissionProgress } = require('../services/missions.service');

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

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validateMobileLog(payload) {
  const base = logBaseSchema.safeParse(payload);
  if (!base.success) {
    return { ok: false, error: 'Dữ liệu không hợp lệ', details: base.error.issues };
  }

  const dataSchema = logDataSchemas[base.data.log_type];
  if (!dataSchema) {
    return { ok: false, error: 'Loại nhật ký không hợp lệ' };
  }

  const dataParsed = dataSchema.safeParse(base.data.data || {});
  if (!dataParsed.success) {
    return { ok: false, error: 'Dữ liệu không hợp lệ', details: dataParsed.error.issues };
  }

  return { ok: true, value: { ...base.data, data: dataParsed.data } };
}

async function createMobileLog(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  if (req.body?.user_id && Number(req.body.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'ID người dùng không khớp' });
  }

  const validation = validateMobileLog(req.body || {});
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error, details: validation.details });
  }

  const payload = validation.value;
  const logType = payload.log_type;
  const occurredAt = payload.occurred_at;
  const source = payload.source || 'manual';
  const note = payload.note || null;
  const metadata = isObject(payload.metadata) ? payload.metadata : {};
  const data = payload.data;

  const occurredDate = new Date(occurredAt);
  if (Number.isNaN(occurredDate.getTime())) {
    return res.status(400).json({ ok: false, error: 'Thời gian không hợp lệ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const commonResult = await client.query(
      `INSERT INTO logs_common (user_id, log_type, occurred_at, source, note, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [req.user.id, logType, occurredDate.toISOString(), source, note, metadata]
    );

    const logId = commonResult.rows[0].id;

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
        throw new Error('Unsupported log_type');
    }

    await client.query('COMMIT');

    // Update mission progress based on log type
    try {
      const missionMapping = {
        'glucose': { key: 'log_glucose', goal: 2 },
        'bp': { key: 'log_bp', goal: 2 },
        'weight': { key: 'log_weight', goal: 1 },
        'water': { key: 'log_water', goal: 4 },
        'meal': { key: 'log_meal', goal: 3 },
        'insulin': { key: 'log_insulin', goal: 1 },
        'medication': { key: 'log_medication', goal: 1 }
      };

      const mission = missionMapping[logType];
      if (mission) {
        await updateMissionProgress(pool, req.user.id, mission.key, 1, { goal: mission.goal, now: occurredDate });
        console.log(`[mobile] Updated mission ${mission.key} for user ${req.user.id}`);
      }

      // Also update daily_checkin for any health log
      await updateMissionProgress(pool, req.user.id, 'daily_checkin', 1, { goal: 1, now: occurredDate });
    } catch (missionErr) {
      console.warn('Failed to update mission progress:', missionErr.message);
    }

    return res.status(200).json({ ok: true, log_id: logId, log_type: logType });
  } catch (err) {
    await client.query('ROLLBACK');
    const message = err.message || 'Invalid payload';
    const status = message.startsWith('Missing') || message.startsWith('Invalid') ? 400 : 500;
    return res.status(status).json({ ok: false, error: message });
  } finally {
    client.release();
  }
}

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

async function getRecentLogs(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  const type = req.query.type;
  const limitRaw = Number(req.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  if (type && !VALID_LOG_TYPES.has(type)) {
    return res.status(400).json({ ok: false, error: 'Loại nhật ký không hợp lệ' });
  }

  if (!type) {
    // Fetch all recent logs with details - simpler approach
    console.log('[mobile.controller] Fetching logs for user:', req.user.id, 'limit:', limit);
    const commonResult = await pool.query(
      `SELECT id, log_type, occurred_at, source, note, metadata, created_at
       FROM logs_common
       WHERE user_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );

    console.log('[mobile.controller] Found', commonResult.rows.length, 'logs');

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

    console.log('[mobile.controller] Returning', logs.length, 'logs with details');
    console.log('[mobile.controller] First log:', JSON.stringify(logs[0], null, 2));
    return res.status(200).json({ ok: true, logs });
  }

  const detail = DETAIL_TABLES[type];
  const detailColumns = detail.columns.map((col) => `d.${col}`).join(', ');
  const result = await pool.query(
    `SELECT c.id, c.log_type, c.occurred_at, c.source, c.note, c.metadata, c.created_at, ${detailColumns}
     FROM logs_common c
     JOIN ${detail.table} d ON d.log_id = c.id
     WHERE c.user_id = $1 AND c.log_type = $2
     ORDER BY c.occurred_at DESC
     LIMIT $3`,
    [req.user.id, type, limit]
  );

  const logs = result.rows.map((row) => {
    const detailData = {};
    for (const col of detail.columns) {
      detailData[col] = row[col];
      delete row[col];
    }
    return { ...row, detail: detailData };
  });

  return res.status(200).json({ ok: true, logs });
}

module.exports = { createMobileLog, getRecentLogs };
