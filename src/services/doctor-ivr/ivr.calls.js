'use strict';
const crypto = require('node:crypto');
const { tokenHash, compatibleDeviceTokens } = require('./ivr.devices');
const { t } = require('../../i18n');
const ivr = require('./ivr.service');
const { nextCallTime, defaults } = require('./ivr.policy');
const { sendFcmNotification } = require('../notification/fcm.notification.service');
const { sendVoipNotification } = require('../notification/apns.voip.service');
const enabled = () => ivr.enabled() && process.env.DOCTOR_IVR_CALL_ENABLED === 'true';
const policyFor = (s) => ({ ...defaults(), ...s.policy });
async function registerDevice(pool, user, supported, platform, token) {
  ivr.assertEnabled();
  return ivr.transaction(pool, async (db) => {
    const row = (
      await db.query(
        'SELECT fcm_token,voip_push_token,doctor_ivr_fcm_hash,doctor_ivr_voip_hash FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [user]
      )
    ).rows[0];
    if (!row) throw ivr.error('IVR_NOT_FOUND', 'Không tìm thấy tài khoản.', 404);
    const current = platform === 'android' ? row.fcm_token : row.voip_push_token;
    if (supported && (!token || token !== current))
      throw ivr.error('IVR_CALL_DEVICE_NOT_READY', 'Thiết bị chưa đăng ký nhận cuộc gọi.', 409);
    const fcm =
      platform === 'android' ? (supported ? tokenHash(current) : null) : row.doctor_ivr_fcm_hash;
    const voip =
      platform === 'ios' ? (supported ? tokenHash(current) : null) : row.doctor_ivr_voip_hash;
    await db.query(
      'UPDATE users SET doctor_ivr_calls=$2,doctor_ivr_fcm_hash=$3,doctor_ivr_voip_hash=$4 WHERE id=$1',
      [user, Boolean(fcm || voip), fcm, voip]
    );
    return { supported: !!supported };
  });
}
function capability(id, user, deadline) {
  const expires = Math.floor(new Date(deadline).getTime() / 1000) + 30;
  const signature = crypto
    .createHmac('sha256', ivr.key())
    .update(`doctor-ivr-decline:${id}:${user}:${expires}`)
    .digest('hex');
  return `${expires}.${signature}`;
}
function verifyCapability(attempt, token) {
  const match = typeof token === 'string' && token.match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (
    !match ||
    Number(match[1]) * 1000 < Date.now() ||
    Number(match[1]) * 1000 > Date.now() + 240000
  )
    throw ivr.error('IVR_INVALID_CALL_ACTION', 'Thao tác cuộc gọi đã hết hạn.', 401);
  const expected = capability(
    attempt.id,
    attempt.user_id,
    new Date(Number(match[1]) * 1000 - 30000)
  ).split('.')[1];
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(match[2], 'hex')))
    throw ivr.error('IVR_INVALID_CALL_ACTION', 'Thao tác cuộc gọi không hợp lệ.', 401);
}
async function callAction(pool, user, id, action, nativeToken) {
  ivr.assertEnabled();
  return ivr.transaction(pool, async (db) => {
    const row = (
      await db.query(
        `SELECT a.*,s.user_id,s.tenant_id,s.task_id,s.status session_status,s.expires_at
      FROM doctor_ivr_call_attempts a JOIN doctor_ivr_sessions s ON s.id=a.session_id
      WHERE a.id=$1 FOR UPDATE OF a,s`,
        [id]
      )
    ).rows[0];
    if (!row || (!nativeToken && Number(row.user_id) !== Number(user)))
      throw ivr.error('IVR_NOT_FOUND', 'Không tìm thấy cuộc gọi.', 404);
    if (nativeToken) {
      verifyCapability(row, nativeToken);
      action = 'decline';
    } else
      await ivr.scope(db, { app_user_id: user, tenant_id: row.tenant_id, task_id: row.task_id });
    if (action === 'accept') {
      if (row.status === 'accepted' && ['sent', 'in_progress'].includes(row.session_status))
        return { session_id: row.session_id, expires_at: row.expires_at };
      if (
        !['dispatching', 'ringing'].includes(row.status) ||
        new Date(row.ring_deadline).getTime() <= Date.now() ||
        !['sent', 'in_progress'].includes(row.session_status) ||
        new Date(row.expires_at).getTime() <= Date.now()
      )
        throw ivr.error(
          'IVR_CALL_ENDED',
          'Cuộc gọi đã kết thúc. Bạn có thể tiếp tục phiên trong app.'
        );
      await db.query(
        "UPDATE doctor_ivr_call_attempts SET status='accepted',accepted_at=NOW() WHERE id=$1",
        [id]
      );
    } else {
      // A native ring capability cannot end an authenticated connected call.
      const allowed = nativeToken
        ? ['dispatching', 'ringing']
        : ['dispatching', 'ringing', 'accepted'];
      if (allowed.includes(row.status))
        await db.query(
          'UPDATE doctor_ivr_call_attempts SET status=$2,finished_at=NOW() WHERE id=$1',
          [id, row.status === 'accepted' ? 'ended' : 'declined']
        );
    }
    await ivr.audit(
      db,
      row,
      nativeToken ? 'native' : String(user),
      `call.${action}`,
      { attempt_id: id },
      row.session_id
    );
    return { session_id: row.session_id, expires_at: row.expires_at };
  });
}
async function queueCall(pool, s, attemptNo = 1, after = new Date()) {
  const policy = policyFor(s),
    scheduled = nextCallTime(after, policy);
  if (scheduled >= new Date(s.expires_at)) return;
  await pool.query(
    `INSERT INTO doctor_ivr_call_attempts(id,session_id,attempt_no,status,scheduled_at)
    VALUES($1,$2,$3,'queued',$4) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), s.id, attemptNo, scheduled]
  );
}
async function runCalls(pool) {
  if (!enabled()) return;
  // End obsolete ringing/connected calls locally; no control VoIP pushes (iOS).
  await pool.query(`UPDATE doctor_ivr_call_attempts a SET status='cancelled',finished_at=NOW()
    FROM doctor_ivr_sessions s WHERE s.id=a.session_id AND a.status IN ('queued','dispatching','ringing','accepted')
    AND (s.status NOT IN ('sent','in_progress') OR s.expires_at<=NOW())`);
  await pool.query(`UPDATE doctor_ivr_call_attempts SET status='missed',finished_at=NOW()
    WHERE status IN ('dispatching','ringing') AND ring_deadline<=NOW()`);
  await pool.query(`UPDATE doctor_ivr_call_attempts SET status='ended',finished_at=NOW()
    WHERE status='accepted' AND accepted_at<NOW()-INTERVAL '10 minutes'`);
  const sessions = (
    await pool.query(`SELECT s.*,a.attempt_no,a.status call_status,a.finished_at FROM doctor_ivr_sessions s
    LEFT JOIN LATERAL(SELECT * FROM doctor_ivr_call_attempts WHERE session_id=s.id ORDER BY attempt_no DESC LIMIT 1) a ON TRUE
    WHERE s.channel IN ('call','both') AND s.status IN ('sent','in_progress') AND s.expires_at>NOW()
    AND ((a.id IS NULL AND s.status='sent') OR a.status IN ('missed','failed','declined','ended')) ORDER BY s.created_at LIMIT 20`)
  ).rows;
  for (const s of sessions) {
    const policy = policyFor(s);
    if ((s.attempt_no || 0) >= policy.call_retries + 1) {
      if (s.status === 'sent') {
        const changed = await pool.query(
          "UPDATE doctor_ivr_sessions SET status='unreachable',updated_at=NOW() WHERE id=$1 AND status='sent'",
          [s.id]
        );
        if (changed.rowCount) await ivr.audit(pool, s, 'system', 'session.unreachable', {}, s.id);
      }
      continue;
    }
    await queueCall(
      pool,
      s,
      (s.attempt_no || 0) + 1,
      s.remind_at && new Date(s.remind_at).getTime() > Date.now()
        ? new Date(s.remind_at)
        : s.finished_at
          ? new Date(new Date(s.finished_at).getTime() + policy.retry_minutes * 60000)
          : new Date()
    );
  }
  const attempts = (
    await pool.query(`UPDATE doctor_ivr_call_attempts SET status='dispatching',
    ring_deadline=NOW()+INTERVAL '60 seconds' WHERE id IN (SELECT a.id FROM doctor_ivr_call_attempts a
    JOIN doctor_ivr_sessions s ON s.id=a.session_id JOIN users u ON u.id=s.user_id
    WHERE a.status='queued' AND a.scheduled_at<=NOW()
    AND s.status IN ('sent','in_progress') AND s.expires_at>NOW()
    AND NOT EXISTS(SELECT 1 FROM doctor_ivr_call_attempts live JOIN doctor_ivr_sessions other ON other.id=live.session_id
      WHERE other.user_id=s.user_id AND live.status IN ('dispatching','ringing','accepted'))
    AND NOT EXISTS(SELECT 1 FROM checkin_call_attempts existing WHERE existing.target_user_id=s.user_id
      AND ((existing.state='RINGING' AND existing.ring_deadline>NOW()) OR (existing.state='CONNECTED' AND existing.confirm_deadline>NOW())))
    ORDER BY a.scheduled_at LIMIT 1 FOR UPDATE OF a,u SKIP LOCKED) RETURNING *`)
  ).rows;
  for (const attempt of attempts) {
    const s = (
      await pool.query('SELECT * FROM doctor_ivr_sessions WHERE id=$1', [attempt.session_id])
    ).rows[0];
    try {
      await ivr.scope(pool, { tenant_id: s.tenant_id, task_id: s.task_id, app_user_id: s.user_id });
      const policy = policyFor(s),
        next = nextCallTime(new Date(), policy);
      if (next.getTime() > Date.now() + 1000) {
        await pool.query(
          "UPDATE doctor_ivr_call_attempts SET status='queued',scheduled_at=$2,ring_deadline=NULL WHERE id=$1",
          [attempt.id, next]
        );
        continue;
      }
      const u = (
        await pool.query(
          'SELECT doctor_ivr_calls,fcm_token,voip_push_token,voip_push_environment,doctor_ivr_fcm_hash,doctor_ivr_voip_hash FROM users WHERE id=$1 AND deleted_at IS NULL',
          [s.user_id]
        )
      ).rows[0];
      const tokens = compatibleDeviceTokens(u);
      if (!u?.doctor_ivr_calls || !(tokens.fcm || tokens.voip))
        throw new Error('DEVICE_UNSUPPORTED');
      const deadline = new Date(Date.now() + policy.ring_seconds * 1000);
      await pool.query('UPDATE doctor_ivr_call_attempts SET ring_deadline=$2 WHERE id=$1', [
        attempt.id,
        deadline,
      ]);
      const payload = {
        type: 'doctor_ivr_call',
        callType: 'doctor_ivr',
        checkinCall: true,
        episodeId: s.id,
        attemptId: attempt.id,
        kind: 'INCOMING_CALL',
        severity: 'NORMAL',
        ringSeconds: policy.ring_seconds,
        ringDeadline: deadline.toISOString(),
        lang: 'vi',
      };
      const title = t('notification.doctor_ivr_call_title', 'vi', { doctorName: s.doctor_name });
      const body = t('notification.doctor_ivr_call_body', 'vi');
      const results = await Promise.all([
        tokens.fcm
          ? sendFcmNotification(
              tokens.fcm,
              title,
              body,
              { ...payload, declineCapability: capability(attempt.id, s.user_id, deadline) },
              { incomingCall: true }
            )
          : { ok: false },
        tokens.voip
          ? sendVoipNotification(tokens.voip, payload, {
              title,
              body: body,
              environment: u.voip_push_environment,
            })
          : { ok: false },
      ]);
      if (!results.some((r) => r.ok)) throw new Error('CALL_DELIVERY_FAILED');
      await pool.query(
        "UPDATE doctor_ivr_call_attempts SET status='ringing' WHERE id=$1 AND status='dispatching'",
        [attempt.id]
      );
      await ivr.audit(
        pool,
        s,
        'system',
        'call.ringing',
        { attempt_id: attempt.id, attempt_no: attempt.attempt_no },
        s.id
      );
    } catch (e) {
      await pool.query(
        "UPDATE doctor_ivr_call_attempts SET status='failed',finished_at=NOW(),delivery_error=$2 WHERE id=$1 AND status='dispatching'",
        [
          attempt.id,
          e.code === 'IVR_CONSENT_WITHDRAWN' ? 'CONSENT_WITHDRAWN' : 'CALL_DELIVERY_FAILED',
        ]
      );
    }
  }
}
module.exports = {
  enabled,
  registerDevice,
  capability,
  verifyCapability,
  queueCall,
  callAction,
  runCalls,
};
