'use strict';
const c = require('./common'),
  p = require('./medication.policy'),
  calls = require('./medication-calls.service');
async function consents(pool) {
  const jobs = (
    await pool.query(`SELECT cc.*,s.time_local,s.created_by,COALESCE(ub.timezone,'Asia/Ho_Chi_Minh') timezone,u.fcm_token,u.voip_push_token,u.push_token
  FROM med_consent_calls cc JOIN med_schedules s ON s.id=cc.schedule_id AND s.active AND s.consent_state='PENDING'
  JOIN users u ON u.id=cc.patient_user_id AND u.deleted_at IS NULL LEFT JOIN user_baselines ub ON ub.user_id=u.id
  JOIN user_notification_preferences n ON n.user_id=u.id AND n.reminders_enabled
  WHERE cc.state='QUEUED' AND cc.next_at<=NOW() AND v21_allowed(u.id,'medication') ORDER BY cc.next_at LIMIT 20`)
  ).rows;
  for (const job of jobs) {
    if (!(await c.hasConnection(pool, job.patient_user_id, job.created_by))) {
      await pool.query("UPDATE med_consent_calls SET state='ENDED' WHERE id=$1", [job.id]);
      continue;
    }
    const when = p.nextWindow(new Date(), job.timezone),
      busy = await calls.busyUntil(pool, job.patient_user_id);
    if (when > Date.now() + 60000 || busy) {
      await pool.query('UPDATE med_consent_calls SET next_at=$2 WHERE id=$1', [
        job.id,
        busy || when,
      ]);
      continue;
    }
    const claimed = await c.transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [job.patient_user_id]);
      const active = await db.query(
        `SELECT 1 FROM med_consent_calls WHERE patient_user_id=$1 AND state IN('SENDING','DELIVERED') AND deadline>NOW()
       UNION ALL SELECT 1 FROM med_call_attempts a JOIN med_dose_events e ON e.id=a.dose_event_id WHERE e.patient_user_id=$1 AND a.state IN('SENDING','DELIVERED') AND a.deadline>NOW() LIMIT 1`,
        [job.patient_user_id]
      );
      if (active.rowCount) {
        await db.query(
          "UPDATE med_consent_calls SET next_at=NOW()+INTERVAL '1 minute' WHERE id=$1 AND state='QUEUED'",
          [job.id]
        );
        return null;
      }
      const row = (
        await db.query(
          "UPDATE med_consent_calls SET state='SENDING',deadline=NOW()+INTERVAL '60 seconds' WHERE id=$1 AND state='QUEUED' RETURNING *",
          [job.id]
        )
      ).rows[0];
      if (!row) return null;
      // One invitation opens a review of all currently pending times. Do not
      // ring four times when one setup creates four daily reminder hours.
      await db.query(
        "UPDATE med_consent_calls SET state='ENDED' WHERE patient_user_id=$1 AND id<>$2 AND state='QUEUED'",
        [job.patient_user_id, job.id]
      );
      return row;
    });
    if (!claimed) continue;
    // The separate consent invitation is already durable in the regular outbox.
    // A native call is an additional channel, sent at most once per invitation.
    if ((await c.config(pool, job.patient_user_id)).nativeCall) {
      const user = { ...job, id: job.patient_user_id };
      const sent = await calls.sendNative(pool, user, {
        type: 'medication_call',
        checkinCall: true,
        medCall: true,
        callType: 'medication',
        kind: 'INCOMING_CALL',
        episodeId: job.schedule_id,
        attemptId: job.id,
        callUUID: job.id,
        medConsentId: job.schedule_id,
        statusCapability: calls.statusToken(job.id, job.patient_user_id),
        declineCapability: calls.declineToken(
          job.id,
          job.patient_user_id,
          Math.floor(new Date(claimed.deadline).getTime() / 1000)
        ),
        ringDeadline: new Date(claimed.deadline).toISOString(),
        ringSeconds: 60,
        title: 'Asinu · Lịch nhắc thuốc',
        body: 'Người thân muốn cài lịch nhắc thuốc cho bạn.',
      });
      await pool.query('UPDATE med_consent_calls SET channel=$2,state=$3 WHERE id=$1', [
        job.id,
        sent ? 'native_call' : 'push',
        'DELIVERED',
      ]);
    } else
      await pool.query(
        "UPDATE med_consent_calls SET state='DELIVERED',channel='push' WHERE id=$1",
        [job.id]
      );
  }
  await pool.query(
    "UPDATE med_consent_calls SET state='ENDED' WHERE state IN('SENDING','DELIVERED') AND deadline<=NOW()"
  );
  const waiting = (
    await pool.query(`UPDATE med_schedules SET consent_reminded_at=NOW()
  WHERE consent_state='PENDING' AND active AND consent_reminded_at IS NULL AND updated_at<=NOW()-INTERVAL '48 hours'
   AND v21_allowed(patient_user_id,'medication') RETURNING *`)
  ).rows;
  for (const s of waiting)
    if (s.created_by && (await c.hasConnection(pool, s.patient_user_id, s.created_by)))
      await c.message(pool, {
        key: 'med.consent_pending:' + s.patient_user_id + ':' + s.created_by + ':' + c.localDate(),
        subject: s.patient_user_id,
        recipient: s.created_by,
        kind: 'med_consent_pending',
        payload: { scheduleId: s.id },
      });
}
async function endPausedCalls(pool) {
  await pool.query(`UPDATE med_call_attempts a SET state='ENDED',ended_at=NOW(),end_reason='disabled' FROM med_dose_events e
  WHERE a.dose_event_id=e.id AND a.state IN('QUEUED','SENDING','DELIVERED')
  AND(NOT v21_allowed(e.patient_user_id,'medication') OR NOT EXISTS(SELECT 1 FROM user_notification_preferences n WHERE n.user_id=e.patient_user_id AND n.reminders_enabled))`);
  await pool.query(`UPDATE med_dose_events e SET state='CANCELLED',updated_at=NOW() WHERE state='CALLING'
  AND(NOT v21_allowed(patient_user_id,'medication') OR NOT EXISTS(SELECT 1 FROM user_notification_preferences n WHERE n.user_id=e.patient_user_id AND n.reminders_enabled))`);
}
async function daily(pool) {
  const rows = (
    await pool.query(
      "SELECT DISTINCT patient_user_id,local_date FROM med_dose_events WHERE local_date>=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-2 AND has_medicine"
    )
  ).rows;
  for (const row of rows) await calls.aggregateDay(pool, row.patient_user_id, row.local_date);
  await require('./coins.service').daily(pool);
}
module.exports = { consents, endPausedCalls, daily };
