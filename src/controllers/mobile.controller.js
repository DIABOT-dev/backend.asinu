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

const VALID_GLUCOSE_CONTEXT = new Set([
  'fasting',
  'pre_meal',
  'post_meal',
  'before_sleep',
  'random',
]);

const VALID_INSULIN_TIMING = new Set(['pre_meal', 'post_meal', 'bedtime', 'correction']);
const VALID_CARE_PULSE_STATUS = new Set(['NORMAL', 'TIRED', 'EMERGENCY']);
const VALID_CARE_PULSE_TRIGGER = new Set(['POPUP', 'HOME_WIDGET', 'EMERGENCY_BUTTON']);

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

async function createMobileLog(pool, req, res) {
  res.set('Cache-Control', 'no-store');

  const payload = req.body || {};
  const logType = payload.log_type;
  const occurredAt = payload.occurred_at;
  const source = payload.source || 'manual';
  const note = payload.note || null;
  const metadata = isObject(payload.metadata) ? payload.metadata : {};
  const data = isObject(payload.data) ? payload.data : null;

  if (!VALID_LOG_TYPES.has(logType)) {
    return res.status(400).json({ ok: false, error: 'Invalid log_type' });
  }

  if (!occurredAt) {
    return res.status(400).json({ ok: false, error: 'Missing occurred_at' });
  }

  const occurredDate = new Date(occurredAt);
  if (Number.isNaN(occurredDate.getTime())) {
    return res.status(400).json({ ok: false, error: 'Invalid occurred_at' });
  }

  if (!data) {
    return res.status(400).json({ ok: false, error: 'Missing data' });
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
        const value = toNumber(data.value);
        if (value === null) {
          throw new Error('Missing glucose value');
        }
        const unit = data.unit || 'mg/dL';
        const context = data.context;
        const mealTag = data.meal_tag;
        if (context && !VALID_GLUCOSE_CONTEXT.has(context)) {
          throw new Error('Invalid glucose context');
        }
        await client.query(
          `INSERT INTO glucose_logs (log_id, value, unit, context, meal_tag)
           VALUES ($1, $2, $3, $4, $5)`,
          [logId, value, unit, context || null, mealTag || null]
        );
        break;
      }
      case 'bp': {
        const systolic = toNumber(data.systolic);
        const diastolic = toNumber(data.diastolic);
        const pulse = toNumber(data.pulse);
        if (systolic === null || diastolic === null) {
          throw new Error('Missing systolic or diastolic');
        }
        const unit = data.unit || 'mmHg';
        await client.query(
          `INSERT INTO blood_pressure_logs (log_id, systolic, diastolic, pulse, unit)
           VALUES ($1, $2, $3, $4, $5)`,
          [logId, systolic, diastolic, pulse, unit]
        );
        break;
      }
      case 'weight': {
        const weightKg = toNumber(data.weight_kg);
        if (weightKg === null) {
          throw new Error('Missing weight_kg');
        }
        const bodyFat = toNumber(data.body_fat_percent);
        const muscle = toNumber(data.muscle_percent);
        await client.query(
          `INSERT INTO weight_logs (log_id, weight_kg, body_fat_percent, muscle_percent)
           VALUES ($1, $2, $3, $4)`,
          [logId, weightKg, bodyFat, muscle]
        );
        break;
      }
      case 'water': {
        const volume = toNumber(data.volume_ml);
        if (volume === null) {
          throw new Error('Missing volume_ml');
        }
        await client.query(
          `INSERT INTO water_logs (log_id, volume_ml)
           VALUES ($1, $2)`,
          [logId, volume]
        );
        break;
      }
      case 'meal': {
        const calories = toNumber(data.calories_kcal);
        const macros = isObject(data.macros) ? data.macros : {};
        const carbs = toNumber(macros.carbs_g);
        const protein = toNumber(macros.protein_g);
        const fat = toNumber(macros.fat_g);
        const mealText = data.meal_text || null;
        const photoUrl = data.photo_url || null;
        await client.query(
          `INSERT INTO meal_logs (log_id, calories_kcal, carbs_g, protein_g, fat_g, meal_text, photo_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [logId, calories, carbs, protein, fat, mealText, photoUrl]
        );
        break;
      }
      case 'insulin': {
        const doseUnits = toNumber(data.dose_units);
        if (doseUnits === null) {
          throw new Error('Missing dose_units');
        }
        const unit = data.unit || 'U';
        const timing = data.timing || null;
        if (timing && !VALID_INSULIN_TIMING.has(timing)) {
          throw new Error('Invalid insulin timing');
        }
        await client.query(
          `INSERT INTO insulin_logs (log_id, insulin_type, dose_units, unit, timing, injection_site)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [logId, data.insulin_type || null, doseUnits, unit, timing, data.injection_site || null]
        );
        break;
      }
      case 'medication': {
        const medName = data.med_name;
        const doseText = data.dose_text;
        if (!medName || !doseText) {
          throw new Error('Missing med_name or dose_text');
        }
        const doseValue = toNumber(data.dose_value);
        const doseUnit = data.dose_unit || null;
        const frequencyText = data.frequency_text || null;
        await client.query(
          `INSERT INTO medication_logs (log_id, med_name, dose_text, dose_value, dose_unit, frequency_text)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [logId, medName, doseText, doseValue, doseUnit, frequencyText]
        );
        break;
      }
      case 'care_pulse': {
        const status = data.status;
        const triggerSource = data.trigger_source;
        if (!status || !triggerSource) {
          throw new Error('Missing status or trigger_source');
        }
        if (!VALID_CARE_PULSE_STATUS.has(status)) {
          throw new Error('Invalid care_pulse status');
        }
        if (!VALID_CARE_PULSE_TRIGGER.has(triggerSource)) {
          throw new Error('Invalid care_pulse trigger_source');
        }
        await client.query(
          `INSERT INTO care_pulse_logs (log_id, status, sub_status, trigger_source, escalation_sent, silence_count)
           VALUES ($1, $2, $3, $4, FALSE, 0)`,
          [logId, status, data.sub_status || null, triggerSource]
        );
        break;
      }
      default:
        throw new Error('Unsupported log_type');
    }

    await client.query('COMMIT');
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
    return res.status(400).json({ ok: false, error: 'Invalid log_type' });
  }

  if (!type) {
    const result = await pool.query(
      `SELECT id, log_type, occurred_at, source, note, metadata, created_at
       FROM logs_common
       WHERE user_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    return res.status(200).json({ ok: true, logs: result.rows });
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
