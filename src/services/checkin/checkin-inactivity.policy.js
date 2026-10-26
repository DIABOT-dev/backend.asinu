'use strict';

const INACTIVITY_NOTICE_TYPE = 'checkin_inactivity_notice';
const PAUSE_AFTER_DAYS = 7;
const CHECKIN_REMINDERS = new Set([
  'morning_checkin',
  'evening_checkin',
  'reengagement',
  'engagement',
]);

// Only internal SQL expressions are passed here, never request input. Calendar
// days are measured on the server in VN time, independent of device time and
// the nightly lifecycle cache. Newly connected/never-checked-in people get a
// full week from their first currently accepted connection.
function inactivityStateSql(userExpression, referenceExpression = 'NOW()') {
  return `SELECT to_char(anchor.inactive_since, 'YYYY-MM-DD') AS inactive_since_date,
    GREATEST(0, ((${referenceExpression}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - anchor.inactive_since) AS inactive_days,
    COALESCE(((${referenceExpression}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - anchor.inactive_since >= ${PAUSE_AFTER_DAYS}, false) AS paused
    FROM (
      SELECT CASE WHEN circle.connected_since IS NOT NULL THEN GREATEST(
        circle.connected_since,
        (SELECT MAX(hc.session_date) FROM health_checkins hc WHERE hc.user_id = ${userExpression})
      ) END AS inactive_since
      FROM (
        SELECT MIN(COALESCE(uc.accepted_at, uc.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS connected_since
        FROM user_connections uc
        JOIN users relative ON relative.id = CASE WHEN uc.requester_id = ${userExpression} THEN uc.addressee_id ELSE uc.requester_id END
        WHERE (uc.requester_id = ${userExpression} OR uc.addressee_id = ${userExpression})
          AND uc.status = 'accepted' AND relative.deleted_at IS NULL
      ) circle
    ) anchor`;
}

async function getCheckinInactivity(db, userId) {
  const { rows } = await db.query(inactivityStateSql('$1::int'), [userId]);
  return rows[0];
}

function routineCall(episode) {
  return (
    episode.trigger_source === 'MISSED_CHECKIN' &&
    ['NONE', 'UNKNOWN'].includes(episode.severity) &&
    episode.config?.early_signal !== true
  );
}

async function suppressInactivityNotification(db, userId, type, data = {}) {
  if (type === INACTIVITY_NOTICE_TYPE) {
    if (!data.patient_id || !data.inactive_since_date) return true;
    const state = await getCheckinInactivity(db, data.patient_id);
    return !state.paused || state.inactive_since_date !== data.inactive_since_date;
  }
  const subjectId =
    type === 'caregiver_alert' && data.reengage_patient_id
      ? data.reengage_patient_id
      : CHECKIN_REMINDERS.has(type)
        ? userId
        : null;
  if (!subjectId) return false;
  return (await getCheckinInactivity(db, subjectId)).paused;
}

module.exports = {
  INACTIVITY_NOTICE_TYPE,
  PAUSE_AFTER_DAYS,
  inactivityStateSql,
  getCheckinInactivity,
  routineCall,
  suppressInactivityNotification,
};
