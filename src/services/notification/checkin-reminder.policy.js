'use strict';

const { isRoutineMonitoringCheckin } = require('../checkin/checkin-inactivity.policy');

function completedPhase(session) {
  const state = session.triage_state || {};
  // A new follow-up keeps the previous conclusion timestamp while the new
  // interview is in progress. Completion must belong to the current phase.
  if (state.phase === 'followup' || state.completed) {
    return state.completed?.finalized === true || state.completed?.committed === true;
  }
  return Boolean(session.triage_completed_at);
}

function followUpCopyKeys(session, missCount) {
  if (isRoutineMonitoringCheckin(session)) {
    return { title: 'checkin.followup_title', body: 'checkin.followup_monitoring' };
  }
  if (completedPhase(session)) {
    return {
      title: 'checkin.followup_after_result_title',
      body:
        session.flow_state === 'high_alert'
          ? 'checkin.followup_after_result_high'
          : 'checkin.followup_after_result',
    };
  }
  return {
    title: missCount === 1 ? 'checkin.followup_title' : 'checkin.no_response_title',
    body:
      missCount > 1
        ? 'checkin.no_response_body'
        : session.flow_state === 'high_alert'
          ? 'checkin.followup_high_alert'
          : 'checkin.followup_normal',
  };
}

const timestamp = (value) => {
  if (value === undefined || value === null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

function followUpSnapshot(session) {
  return {
    checkinId: String(session.id),
    checkinPhaseId: session.triage_state?.phase_id || null,
    checkinRevision: session.triage_state?.revision || null,
    checkinResponseAt: session.last_response_at || null,
    checkinCompletedAt: session.triage_completed_at || null,
    checkinOccurrenceAt: session.occurrence_started_at || null,
  };
}

async function isStaleCheckinReminder(db, notification) {
  const { type, data = {}, user_id: userId, created_at: createdAt } = notification;
  if (['morning_checkin', 'reengagement'].includes(type)) {
    const { rows } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM health_checkins WHERE user_id=$1
        AND session_date >= (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS checked_in_today`,
      [userId]
    );
    return rows[0]?.checked_in_today === true;
  }
  if (!['checkin_followup', 'checkin_followup_urgent'].includes(type)) return false;
  // Legacy unlinked notices cannot be compared to a particular interview.
  if (!/^\d+$/.test(String(data.checkinId || ''))) return false;
  const { rows } = await db.query(
    `SELECT flow_state,resolved_at,last_response_at,triage_completed_at,triage_state,
       occurrence_started_at,
       session_date < (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS past_session
     FROM health_checkins WHERE id=$1 AND user_id=$2`,
    [data.checkinId, userId]
  );
  const session = rows[0];
  if (!session || session.resolved_at || session.flow_state === 'resolved' || session.past_session)
    return true;
  if (data.checkinPhaseId && data.checkinPhaseId !== session.triage_state?.phase_id) return true;
  if (data.checkinRevision && data.checkinRevision !== session.triage_state?.revision) return true;
  if (
    data.checkinOccurrenceAt &&
    timestamp(data.checkinOccurrenceAt) !== timestamp(session.occurrence_started_at)
  )
    return true;
  const responseBaseline = timestamp(data.checkinResponseAt) ?? timestamp(createdAt);
  if (responseBaseline !== null && timestamp(session.last_response_at) > responseBaseline)
    return true;
  const hasCompletionSnapshot = Object.prototype.hasOwnProperty.call(data, 'checkinCompletedAt');
  // Old queued copy called every completed check-in "unfinished". It has no
  // phase snapshot to validate, so retire it instead of replaying that claim.
  if (!hasCompletionSnapshot && createdAt && completedPhase(session)) return true;
  if (
    hasCompletionSnapshot &&
    timestamp(data.checkinCompletedAt) !== timestamp(session.triage_completed_at)
  )
    return true;
  return (
    timestamp(createdAt) !== null && timestamp(session.triage_completed_at) > timestamp(createdAt)
  );
}

module.exports = { completedPhase, followUpCopyKeys, followUpSnapshot, isStaleCheckinReminder };
