'use strict';

const {
  encryptHealthField,
  decryptHealthField,
} = require('../../security/health-field-encryption');
const { cacheDel } = require('../../lib/redis');
const { rebuildPatientHealthTimeline } = require('../health/health-timeline.service');

const checkpointField = 'health_checkins.cancel_checkpoint';
const restoreFields = [
  'initial_status',
  'current_status',
  'flow_state',
  'next_checkin_at',
  'last_response_at',
  'no_response_count',
  'body_location',
  'body_locations',
  'body_location_other',
  'triage_messages',
  'triage_state',
  'triage_summary',
  'triage_severity',
  'triage_completed_at',
  'family_alerted',
  'family_alerted_at',
  'emergency_triggered',
  'emergency_location',
  'occurrence_source',
  'occurrence_started_at',
  'resolved_at',
  'updated_at',
];
function phaseIdOf(session) {
  const state = session.triage_state || {};
  const started = session.occurrence_started_at || session.created_at;
  return (
    state.phase_id ||
    (state.phase === 'followup'
      ? state.revision
      : `initial:${started ? new Date(started).toISOString() : session.id}`)
  );
}
function unfinished(session) {
  if (session.resolved_at || session.flow_state === 'resolved') return false;
  const state = session.triage_state || {};
  if (state.completed)
    return state.completed.finalized === false && state.completed.committed !== true;
  return state.phase === 'followup'
    ? session.current_status !== 'fine'
    : session.initial_status !== 'fine' && !session.triage_completed_at;
}
function createCancelCheckpoint(session) {
  if (!session) return null;
  const snapshot = { id: String(session.id), user_id: String(session.user_id) };
  for (const field of restoreFields)
    if (Object.hasOwn(session, field)) snapshot[field] = session[field];
  if (!unfinished(session) && snapshot.triage_state) {
    snapshot.triage_state = { ...snapshot.triage_state };
    delete snapshot.triage_state.cancel_checkpoint;
  }
  return encryptHealthField(session.user_id, checkpointField, JSON.stringify(snapshot));
}
function publicCheckinSession(session) {
  if (!session) return session;
  const result = { ...session, triage_state: { ...session.triage_state } };
  delete result.triage_state.adaptive_payload;
  delete result.triage_state.cancel_checkpoint;
  return result;
}
const fail = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });

async function cancelCheckin(pool, userId, checkinId, phaseId) {
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('checkin-cancel'), hashtext($1))", [
      `${userId}:${checkinId}`,
    ]);
    const receipt = await client.query(
      `SELECT phase_id FROM health_checkin_cancellations
      WHERE user_id=$1 AND checkin_id=$2 AND phase_id=$3`,
      [userId, checkinId, phaseId]
    );
    if (receipt.rows.length) {
      await client.query('COMMIT');
      return { cancelled: true, alreadyCancelled: true };
    }
    const { rows } = await client.query(
      'SELECT * FROM health_checkins WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [checkinId, userId]
    );
    const session = rows[0];
    if (!session) throw fail('SESSION_NOT_FOUND', 404);
    if (phaseIdOf(session) !== phaseId) throw fail('TRIAGE_CHANGED', 409);
    if (!unfinished(session)) throw fail('CHECKIN_ALREADY_COMPLETED', 409);

    let snapshot;
    if (session.triage_state?.cancel_checkpoint) {
      snapshot = JSON.parse(
        decryptHealthField(userId, checkpointField, session.triage_state.cancel_checkpoint)
      );
      if (String(snapshot.id) !== String(checkinId) || String(snapshot.user_id) !== String(userId))
        throw fail('TRIAGE_CHANGED', 409);
    } else {
      // Older interviews have immutable occurrence history instead of a full
      // checkpoint. Restore its known medical fields; never delete that history.
      const previous = await client.query(
        `SELECT * FROM health_checkin_occurrences
        WHERE checkin_id=$1 AND user_id=$2 ORDER BY snapshot_updated_at DESC LIMIT 1`,
        [checkinId, userId]
      );
      if (previous.rows[0]) {
        const old = previous.rows[0];
        snapshot = {
          ...old,
          occurrence_source: old.source,
          occurrence_started_at: old.started_at,
          triage_completed_at: old.completed_at,
          updated_at: old.snapshot_updated_at,
          triage_state: {},
          resolved_at: old.flow_state === 'resolved' ? old.completed_at : null,
        };
      } else if (session.triage_state?.phase === 'followup') {
        // The pre-follow-up summary is retained by the existing follow-up flow.
        snapshot = {
          triage_messages: session.triage_state.baseline_answers || [],
          triage_state: {},
        };
      }
    }
    if (snapshot) {
      const fields = restoreFields.filter((field) => Object.hasOwn(snapshot, field));
      const values = fields.map((field) =>
        snapshot[field] != null &&
        ['triage_state', 'triage_messages', 'emergency_location'].includes(field)
          ? JSON.stringify(snapshot[field])
          : snapshot[field]
      );
      await client.query(
        `UPDATE health_checkins SET ${fields.map((field, index) => `${field}=$${index + 1}${['triage_state', 'triage_messages', 'emergency_location'].includes(field) ? '::jsonb' : ''}`).join(', ')}
        WHERE id=$${values.length + 1} AND user_id=$${values.length + 2}`,
        [...values, checkinId, userId]
      );
    } else {
      await client.query('DELETE FROM health_checkins WHERE id=$1 AND user_id=$2', [
        checkinId,
        userId,
      ]);
    }
    await client.query(
      `INSERT INTO health_checkin_cancellations(user_id,checkin_id,phase_id)
      VALUES($1,$2,$3)`,
      [userId, checkinId, phaseId]
    );
    await rebuildPatientHealthTimeline(client, userId);
    await client.query('COMMIT');
    result = { cancelled: true, restoredPrevious: Boolean(snapshot) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await cacheDel(`health:score:${userId}`).catch(() => {});
  return result;
}

module.exports = {
  cancelCheckin,
  createCancelCheckpoint,
  publicCheckinSession,
  phaseIdOf,
  unfinished,
};
