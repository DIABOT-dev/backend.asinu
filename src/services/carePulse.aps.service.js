const { t } = require('../i18n');
﻿const { randomUUID } = require('crypto');
const { updateMissionProgress } = require('./missions.service');

const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const SIGMA_FLOOR = 5;

const DEFAULT_BASELINE = {
  timezone: 'Asia/Bangkok',
  morning_start_hour: 6,
  morning_end_hour: 10,
  evening_start_hour: 19,
  evening_end_hour: 22,
  tired_interval_minutes: 240,
  emergency_interval_minutes: 90,
  escalation_silence_count: 2,
  escalation_delay_minutes: 20,
  mu_silence_minutes: 10,
  sigma_silence_minutes: 5
};

const APS_WEIGHTS = {
  b: -1.2,
  wA: 0.3,
  wH: 0.9,
  wE: 1.2,
  wS: 1.0,
  wR: 1.3
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const logistic = (x) => 1 / (1 + Math.exp(-x));

const toDate = (value) => (value ? new Date(value) : null);
const toIso = (value) => (value ? new Date(value).toISOString() : null);

const setTime = (date, hour, minute = 0) => {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const isWithinWindow = (date, startHour, endHour) => {
  const start = setTime(date, startHour);
  const end = setTime(date, endHour);
  return date >= start && date < end;
};

const minutesBetween = (later, earlier) => Math.max(0, (later.getTime() - earlier.getTime()) / 60000);

const computeNormalSchedule = (now, lastCheckInAt, baseline) => {
  const morningStart = setTime(now, baseline.morning_start_hour);
  const morningEnd = setTime(now, baseline.morning_end_hour);
  const eveningStart = setTime(now, baseline.evening_start_hour);
  const eveningEnd = setTime(now, baseline.evening_end_hour);

  const inMorning = now >= morningStart && now < morningEnd;
  const inEvening = now >= eveningStart && now < eveningEnd;

  if (inMorning) {
    const checkedIn = Boolean(
      lastCheckInAt && isSameDay(lastCheckInAt, now) && isWithinWindow(lastCheckInAt, baseline.morning_start_hour, baseline.morning_end_hour)
    );
    if (checkedIn) {
      return { nextAskAt: toIso(eveningStart), cooldownUntil: toIso(morningEnd) };
    }
    return { nextAskAt: toIso(morningStart), cooldownUntil: null };
  }

  if (inEvening) {
    const checkedIn = Boolean(
      lastCheckInAt && isSameDay(lastCheckInAt, now) && isWithinWindow(lastCheckInAt, baseline.evening_start_hour, baseline.evening_end_hour)
    );
    if (checkedIn) {
      return { nextAskAt: toIso(setTime(addDays(now, 1), baseline.morning_start_hour)), cooldownUntil: toIso(eveningEnd) };
    }
    return { nextAskAt: toIso(eveningStart), cooldownUntil: null };
  }

  if (now < morningStart) {
    return { nextAskAt: toIso(morningStart), cooldownUntil: null };
  }
  if (now < eveningStart) {
    return { nextAskAt: toIso(eveningStart), cooldownUntil: null };
  }
  return { nextAskAt: toIso(setTime(addDays(now, 1), baseline.morning_start_hour)), cooldownUntil: null };
};

const computeTiredSchedule = (now, lastCheckInAt, baseline) => {
  if (!lastCheckInAt) {
    return { nextAskAt: toIso(now), cooldownUntil: null };
  }
  const nextAsk = new Date(lastCheckInAt.getTime() + baseline.tired_interval_minutes * 60 * 1000);
  return { nextAskAt: toIso(nextAsk), cooldownUntil: toIso(nextAsk) };
};

const computeEmergencySchedule = (now, lastCheckInAt, lastAskAt, baseline) => {
  const base = lastAskAt || lastCheckInAt;
  if (!base) {
    return { nextAskAt: toIso(now), cooldownUntil: null };
  }
  const nextAsk = new Date(base.getTime() + baseline.emergency_interval_minutes * 60 * 1000);
  return { nextAskAt: toIso(nextAsk), cooldownUntil: null };
};

const mapSelfReportToH = (status) => {
  if (status === 'EMERGENCY') return 1;
  if (status === 'TIRED') return 0.6;
  if (status === 'NORMAL') return 0.2;
  return 0;
};

const computeTier = (aps) => {
  if (aps < 0.25) return 0;
  if (aps < 0.5) return 1;
  if (aps < 0.75) return 2;
  return 3;
};

async function ensureBaseline(client, userId) {
  const existing = await client.query(
    `SELECT * FROM user_baselines WHERE user_id = $1`,
    [userId]
  );

  if (existing.rows.length === 0) {
    const inserted = await client.query(
      `INSERT INTO user_baselines (
        user_id,
        timezone,
        morning_start_hour,
        morning_end_hour,
        evening_start_hour,
        evening_end_hour,
        tired_interval_minutes,
        emergency_interval_minutes,
        escalation_silence_count,
        escalation_delay_minutes,
        mu_silence_minutes,
        sigma_silence_minutes,
        source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'system')
      RETURNING *`,
      [
        userId,
        DEFAULT_BASELINE.timezone,
        DEFAULT_BASELINE.morning_start_hour,
        DEFAULT_BASELINE.morning_end_hour,
        DEFAULT_BASELINE.evening_start_hour,
        DEFAULT_BASELINE.evening_end_hour,
        DEFAULT_BASELINE.tired_interval_minutes,
        DEFAULT_BASELINE.emergency_interval_minutes,
        DEFAULT_BASELINE.escalation_silence_count,
        DEFAULT_BASELINE.escalation_delay_minutes,
        DEFAULT_BASELINE.mu_silence_minutes,
        DEFAULT_BASELINE.sigma_silence_minutes
      ]
    );
    return inserted.rows[0];
  }

  const row = existing.rows[0];
  const sigma = Number(row.sigma_silence_minutes || 0);
  if (sigma < SIGMA_FLOOR) {
    const updated = await client.query(
      `UPDATE user_baselines
       SET sigma_silence_minutes = $2, updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, SIGMA_FLOOR]
    );
    return updated.rows[0];
  }

  return row;
}

async function getEngineState(client, userId, forUpdate = true) {
  const clause = forUpdate ? 'FOR UPDATE' : '';
  const existing = await client.query(
    `SELECT * FROM care_pulse_engine_state WHERE user_id = $1 ${clause}`,
    [userId]
  );

  if (existing.rows.length === 0) {
    const inserted = await client.query(
      `INSERT INTO care_pulse_engine_state (
        user_id,
        current_status,
        silence_count,
        emergency_armed,
        aps,
        tier,
        reasons,
        updated_at
      ) VALUES ($1,'NORMAL',0,false,0,0,'[]',NOW())
      RETURNING *`,
      [userId]
    );
    return inserted.rows[0];
  }

  return existing.rows[0];
}

const mapRowToState = (row) => ({
  currentStatus: row.current_status,
  lastCheckInAt: row.last_check_in_at ? row.last_check_in_at.toISOString() : null,
  cooldownUntil: row.cooldown_until ? row.cooldown_until.toISOString() : null,
  nextAskAt: row.next_ask_at ? row.next_ask_at.toISOString() : null,
  silenceCount: Number(row.silence_count || 0),
  emergencyArmed: Boolean(row.emergency_armed),
  emergencyLastAskAt: row.last_ask_at ? row.last_ask_at.toISOString() : null,
  lastAppOpenedAt: row.last_app_opened_at ? row.last_app_opened_at.toISOString() : null,
  episodeId: row.episode_id || null,
  aps: Number(row.aps || 0),
  tier: Number(row.tier || 0),
  reasons: Array.isArray(row.reasons) ? row.reasons : row.reasons || []
});

const parseEventTime = (clientTs, now) => {
  const ts = Number(clientTs);
  if (!Number.isFinite(ts)) return now;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? now : date;
};

const applyEventToState = (state, event, eventTime) => {
  const next = { ...state };
  const prevStatus = next.currentStatus;

  if (event.event_type === 'CHECK_IN') {
    const status = event.self_report || next.currentStatus;
    next.currentStatus = status;
    next.lastCheckInAt = eventTime.toISOString();
    next.silenceCount = 0;

    if (status === 'EMERGENCY') {
      if (prevStatus !== 'EMERGENCY') {
        next.episodeId = randomUUID();
      }
      next.emergencyArmed = true;
      next.emergencyLastAskAt = eventTime.toISOString();
    } else {
      next.emergencyArmed = false;
      next.emergencyLastAskAt = null;
      next.episodeId = null;
    }
  } else if (event.event_type === 'POPUP_SHOWN') {
    next.emergencyLastAskAt = eventTime.toISOString();
  } else if (event.event_type === 'POPUP_DISMISSED') {
    if (next.currentStatus === 'EMERGENCY' && next.emergencyArmed) {
      next.silenceCount += 1;
    }
  } else if (event.event_type === 'APP_OPENED') {
    next.lastAppOpenedAt = eventTime.toISOString();
  }

  return next;
};

const computeSchedule = (now, state, baseline) => {
  const lastCheckIn = toDate(state.lastCheckInAt);
  const lastAsk = toDate(state.emergencyLastAskAt);

  if (state.currentStatus === 'TIRED') {
    return computeTiredSchedule(now, lastCheckIn, baseline);
  }
  if (state.currentStatus === 'EMERGENCY') {
    return computeEmergencySchedule(now, lastCheckIn, lastAsk, baseline);
  }
  return computeNormalSchedule(now, lastCheckIn, baseline);
};

const computeSignals = (now, state, baseline) => {
  const lastAskAt = toDate(state.emergencyLastAskAt);
  const lastOpenedAt = toDate(state.lastAppOpenedAt);
  const silenceMinutes = lastAskAt ? minutesBetween(now, lastAskAt) : 0;

  const mu = Number(baseline.mu_silence_minutes ?? DEFAULT_BASELINE.mu_silence_minutes);
  const sigma = Math.max(Number(baseline.sigma_silence_minutes ?? DEFAULT_BASELINE.sigma_silence_minutes), SIGMA_FLOOR);
  const z = sigma > 0 ? (silenceMinutes - mu) / sigma : 0;

  let R = clamp((z + 3) / 6, 0, 1);
  const cooldownActive = Boolean(lastOpenedAt && now.getTime() - lastOpenedAt.getTime() <= COOLDOWN_MS);
  if (cooldownActive) {
    R = 0;
  }

  const delay = Math.max(1, Number(baseline.escalation_delay_minutes ?? DEFAULT_BASELINE.escalation_delay_minutes));
  const S = clamp(silenceMinutes / delay, 0, 1);
  const H = mapSelfReportToH(state.currentStatus);
  const E = state.emergencyArmed ? 1 : 0;
  const A = cooldownActive ? 1 : 0;

  const aps = logistic(
    APS_WEIGHTS.b +
      APS_WEIGHTS.wA * A +
      APS_WEIGHTS.wH * H +
      APS_WEIGHTS.wE * E +
      APS_WEIGHTS.wS * S +
      APS_WEIGHTS.wR * R
  );

  const tier = computeTier(aps);
  const reasons = [
    `R.z=${z.toFixed(2)}`,
    `R=${R.toFixed(2)}`,
    `cooldown=${cooldownActive ? 1 : 0}`,
    `S=${S.toFixed(2)}`,
    `E=${E.toFixed(2)}`,
    `H=${H.toFixed(2)}`,
    `A=${A.toFixed(0)}`
  ];

  return { aps, tier, reasons, silenceMinutes };
};

async function updateBaselineFromEvents(client, userId) {
  const result = await client.query(
    `SELECT AVG(silence_minutes) AS mu, STDDEV_POP(silence_minutes) AS sigma, COUNT(*) AS count
     FROM care_pulse_events
     WHERE user_id = $1
       AND silence_minutes IS NOT NULL
       AND client_ts >= NOW() - INTERVAL '14 days'`,
    [userId]
  );

  const row = result.rows[0];
  const count = Number(row?.count || 0);
  if (!Number.isFinite(count) || count < 3) {
    return;
  }

  const mu = Number(row.mu || DEFAULT_BASELINE.mu_silence_minutes);
  const sigmaRaw = Number(row.sigma || DEFAULT_BASELINE.sigma_silence_minutes);
  const sigma = Math.max(sigmaRaw || 0, SIGMA_FLOOR);

  await client.query(
    `UPDATE user_baselines
     SET mu_silence_minutes = $2,
         sigma_silence_minutes = $3,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, mu, sigma]
  );
}

async function maybeCreateEscalation(client, userId, state, baseline, reasons, now) {
  if (
    state.tier !== 3 ||
    !state.emergencyArmed ||
    state.silenceCount < Number(baseline.escalation_silence_count ?? DEFAULT_BASELINE.escalation_silence_count) ||
    !state.emergencyLastAskAt
  ) {
    return { escalationCreated: false };
  }

  const lastAskAt = toDate(state.emergencyLastAskAt);
  const delayMinutes = Number(baseline.escalation_delay_minutes ?? DEFAULT_BASELINE.escalation_delay_minutes);
  if (!lastAskAt || minutesBetween(now, lastAskAt) < delayMinutes) {
    return { escalationCreated: false };
  }

  const episodeId = state.episodeId || randomUUID();
  if (!state.episodeId) {
    state.episodeId = episodeId;
  }
  const existing = await client.query(
    'SELECT id FROM care_pulse_escalations WHERE episode_id = $1',
    [episodeId]
  );
  if (existing.rows.length > 0) {
    return { escalationCreated: false, escalationId: existing.rows[0].id };
  }

  const connection = await client.query(
    `SELECT id
     FROM user_connections
     WHERE status = 'accepted'
       AND (requester_id = $1 OR addressee_id = $1)
       AND COALESCE((permissions->>'can_receive_alerts')::boolean, false) = true
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );

  const connectionId = connection.rows[0]?.id || null;
  const status = connectionId ? 'sent' : 'pending';
  const sentAt = connectionId ? now : null;

  const inserted = await client.query(
    `INSERT INTO care_pulse_escalations (
      user_id,
      episode_id,
      sent_to_connection_id,
      status,
      reasons,
      created_at,
      sent_at
    ) VALUES ($1,$2,$3,$4,$5,NOW(),$6)
    RETURNING id`,
    [userId, episodeId, connectionId, status, JSON.stringify(reasons), sentAt]
  );

  return { escalationCreated: true, escalationId: inserted.rows[0]?.id };
}

async function evaluateAndApplyEvent(pool, { userId, event, now }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingEvent = await client.query(
      'SELECT id FROM care_pulse_events WHERE event_id = $1',
      [event.event_id]
    );
    if (existingEvent.rows.length > 0) {
      const stateRow = await getEngineState(client, userId, false);
      await client.query('COMMIT');
      const state = mapRowToState(stateRow);
      return { state, aps: state.aps, tier: state.tier, reasons: state.reasons, actions: { idempotent: true } };
    }

    const baseline = await ensureBaseline(client, userId);
    const stateRow = await getEngineState(client, userId, true);
    let state = mapRowToState(stateRow);

    const eventTime = parseEventTime(event.client_ts, now);
    const lastEventTs = toDate(stateRow.last_event_ts);
    const outOfOrder = Boolean(lastEventTs && eventTime < lastEventTs);

    const silenceMinutes =
      event.event_type === 'CHECK_IN' && state.emergencyLastAskAt
        ? minutesBetween(eventTime, toDate(state.emergencyLastAskAt))
        : null;

    await client.query(
      `INSERT INTO care_pulse_events (
        event_id,
        user_id,
        event_type,
        client_ts,
        client_tz,
        ui_session_id,
        source,
        self_report,
        silence_minutes,
        payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        event.event_id,
        userId,
        event.event_type,
        eventTime,
        event.client_tz,
        event.ui_session_id,
        event.source,
        event.self_report || null,
        silenceMinutes,
        JSON.stringify(event.payload || {})
      ]
    );

    if (outOfOrder) {
      await client.query('COMMIT');
      return { state, aps: state.aps, tier: state.tier, reasons: [...state.reasons, 'order=late'], actions: { outOfOrder: true } };
    }

    state = applyEventToState(state, event, eventTime);

    const schedule = computeSchedule(now, state, baseline);
    state.nextAskAt = schedule.nextAskAt;
    state.cooldownUntil = schedule.cooldownUntil;

    const signals = computeSignals(now, state, baseline);
    state.aps = signals.aps;
    state.tier = signals.tier;
    state.reasons = signals.reasons;

    const escalation = await maybeCreateEscalation(client, userId, state, baseline, signals.reasons, now);

    if (event.event_type === 'CHECK_IN') {
      await updateBaselineFromEvents(client, userId);
      await updateMissionProgress(client, userId, 'DAILY_CHECKIN', 1, { goal: 1, now: eventTime });
    }

    const updated = await client.query(
      `INSERT INTO care_pulse_engine_state (
        user_id,
        current_status,
        last_check_in_at,
        next_ask_at,
        cooldown_until,
        silence_count,
        emergency_armed,
        last_ask_at,
        last_app_opened_at,
        episode_id,
        aps,
        tier,
        reasons,
        last_event_ts,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        current_status = EXCLUDED.current_status,
        last_check_in_at = EXCLUDED.last_check_in_at,
        next_ask_at = EXCLUDED.next_ask_at,
        cooldown_until = EXCLUDED.cooldown_until,
        silence_count = EXCLUDED.silence_count,
        emergency_armed = EXCLUDED.emergency_armed,
        last_ask_at = EXCLUDED.last_ask_at,
        last_app_opened_at = EXCLUDED.last_app_opened_at,
        episode_id = EXCLUDED.episode_id,
        aps = EXCLUDED.aps,
        tier = EXCLUDED.tier,
        reasons = EXCLUDED.reasons,
        last_event_ts = EXCLUDED.last_event_ts,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        state.currentStatus,
        state.lastCheckInAt ? new Date(state.lastCheckInAt) : null,
        state.nextAskAt ? new Date(state.nextAskAt) : null,
        state.cooldownUntil ? new Date(state.cooldownUntil) : null,
        state.silenceCount,
        state.emergencyArmed,
        state.emergencyLastAskAt ? new Date(state.emergencyLastAskAt) : null,
        state.lastAppOpenedAt ? new Date(state.lastAppOpenedAt) : null,
        state.episodeId,
        state.aps,
        state.tier,
        JSON.stringify(state.reasons || []),
        eventTime
      ]
    );

    await client.query('COMMIT');
    const finalState = mapRowToState(updated.rows[0]);
    return {
      state: finalState,
      aps: finalState.aps,
      tier: finalState.tier,
      reasons: finalState.reasons,
      actions: escalation
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getState(pool, userId) {
  const client = await pool.connect();
  try {
    const row = await getEngineState(client, userId, false);
    return mapRowToState(row);
  } finally {
    client.release();
  }
}

/**
 * Acknowledge an escalation
 * @param {Object} pool - Database pool
 * @param {number} escalationId - Escalation ID
 * @param {number} userId - User acknowledging
 * @returns {Promise<Object>} - { ok, status, error }
 */
async function acknowledgeEscalation(pool, escalationId, userId) {
  try {
    // Get escalation
    const escalationResult = await pool.query(
      'SELECT id, user_id, status FROM care_pulse_escalations WHERE id = $1',
      [escalationId]
    );

    if (escalationResult.rows.length === 0) {
      return { ok: false, error: t('carePulse.alert_not_found'), statusCode: 404 };
    }

    const escalation = escalationResult.rows[0];

    // Check permission
    const permission = await pool.query(
      `SELECT id
       FROM user_connections
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND COALESCE((permissions->>'can_ack_escalation')::boolean, false) = true`,
      [escalation.user_id, userId]
    );

    if (permission.rows.length === 0) {
      return { ok: false, error: t('carePulse.no_access'), statusCode: 403 };
    }

    // Already acknowledged
    if (escalation.status === 'acknowledged') {
      return { ok: true, status: escalation.status };
    }

    // Update status
    await pool.query(
      `UPDATE care_pulse_escalations
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $1`,
      [escalationId, userId]
    );

    return { ok: true, status: 'acknowledged' };
  } catch (err) {
    console.error('[carePulse.aps.service] acknowledgeEscalation failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

module.exports = {
  evaluateAndApplyEvent,
  getState,
  ensureBaseline,
  acknowledgeEscalation
};




