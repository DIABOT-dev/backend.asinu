'use strict';
const crypto = require('node:crypto');
const c = require('./common'),
  p = require('./medication.policy'),
  med = require('./medication.service');
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const answerSchema = c.z
  .object({ button: c.z.number().int().min(1).max(3), request_id: c.uuid })
  .strict();
const dayText = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
async function familyResult(db, event, revision = 'initial') {
  const family = (
    await db.query(
      `SELECT CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END id,
  COALESCE(f.problems_only,FALSE) problems_only FROM user_connections c LEFT JOIN med_family_preferences f
  ON f.patient_user_id=$1 AND f.caregiver_id=CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END
  WHERE c.status='accepted' AND (c.requester_id=$1 OR c.addressee_id=$1)
  AND COALESCE((c.permissions->>'can_receive_alerts')::boolean,FALSE)`,
      [event.patient_user_id]
    )
  ).rows;
  const repeats =
    event.state === 'OUT_OF_MEDS'
      ? (
          await db.query(
            "SELECT count(*)::int n FROM med_dose_events WHERE patient_user_id=$1 AND state='OUT_OF_MEDS' AND answered_at>NOW()-INTERVAL '7 days'",
            [event.patient_user_id]
          )
        ).rows[0].n
      : 0;
  for (const recipient of family) {
    if (recipient.problems_only && event.state === 'TAKEN') continue;
    const nodevice = event.state === 'SKIPPED_NO_DEVICE';
    await c.message(db, {
      key: nodevice
        ? `med.no_device:${event.patient_user_id}:${dayText(event.local_date)}:${recipient.id}`
        : `med.result:${event.id}:${revision}:${recipient.id}`,
      subject: event.patient_user_id,
      recipient: recipient.id,
      kind: 'med_result',
      payload: {
        doseId: event.id,
        state: event.state,
        slot: p.slotName(String(event.time_local || '07:00')),
        repeatCount: repeats,
      },
    });
  }
}
async function aggregateDay(db, user, date) {
  const totals = (
    await db.query(
      `SELECT count(*)::int total,count(*) FILTER(WHERE state='TAKEN')::int taken,
  bool_or(taken_after_retry) late,bool_or(state IN('SKIPPED','OUT_OF_MEDS','UNCONFIRMED','SKIPPED_NO_DEVICE')) skipped
 FROM med_dose_events WHERE patient_user_id=$1 AND local_date=$2 AND has_medicine AND state<>'CANCELLED'`,
      [user, date]
    )
  ).rows[0];
  if (!totals.total) return;
  const status = totals.skipped
    ? 'skipped'
    : totals.taken === totals.total
      ? totals.late
        ? 'late'
        : 'taken'
      : 'unknown';
  await db.query(
    `INSERT INTO medication_adherence(user_id,medication_date,status) VALUES($1,$2,$3)
 ON CONFLICT(user_id,medication_date) DO UPDATE SET status=$3`,
    [user, date, status]
  );
}
async function prepare(pool) {
  const schedules = (
    await pool.query(`SELECT s.*,COALESCE(tz.name,'Asia/Ho_Chi_Minh') timezone
 FROM med_schedules s JOIN users u ON u.id=s.patient_user_id AND u.deleted_at IS NULL
 LEFT JOIN user_baselines ub ON ub.user_id=u.id
 LEFT JOIN user_notification_preferences np ON np.user_id=u.id
 LEFT JOIN pg_timezone_names tz ON tz.name=COALESCE(ub.timezone,to_jsonb(u)->>'timezone','Asia/Ho_Chi_Minh')
 WHERE s.active AND s.consent_state='ACTIVE' AND v21_allowed(u.id,'medication') AND np.reminders_enabled=TRUE
 AND (NOT EXISTS(SELECT 1 FROM med_dose_events e WHERE e.schedule_id=s.id AND e.local_date=(NOW() AT TIME ZONE COALESCE(tz.name,'Asia/Ho_Chi_Minh'))::date)
 OR EXISTS(SELECT 1 FROM med_dose_events e WHERE e.schedule_id=s.id AND e.state='SCHEDULED' AND e.attempt_count=0 AND e.scheduled_at>NOW() AND e.timezone<>COALESCE(tz.name,'Asia/Ho_Chi_Minh')))`)
  ).rows;
  for (const s of schedules) {
    const timezone = p.resolveNotificationTimezone(s.timezone),
      date = c.localDate(new Date(), timezone),
      when = p.atLocal(date, String(s.time_local).slice(0, 5), timezone);
    if (!when) continue;
    await c.transaction(pool, async (db) => {
      if (!(await c.lockPatient(db, s.patient_user_id, { optional: true }))) return;
      // Serialize with schedule edits; never recreate an event from a stale scan.
      const current = (
        await db.query(
          "SELECT * FROM med_schedules WHERE id=$1 AND active AND consent_state='ACTIVE' FOR SHARE",
          [s.id]
        )
      ).rows[0];
      if (!current || String(current.time_local) !== String(s.time_local)) return;
      const untouched = (
        await db.query(
          "SELECT * FROM med_dose_events WHERE schedule_id=$1 AND state='SCHEDULED' AND attempt_count=0 AND scheduled_at>NOW() AND timezone<>$2 ORDER BY scheduled_at FOR UPDATE",
          [s.id, timezone]
        )
      ).rows;
      for (const old of untouched) {
        const collision = (
          await db.query(
            'SELECT 1 FROM med_dose_events WHERE schedule_id=$1 AND local_date=$2 AND id<>$3',
            [s.id, date, old.id]
          )
        ).rowCount;
        if (collision)
          await db.query(
            "UPDATE med_dose_events SET state='CANCELLED',updated_at=NOW() WHERE id=$1",
            [old.id]
          );
        else
          await db.query(
            'UPDATE med_dose_events SET local_date=$2,scheduled_at=$3,next_attempt_at=$3,timezone=$4,updated_at=NOW() WHERE id=$1',
            [old.id, date, when, timezone]
          );
      }
      const items = (
        await db.query(
          'SELECT i.* FROM med_schedule_items si JOIN med_items i ON i.id=si.item_id AND i.active WHERE si.schedule_id=$1',
          [s.id]
        )
      ).rows;
      if (!items.length) return;
      const e = (
        await db.query(
          `INSERT INTO med_dose_events(id,schedule_id,patient_user_id,local_date,scheduled_at,next_attempt_at,timezone,has_medicine)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
          [
            c.randomUUID(),
            s.id,
            s.patient_user_id,
            date,
            when,
            timezone,
            items.some((i) => i.kind === 'MEDICINE'),
          ]
        )
      ).rows[0];
      if (!e) return;
      for (const item of items)
        await db.query(
          'INSERT INTO med_dose_items(dose_event_id,item_id,display_name,kind,photo_media_id,patient_user_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            e.id,
            item.id,
            med.protect(
              e.patient_user_id,
              'med_dose_items.display_name',
              med.publicItem(item).display_name
            ),
            item.kind,
            item.photo_media_id,
            e.patient_user_id,
          ]
        );
    });
  }
}
async function busyUntil(db, user) {
  const row = (
    await db.query(
      `SELECT
  EXISTS(SELECT 1 FROM checkin_call_attempts WHERE target_user_id=$1 AND
   ((state='RINGING' AND ring_deadline>NOW()) OR(state='CONNECTED' AND confirm_deadline>NOW())))
  OR EXISTS(SELECT 1 FROM doctor_ivr_call_attempts a JOIN doctor_ivr_sessions s ON s.id=a.session_id WHERE s.user_id=$1
   AND a.status IN('dispatching','ringing','accepted') AND s.status IN('sent','in_progress') AND s.expires_at>NOW()) busy,
  GREATEST((SELECT max(ended_at) FROM checkin_call_attempts WHERE target_user_id=$1),
    (SELECT max(a.finished_at) FROM doctor_ivr_call_attempts a JOIN doctor_ivr_sessions s ON s.id=a.session_id WHERE s.user_id=$1)) last_end`,
      [user]
    )
  ).rows[0];
  if (row.busy) return new Date(Date.now() + 10 * 60000);
  if (row.last_end && new Date(row.last_end).getTime() + 10 * 60000 > Date.now())
    return new Date(new Date(row.last_end).getTime() + 10 * 60000);
  return null;
}
async function registerDevice(db, user, platform, token, supported) {
  if (
    !['ios', 'android'].includes(platform) ||
    typeof supported !== 'boolean' ||
    (supported && typeof token !== 'string')
  )
    throw c.error('MED_DEVICE_INVALID');
  await c.assertFeature(db, user, 'medication');
  const row = (await db.query('SELECT fcm_token,voip_push_token FROM users WHERE id=$1', [user]))
    .rows[0];
  if (supported && token !== (platform === 'ios' ? row.voip_push_token : row.fcm_token))
    throw c.error('MED_DEVICE_NOT_READY', 409);
  await db.query(
    `INSERT INTO med_devices(user_id,platform,token_hash,supported) VALUES($1,$2,$3,$4)
 ON CONFLICT(user_id,platform) DO UPDATE SET token_hash=$3,supported=$4,updated_at=NOW()`,
    [user, platform, supported ? tokenHash(token) : '', supported]
  );
  return { supported };
}
async function nativeTokens(db, user) {
  const devices = (
    await db.query('SELECT * FROM med_devices WHERE user_id=$1 AND supported', [user.id])
  ).rows;
  return {
    fcm:
      user.fcm_token &&
      devices.some((d) => d.platform === 'android' && d.token_hash === tokenHash(user.fcm_token))
        ? user.fcm_token
        : null,
    voip:
      user.voip_push_token &&
      devices.some((d) => d.platform === 'ios' && d.token_hash === tokenHash(user.voip_push_token))
        ? user.voip_push_token
        : null,
  };
}
async function queueDue(pool) {
  const due = (
    await pool.query(`SELECT e.id FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id
  JOIN user_notification_preferences n ON n.user_id=e.patient_user_id AND n.reminders_enabled
  WHERE e.state='SCHEDULED' AND e.next_attempt_at<=NOW() AND s.active AND s.consent_state='ACTIVE'
   AND v21_allowed(e.patient_user_id,'medication') ORDER BY e.next_attempt_at LIMIT 50`)
  ).rows;
  for (const { id } of due)
    await c.transaction(pool, async (db) => {
      const subject = (
        await db.query('SELECT patient_user_id FROM med_dose_events WHERE id=$1', [id])
      ).rows[0];
      if (!subject) return;
      const user = (
        await db.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE', [
          subject.patient_user_id,
        ])
      ).rows[0];
      if (!user) return;
      const e = (
        await db.query(
          "SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id WHERE e.id=$1 AND e.state='SCHEDULED' AND e.next_attempt_at<=NOW() AND s.active AND s.consent_state='ACTIVE' FOR UPDATE OF e",
          [id]
        )
      ).rows[0];
      if (!e) return;
      const busy = await busyUntil(db, user.id);
      if (busy) {
        await db.query('UPDATE med_dose_events SET next_attempt_at=$2 WHERE id=$1', [id, busy]);
        return;
      }
      if (Date.now() - new Date(e.scheduled_at) > 2 * 3600000) {
        e.state = 'UNCONFIRMED';
        await db.query(
          "UPDATE med_dose_events SET state='UNCONFIRMED',updated_at=NOW() WHERE id=$1",
          [id]
        );
        await familyResult(db, e);
        await aggregateDay(db, user.id, e.local_date);
        return;
      }
      const flags = await c.config(db, user.id),
        tokens =
          flags.nativeCall && p.inCallWindow(new Date(), e.timezone)
            ? await nativeTokens(db, user)
            : {};
      if (!(user.fcm_token || user.push_token || tokens.voip || tokens.fcm)) {
        e.state = 'SKIPPED_NO_DEVICE';
        await db.query(
          "UPDATE med_dose_events SET state='SKIPPED_NO_DEVICE',updated_at=NOW() WHERE id=$1",
          [id]
        );
        await familyResult(db, e);
        await aggregateDay(db, user.id, e.local_date);
        return;
      }
      // A merged group consumes one attempt in each constituent dose, sends once.
      const group = (
        await db.query(
          `SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id
   WHERE e.patient_user_id=$1 AND e.state='SCHEDULED' AND s.active AND s.consent_state='ACTIVE' AND
    (e.id=$2 OR(e.attempt_count=0 AND $3::integer=0 AND e.scheduled_at>=$4 AND e.scheduled_at<$4::timestamptz+INTERVAL '30 minutes')
 OR($3::integer>0 AND e.attempt_count=$3 AND e.next_attempt_at<=NOW()+INTERVAL '1 second' AND e.id IN(SELECT a.dose_event_id FROM med_call_attempts a WHERE a.group_id=(SELECT group_id FROM med_call_attempts WHERE dose_event_id=$2 ORDER BY attempt_no DESC LIMIT 1))))
   ORDER BY e.scheduled_at FOR UPDATE OF e`,
          [user.id, e.id, e.attempt_count, e.scheduled_at]
        )
      ).rows;
      const channel = tokens.fcm || tokens.voip ? 'native_call' : 'push',
        groupId = c.randomUUID();
      for (const item of group) {
        if (item.attempt_count >= 2) continue;
        await db.query(
          `INSERT INTO med_call_attempts(id,group_id,dose_event_id,attempt_no,channel,state,deadline)
    VALUES($1,$2,$3,$4,$5,'QUEUED',NOW()+INTERVAL '60 seconds') ON CONFLICT DO NOTHING`,
          [c.randomUUID(), groupId, item.id, item.attempt_count + 1, channel]
        );
        await db.query(
          "UPDATE med_dose_events SET state='CALLING',attempt_count=attempt_count+1,updated_at=NOW() WHERE id=$1",
          [item.id]
        );
      }
    });
}
function declineToken(id, user, expires) {
  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`med-decline:${id}:${user}:${expires}`)
    .digest('hex');
  return `${expires}.${signature}`;
}
function statusToken(id, user) {
  const expires = Math.floor(Date.now() / 1000) + 180;
  return (
    `${expires}.` +
    crypto
      .createHmac('sha256', process.env.JWT_SECRET)
      .update(`med-status:${id}:${user}:${expires}`)
      .digest('hex')
  );
}
async function nativeStatus(db, id, token) {
  c.uuid.parse(id);
  const row = (
    await db.query(
      `SELECT e.patient_user_id,(s.active AND e.state<>'CANCELLED' AND a.state IN('SENDING','DELIVERED','ANSWERED') AND a.deadline>NOW()) active
 FROM med_call_attempts a JOIN med_dose_events e ON e.id=a.dose_event_id JOIN med_schedules s ON s.id=e.schedule_id WHERE a.id=$1
 UNION ALL SELECT cc.patient_user_id,(s.active AND s.consent_state='PENDING' AND cc.state IN('SENDING','DELIVERED') AND cc.deadline>NOW()) active FROM med_consent_calls cc JOIN med_schedules s ON s.id=cc.schedule_id WHERE cc.id=$1`,
      [id]
    )
  ).rows[0];
  const match = typeof token === 'string' && token.match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (
    !row ||
    !match ||
    Number(match[1]) * 1000 < Date.now() ||
    Number(match[1]) * 1000 > Date.now() + 181000
  )
    throw c.error('MED_CALL_TOKEN_INVALID', 401);
  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`med-status:${id}:${row.patient_user_id}:${match[1]}`)
    .digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(match[2], 'hex')))
    throw c.error('MED_CALL_TOKEN_INVALID', 401);
  const enabled = (
    await db.query('SELECT reminders_enabled FROM user_notification_preferences WHERE user_id=$1', [
      row.patient_user_id,
    ])
  ).rows[0]?.reminders_enabled;
  return {
    active: !!row.active && !!enabled && (await c.config(db, row.patient_user_id)).medication,
  };
}
async function sendNative(db, user, payload) {
  const tokens = await nativeTokens(db, user);
  let sent = false;
  if (tokens.voip) {
    const result = await require('../notification/apns.voip.service').sendVoipNotification(
      tokens.voip,
      payload
    );
    sent = !!result.ok || sent;
  }
  if (tokens.fcm) {
    const result = await require('../notification/fcm.notification.service').sendFcmNotification(
      tokens.fcm,
      'Asinu',
      'Nhắc uống thuốc',
      payload,
      { incomingCall: true }
    );
    sent = !!result.ok || sent;
  }
  return sent;
}
async function dispatchAttempts(pool) {
  const ids = (
    await pool.query(`SELECT DISTINCT group_id FROM med_call_attempts WHERE state='QUEUED'
  OR(state='SENDING' AND lease_until<NOW()) LIMIT 30`)
  ).rows;
  for (const { group_id: groupId } of ids) {
    const rows = await c.transaction(pool, async (db) => {
      const attempts = (
        await db.query(
          `SELECT a.*,e.patient_user_id,e.timezone,e.scheduled_at,s.time_local FROM med_call_attempts a
    JOIN med_dose_events e ON e.id=a.dose_event_id JOIN med_schedules s ON s.id=e.schedule_id
    JOIN user_notification_preferences n ON n.user_id=e.patient_user_id AND n.reminders_enabled
    WHERE a.group_id=$1 AND e.state='CALLING' AND s.active AND v21_allowed(e.patient_user_id,'medication')
     AND(a.state='QUEUED' OR(a.state='SENDING' AND a.lease_until<NOW())) ORDER BY e.scheduled_at,a.id FOR UPDATE OF a SKIP LOCKED`,
          [groupId]
        )
      ).rows;
      if (!attempts.length) return [];
      await db.query(
        "UPDATE med_call_attempts SET state='SENDING',lease_until=NOW()+INTERVAL '30 seconds' WHERE id=ANY($1::uuid[])",
        [attempts.map((a) => a.id)]
      );
      return attempts;
    });
    if (!rows.length) continue;
    const root = rows[0],
      user = (
        await pool.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [
          root.patient_user_id,
        ])
      ).rows[0];
    if (!user) continue;
    const en = String(user.language_preference).startsWith('en');
    let sent = false;
    if (root.channel === 'native_call' && (await c.config(pool, user.id)).nativeCall) {
      const expires = Math.floor(new Date(root.deadline).getTime() / 1000);
      sent = await sendNative(pool, user, {
        type: 'medication_call',
        lang: en ? 'en' : 'vi',
        title: en ? 'Asinu · Medication reminder' : 'Asinu · Nhắc thuốc',
        checkinCall: true,
        medCall: true,
        callType: 'medication',
        episodeId: root.dose_event_id,
        kind: 'INCOMING_CALL',
        callUUID: groupId,
        attemptId: root.id,
        medDoseId: root.dose_event_id,
        ringDeadline: new Date(root.deadline).toISOString(),
        ringSeconds: 60,
        targetRole: 'USER',
        callerName: 'Asinu · Nhắc thuốc',
        expiresAt: new Date(root.deadline).toISOString(),
        declineCapability: declineToken(root.id, user.id, expires),
        nativeDeclineToken: declineToken(root.id, user.id, expires),
        statusCapability: statusToken(root.id, user.id),
        nativeDeclinePath: `/api/mobile/med-native/${root.id}/decline`,
      });
    }
    if (!sent) {
      const {
        reserveNotification,
        deliverNotification,
      } = require('../notification/notification-dispatch.service');
      const saved = await reserveNotification(pool, {
        userId: user.id,
        type: 'med_reminder',
        title: en ? 'Medication reminder' : 'Đến giờ uống thuốc',
        body: en
          ? 'It is time for your scheduled medicine or supplement. Open Asinu to respond.'
          : `Đến giờ uống thuốc buổi ${p.slotName(String(root.time_local))}. Mở Asinu để trả lời.`,
        data: {
          eventId: 'med.reminder:' + groupId,
          medDoseId: root.dose_event_id,
          screen: '/medication/call?dose=' + root.dose_event_id,
          categoryId: 'MEDICATION_DOSE',
          lang: en ? 'en' : 'vi',
        },
        cooldownMinutes: 1440,
      });
      if (saved) {
        await pool.query('UPDATE med_call_attempts SET notification_id=$2 WHERE group_id=$1', [
          groupId,
          saved.notificationId,
        ]);
        await deliverNotification(pool, saved.notificationId);
      }
      await pool.query("UPDATE med_call_attempts SET channel='push' WHERE group_id=$1", [groupId]);
    }
    await pool.query(
      "UPDATE med_call_attempts SET state='DELIVERED',lease_until=NULL WHERE group_id=$1 AND state='SENDING'",
      [groupId]
    );
  }
}
async function closeTimeouts(pool) {
  const ids = (
    await pool.query(
      "SELECT id FROM med_call_attempts WHERE state IN('QUEUED','SENDING','DELIVERED') AND deadline<=NOW() LIMIT 100"
    )
  ).rows;
  for (const { id } of ids)
    await c.transaction(pool, async (db) => {
      const subject = (
        await db.query(
          'SELECT e.patient_user_id FROM med_call_attempts a JOIN med_dose_events e ON e.id=a.dose_event_id WHERE a.id=$1',
          [id]
        )
      ).rows[0];
      if (!subject || !(await c.lockPatient(db, subject.patient_user_id, { optional: true })))
        return;
      const a = (
        await db.query(
          "UPDATE med_call_attempts SET state='ENDED',ended_at=NOW(),end_reason='no_answer' WHERE id=$1 AND state IN('QUEUED','SENDING','DELIVERED') AND deadline<=NOW() RETURNING *",
          [id]
        )
      ).rows[0];
      if (!a) return;
      const e = (
        await db.query(
          'SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id WHERE e.id=$1 FOR UPDATE OF e',
          [a.dose_event_id]
        )
      ).rows[0];
      if (e.state !== 'CALLING') return;
      const state = e.attempt_count >= 2 ? 'UNCONFIRMED' : 'SCHEDULED';
      await db.query(
        "UPDATE med_dose_events SET state=$2,next_attempt_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=$1",
        [e.id, state]
      );
      if (state === 'UNCONFIRMED') {
        await familyResult(db, { ...e, state });
        await aggregateDay(db, e.patient_user_id, e.local_date);
      }
    });
}
async function pendingCheckin(db, user, id) {
  return (
    await db.query(
      `SELECT e.id FROM med_dose_events e WHERE e.patient_user_id=$1 AND e.state='TAKEN' AND e.checkin_pending
 AND(e.id=$2 OR EXISTS(SELECT 1 FROM med_call_attempts a JOIN med_call_attempts b ON a.group_id=b.group_id WHERE a.dose_event_id=$2 AND b.dose_event_id=e.id))
 AND NOT EXISTS(SELECT 1 FROM health_checkins WHERE user_id=$1 AND session_date=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND last_response_at IS NOT NULL)
 ORDER BY e.scheduled_at,e.id LIMIT 1`,
      [user, id]
    )
  ).rows[0]?.id;
}
async function detail(db, user, id) {
  c.uuid.parse(id);
  await c.assertFeature(db, user, 'medication');
  const event = (
    await db.query(
      'SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id WHERE e.id=$1 AND e.patient_user_id=$2',
      [id, user]
    )
  ).rows[0];
  if (!event) throw c.error('MED_DOSE_NOT_FOUND', 404);
  const attempt = (
    await db.query(
      'SELECT * FROM med_call_attempts WHERE dose_event_id=$1 ORDER BY attempt_no DESC LIMIT 1',
      [id]
    )
  ).rows[0];
  const group = attempt
    ? (
        await db.query('SELECT dose_event_id FROM med_call_attempts WHERE group_id=$1', [
          attempt.group_id,
        ])
      ).rows.map((a) => a.dose_event_id)
    : [id];
  const items = (
    await db.query('SELECT * FROM med_dose_items WHERE dose_event_id=ANY($1::uuid[]) ORDER BY id', [
      group,
    ])
  ).rows.map((i) => ({
    ...i,
    display_name: med.reveal(user, 'med_dose_items.display_name', i.display_name),
  }));
  const checkinDoseId = event.state === 'TAKEN' ? await pendingCheckin(db, user, id) : undefined;
  return {
    needsCheckin: !!checkinDoseId,
    checkinDoseId,
    event: { ...event, time_local: String(event.time_local).slice(0, 5) },
    attempt,
    items,
    canAnswer:
      !p.terminal.includes(event.state) &&
      (!!attempt || new Date(event.scheduled_at) <= new Date()) &&
      Date.now() - new Date(event.scheduled_at) <= 2 * 3600000,
  };
}
async function answer(pool, user, id, body) {
  c.uuid.parse(id);
  const x = answerSchema.parse(body);
  await c.assertFeature(pool, user, 'medication');
  return c.transaction(pool, async (db) => {
    // Serializes all group answers and exact request-id replays for this patient.
    await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE', [
      user,
    ]);
    const receipt = (
      await db.query(
        'SELECT * FROM med_answer_receipts WHERE patient_user_id=$1 AND request_id=$2',
        [user, x.request_id]
      )
    ).rows[0];
    if (receipt) {
      if (receipt.dose_event_id !== id || receipt.button !== x.button)
        throw c.error('MED_REQUEST_CHANGED', 409);
      const pending =
        receipt.response.event?.state === 'TAKEN' ? await pendingCheckin(db, user, id) : undefined;
      return { ...receipt.response, needsCheckin: !!pending, checkinDoseId: pending };
    }
    const main = (
      await db.query(
        'SELECT * FROM med_dose_events WHERE id=$1 AND patient_user_id=$2 FOR UPDATE',
        [id, user]
      )
    ).rows[0];
    if (!main) throw c.error('MED_DOSE_NOT_FOUND', 404);
    if (p.terminal.includes(main.state)) {
      const pending = main.state === 'TAKEN' ? await pendingCheckin(db, user, id) : undefined;
      return {
        event: main,
        alreadyAnswered: true,
        needsCheckin: !!pending,
        checkinDoseId: pending,
      };
    }
    if (Date.now() - new Date(main.scheduled_at) > 2 * 3600000) {
      await db.query(
        `INSERT INTO med_schedule_audit(schedule_id,patient_user_id,actor_user_id,action) VALUES($1,$2,$2,'late_answer_ignored')`,
        [main.schedule_id, user]
      );
      return { event: main, answerWindowClosed: true, needsCheckin: false };
    }
    const a = (
      await db.query(
        'SELECT * FROM med_call_attempts WHERE dose_event_id=$1 ORDER BY attempt_no DESC LIMIT 1',
        [id]
      )
    ).rows[0];
    if (!a && new Date(main.scheduled_at) > new Date()) throw c.error('MED_DOSE_NOT_DUE', 409);
    const ids = a
      ? (
          await db.query('SELECT dose_event_id FROM med_call_attempts WHERE group_id=$1', [
            a.group_id,
          ])
        ).rows.map((v) => v.dose_event_id)
      : [id];
    let result,
      checkinDoseId = null;
    for (const dose of ids) {
      const e = (
        await db.query(
          'SELECT e.*,s.time_local FROM med_dose_events e JOIN med_schedules s ON s.id=e.schedule_id WHERE e.id=$1 AND e.patient_user_id=$2 FOR UPDATE OF e',
          [dose, user]
        )
      ).rows[0];
      if (!e || p.terminal.includes(e.state) || Date.now() - new Date(e.scheduled_at) > 2 * 3600000)
        continue;
      const state = p.nextState(x.button),
        late = e.state === 'UNCONFIRMED';
      const first = (
        await db.query(
          "SELECT id FROM med_dose_events WHERE patient_user_id=$1 AND local_date=$2 AND state<>'CANCELLED' ORDER BY scheduled_at,id LIMIT 1",
          [user, e.local_date]
        )
      ).rows[0];
      const checked = !!(
        await db.query(
          "SELECT 1 FROM health_checkins WHERE user_id=$1 AND session_date=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND last_response_at IS NOT NULL",
          [user]
        )
      ).rowCount;
      const needs = x.button === 1 && first?.id === e.id && !checked;
      if (needs) checkinDoseId = e.id;
      const saved = (
        await db.query(
          `UPDATE med_dose_events SET state=$2,button=$3,answered_at=NOW(),checkin_pending=$4,
    taken_after_retry=$5,updated_at=NOW() WHERE id=$1 RETURNING *`,
          [e.id, state, x.button, needs, x.button === 1 && e.attempt_count > 1]
        )
      ).rows[0];
      await db.query(
        "UPDATE med_call_attempts SET state='ANSWERED',button=$2,ended_at=NOW(),end_reason='button' WHERE dose_event_id=$1 AND state IN('QUEUED','SENDING','DELIVERED')",
        [e.id, x.button]
      );
      if (x.button === 1) {
        const items = (
          await db.query(
            "SELECT * FROM med_dose_items WHERE dose_event_id=$1 AND kind='MEDICINE'",
            [e.id]
          )
        ).rows;
        for (const item of items) {
          const log = c.randomUUID();
          await db.query(
            "INSERT INTO logs_common(id,user_id,log_type,occurred_at,source,metadata) VALUES($1,$2,'medication',clock_timestamp(),'med_call',$3)",
            [log, user, JSON.stringify({ medDoseId: e.id, medItemId: item.item_id })]
          );
          // The source name remains field-encrypted, also in the legacy medication log.
          await db.query(
            'INSERT INTO medication_logs(log_id,med_name,dose_text) VALUES($1,$2,$3)',
            [
              log,
              med.protect(
                user,
                'medication_logs.med_name',
                med.reveal(user, 'med_dose_items.display_name', item.display_name)
              ),
              'Theo lịch nhắc',
            ]
          );
        }
      }
      await familyResult(db, { ...saved, time_local: e.time_local }, late ? 'late' : 'initial');
      await aggregateDay(db, user, e.local_date);
      if (e.id === id) result = { event: saved, needsCheckin: needs };
    }
    result = result || { event: main, alreadyAnswered: true, needsCheckin: main.checkin_pending };
    if (checkinDoseId) {
      result.needsCheckin = true;
      result.checkinDoseId = checkinDoseId;
    }
    await db.query(
      'INSERT INTO med_answer_receipts(request_id,patient_user_id,dose_event_id,button,response) VALUES($1,$2,$3,$4,$5)',
      [x.request_id, user, id, x.button, JSON.stringify(result)]
    );
    return result;
  });
}
async function checkin(pool, user, id, status) {
  c.uuid.parse(id);
  c.z.enum(['fine', 'tired', 'very_tired']).parse(status);
  await c.assertFeature(pool, user, 'medication');
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, user);
    const e = (
      await db.query(
        'SELECT * FROM med_dose_events WHERE id=$1 AND patient_user_id=$2 FOR UPDATE',
        [id, user]
      )
    ).rows[0];
    if (!e || e.state !== 'TAKEN') throw c.error('MED_CHECKIN_UNAVAILABLE', 409);
    if (!e.checkin_pending) return { checkinId: e.checkin_id, alreadyCheckedIn: true };
    let session = (
      await pool.query(
        "SELECT * FROM health_checkins WHERE user_id=$1 AND session_date=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND last_response_at IS NOT NULL",
        [user]
      )
    ).rows[0];
    if (!session)
      session = await require('../checkin/checkin.service').startCheckin(
        pool,
        user,
        status,
        null,
        null,
        { source: 'med_call' }
      );
    await db.query(
      'UPDATE med_dose_events SET checkin_id=$2,checkin_pending=FALSE,checkin_status=$3 WHERE id=$1',
      [id, session.id, status]
    );
    if (status !== 'fine')
      await c.message(db, {
        key: 'med.checkin:' + id,
        subject: user,
        recipient: user,
        kind: 'med_checkin_followup',
        payload: { checkinId: session.id },
      });
    return { checkinId: session.id, status: session.current_status };
  });
}
async function accept(pool, user, id) {
  c.uuid.parse(id);
  await c.assertFeature(pool, user, 'medication');
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, user);
    const attempt = (
      await db.query(
        `SELECT a.* FROM med_call_attempts a JOIN med_dose_events e ON e.id=a.dose_event_id
   WHERE a.id=$2 AND e.patient_user_id=$1 AND a.state IN('SENDING','DELIVERED') AND a.deadline>NOW() FOR UPDATE OF a`,
        [user, id]
      )
    ).rows[0];
    if (attempt) {
      const deadline = attempt.accepted_at ? attempt.deadline : new Date(Date.now() + 60000);
      await db.query(
        "UPDATE med_call_attempts SET accepted_at=COALESCE(accepted_at,NOW()),deadline=$2 WHERE group_id=$1 AND state IN('SENDING','DELIVERED')",
        [attempt.group_id, deadline]
      );
      return { attempt: { ...attempt, deadline } };
    }
    const consent = (
      await db.query(
        `UPDATE med_consent_calls cc SET deadline=NOW()+INTERVAL '60 seconds' FROM med_schedules s
   WHERE cc.id=$2 AND cc.patient_user_id=$1 AND cc.schedule_id=s.id AND s.active AND s.consent_state='PENDING'
   AND cc.state IN('SENDING','DELIVERED') AND cc.deadline>NOW() RETURNING cc.*`,
        [user, id]
      )
    ).rows[0];
    if (!consent) throw c.error('MED_CALL_ENDED', 409);
    return { attempt: consent };
  });
}
async function end(pool, user, id) {
  c.uuid.parse(id);
  await c.assertFeature(pool, user, 'medication');
  await pool.query(
    `UPDATE med_call_attempts a SET deadline=NOW() FROM med_dose_events e
  WHERE e.id=a.dose_event_id AND e.patient_user_id=$1 AND a.group_id IN(SELECT group_id FROM med_call_attempts WHERE id=$2)
  AND a.state IN('SENDING','DELIVERED')`,
    [user, id]
  );
  await pool.query(
    "UPDATE med_consent_calls SET state='ENDED' WHERE id=$2 AND patient_user_id=$1",
    [user, id]
  );
  return { ended: true };
}
async function nativeDecline(db, id, token) {
  c.uuid.parse(id);
  const a = (
    await db.query(
      `SELECT a.patient_user_id FROM med_call_attempts m JOIN med_dose_events a ON a.id=m.dose_event_id WHERE m.id=$1
 UNION ALL SELECT patient_user_id FROM med_consent_calls WHERE id=$1`,
      [id]
    )
  ).rows[0];
  const match = typeof token === 'string' && token.match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (
    !a ||
    !match ||
    Number(match[1]) * 1000 < Date.now() ||
    Number(match[1]) * 1000 > Date.now() + 180000
  )
    throw c.error('MED_CALL_TOKEN_INVALID', 401);
  const expected = declineToken(id, a.patient_user_id, match[1]).split('.')[1];
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(match[2], 'hex')))
    throw c.error('MED_CALL_TOKEN_INVALID', 401);
  await db.query(
    "UPDATE med_call_attempts SET deadline=NOW() WHERE id=$1 AND accepted_at IS NULL AND state IN('SENDING','DELIVERED')",
    [id]
  );
  await db.query(
    "UPDATE med_consent_calls SET state='ENDED' WHERE id=$1 AND state IN('SENDING','DELIVERED')",
    [id]
  );
  return { declined: true };
}
async function tick(pool) {
  await prepare(pool);
  await closeTimeouts(pool);
  await queueDue(pool);
  await dispatchAttempts(pool);
}
module.exports = {
  tick,
  prepare,
  queueDue,
  closeTimeouts,
  dispatchAttempts,
  detail,
  answer,
  checkin,
  aggregateDay,
  familyResult,
  registerDevice,
  accept,
  end,
  nativeDecline,
  declineToken,
  statusToken,
  nativeStatus,
  sendNative,
  nativeTokens,
  busyUntil,
};
