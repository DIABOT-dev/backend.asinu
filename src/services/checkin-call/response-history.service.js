'use strict';

const { getSymptomOptionsForLocation } = require('../checkin/body-location');
const logger = require('../../lib/logger');

// Runs inside the episode transaction: an accepted response and its health
// history must succeed together. Demo calls never create real health records.
async function recordCallResponse(db, episode, severity, selection) {
  if (episode.config?.test_mode === true) return;
  const status = severity === 'NONE' ? 'fine' : severity === 'URGENT' ? 'very_tired' : 'tired';
  const result = await db.query(
    `INSERT INTO health_checkins
       (user_id, session_date, initial_status, current_status, flow_state,
        triage_severity, emergency_triggered, resolved_at, last_response_at, occurrence_source)
     VALUES ($1,$2,$3,$3,$4,$5,$6,CASE WHEN $3 = 'fine' THEN now() ELSE NULL END,now(),'checkin_call')
     ON CONFLICT (user_id, session_date) DO UPDATE SET
       current_status = CASE WHEN health_checkins.flow_state = 'high_alert' OR health_checkins.emergency_triggered
         THEN health_checkins.current_status ELSE EXCLUDED.current_status END,
       flow_state = CASE WHEN health_checkins.flow_state = 'high_alert' OR health_checkins.emergency_triggered
         THEN health_checkins.flow_state ELSE EXCLUDED.flow_state END,
       triage_severity = CASE WHEN health_checkins.triage_severity IN ('high','emergency') THEN health_checkins.triage_severity ELSE EXCLUDED.triage_severity END,
       emergency_triggered = health_checkins.emergency_triggered OR EXCLUDED.emergency_triggered,
       resolved_at = CASE WHEN health_checkins.flow_state = 'high_alert' OR health_checkins.emergency_triggered
         THEN health_checkins.resolved_at ELSE EXCLUDED.resolved_at END,
       last_response_at = now(), updated_at = now()
     RETURNING id`,
    [
      episode.user_id,
      episode.local_date,
      status,
      severity === 'URGENT' ? 'high_alert' : severity === 'NONE' ? 'resolved' : 'monitoring',
      severity === 'URGENT' ? 'high' : severity === 'NONE' ? 'low' : 'medium',
      severity === 'URGENT',
    ]
  );
  if (!selection) return;
  const symptom = getSymptomOptionsForLocation(selection.body_location, 'vi').find(
    (option) => option.key === selection.symptom
  );
  if (!symptom) return;
  await db.query(
    `INSERT INTO symptom_logs (user_id, checkin_id, symptom_name, severity, occurred_date)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,symptom_name,occurred_date) DO UPDATE SET
       severity = CASE WHEN symptom_logs.severity = 'high' THEN 'high' ELSE EXCLUDED.severity END`,
    [
      episode.user_id,
      result.rows[0]?.id || null,
      symptom.label,
      severity === 'URGENT' ? 'high' : 'medium',
      episode.local_date,
    ]
  );
  await db.query(
    `INSERT INTO symptom_frequency (user_id,symptom_name,count_7d,count_30d,last_occurred,updated_at)
     SELECT user_id,symptom_name,count(*) FILTER (WHERE occurred_date >= CURRENT_DATE - 6),count(*),max(occurred_date),now()
     FROM symptom_logs WHERE user_id = $1 AND symptom_name = $2 AND occurred_date BETWEEN CURRENT_DATE - 29 AND CURRENT_DATE
     GROUP BY user_id,symptom_name ON CONFLICT (user_id,symptom_name) DO UPDATE SET
       count_7d = EXCLUDED.count_7d,count_30d = EXCLUDED.count_30d,last_occurred = EXCLUDED.last_occurred,updated_at = now()`,
    [episode.user_id, symptom.label]
  );
}

async function refreshEarlySignals(pool, episode) {
  if (!episode || episode.config?.test_mode === true || typeof pool.query !== 'function') return;
  try {
    // Lazy import avoids the early-signal -> call-service dependency cycle.
    await require('../early-signal/early-signal.service').evaluateAfterNewHealthData(
      pool,
      episode.user_id,
      `checkin-call:${episode.id}`
    );
  } catch (error) {
    // The check-in is already committed. An assessment failure must not make
    // the client retry a successfully recorded response.
    logger.warn('checkin_call.early_signal_refresh_failed', {
      episodeId: episode.id,
      code: error.code,
    });
  }
}

module.exports = { recordCallResponse, refreshEarlySignals };
