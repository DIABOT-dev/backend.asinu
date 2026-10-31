'use strict';
const c = require('./common');
const {
  reserveNotification,
  deliverNotification,
} = require('../notification/notification-dispatch.service');
const coins = require('./coins.service');
function copy(kind, payload, en) {
  const title = en ? 'Asinu' : 'Asinu';
  const texts = {
    med_consent: en
      ? 'Your family set up medication reminders. Open Asinu to accept or decline.'
      : 'Người thân vừa cài lịch nhắc thuốc. Mở Asinu để đồng ý hoặc từ chối.',
    med_schedule_changed:
      payload.action === 'declined'
        ? en
          ? 'Your family member declined medication reminders.'
          : 'Người thân chưa muốn nhận cuộc gọi nhắc thuốc.'
        : payload.action === 'accepted'
          ? en
            ? 'Medication reminders have been accepted.'
            : 'Người thân đã đồng ý nhận nhắc thuốc.'
          : en
            ? 'A medication reminder schedule was updated. Open Asinu to review it.'
            : 'Lịch nhắc thuốc vừa được thay đổi. Mở Asinu để xem lại.',
    med_consent_pending: en
      ? 'Your family member has not accepted the medication reminder schedule yet.'
      : 'Người thân chưa xác nhận lịch nhắc thuốc. Lịch vẫn chưa chạy.',
    med_checkin_followup: en
      ? 'Please open Asinu and tell us more about how you feel.'
      : 'Bác mở app kể thêm cho cháu nhé.',
    coin_refund: en
      ? 'We could not send your reward. Your coins have been returned.'
      : 'Chưa gửi được quà. Asinu đã hoàn xu cho bạn.',
    coin_expiring: en
      ? `${payload.coins} coins will expire within 7 days.`
      : `Bạn có ${payload.coins} xu sẽ hết hạn trong 7 ngày tới.`,
    weekly_v21: en
      ? `This week: ${payload.taken}/${payload.total} medication doses confirmed; ${payload.coins} coins earned.${payload.skipped ? ` ${payload.skipped} doses skipped (irregular adherence).` : ''}`
      : `Tuần qua người thân đã xác nhận ${payload.taken}/${payload.total} cữ thuốc và nhận được ${payload.coins} xu.${payload.skipped ? ` Đã bỏ qua ${payload.skipped} cữ thuốc (uống không đều).` : ''}`,
  };
  if (kind === 'med_result') {
    const states = {
      TAKEN: en
        ? 'Your family member confirmed taking this medication dose.'
        : 'Người thân đã xác nhận uống cữ thuốc này.',
      SKIPPED: en
        ? 'Your family member chose to skip this dose.'
        : 'Người thân đã chọn bỏ qua cữ thuốc này.',
      OUT_OF_MEDS: en
        ? payload.repeatCount > 1
          ? `Your family member is still out of medication (${payload.repeatCount} reports this week).`
          : 'Your family member reported running out of medication.'
        : payload.repeatCount > 1
          ? `Người thân vẫn báo hết thuốc (lần ${payload.repeatCount} trong 7 ngày).`
          : 'Người thân báo đã hết thuốc.',
      UNCONFIRMED: en
        ? 'This medication dose has not been confirmed.'
        : 'Cữ thuốc này chưa được xác nhận.',
      SKIPPED_NO_DEVICE: en
        ? 'Asinu could not reach your family member’s device.'
        : 'Asinu không liên lạc được với máy của người thân.',
    };
    return { title, body: states[payload.state] || states.UNCONFIRMED };
  }
  return { title, body: texts[kind] || '' };
}
async function processMessages(pool) {
  const jobs = await c.transaction(
    pool,
    async (db) =>
      (
        await db.query(`UPDATE v21_message_outbox SET next_at=NOW()+INTERVAL '60 seconds',attempts=attempts+1
  WHERE id IN(SELECT id FROM v21_message_outbox WHERE completed_at IS NULL AND next_at<=NOW() ORDER BY id LIMIT 30 FOR UPDATE SKIP LOCKED) RETURNING *`)
      ).rows
  );
  for (const job of jobs) {
    try {
      const owner = Number(job.subject_id),
        recipient = Number(job.recipient_id);
      const connected = owner === recipient || (await c.hasConnection(pool, owner, recipient));
      if (!connected) {
        if (job.kind === 'coin_card') await coins.refund(pool, job.payload.redemptionId);
        await pool.query('UPDATE v21_message_outbox SET completed_at=NOW() WHERE id=$1', [job.id]);
        continue;
      }
      const en = String(
        (
          await pool.query(
            'SELECT language_preference FROM users WHERE id=$1 AND deleted_at IS NULL',
            [recipient]
          )
        ).rows[0]?.language_preference
      ).startsWith('en');
      let text = copy(job.kind, job.payload, en);
      if (job.kind === 'coin_card') {
        const redemption = (
          await pool.query('SELECT status FROM reward_redemptions WHERE id=$1 AND user_id=$2', [
            job.payload.redemptionId,
            owner,
          ])
        ).rows[0];
        if (!redemption || redemption.status === 'REFUNDED') {
          await pool.query('UPDATE v21_message_outbox SET completed_at=NOW() WHERE id=$1', [
            job.id,
          ]);
          continue;
        }
        const template = (
          await pool.query(
            'SELECT * FROM greeting_templates WHERE code=$1 AND active AND approved_at IS NOT NULL',
            [job.payload.templateCode]
          )
        ).rows[0];
        if (!template) {
          await coins.refund(pool, job.payload.redemptionId);
          await pool.query('UPDATE v21_message_outbox SET completed_at=NOW() WHERE id=$1', [
            job.id,
          ]);
          continue;
        }
        text = {
          title: en ? template.title_en : template.title,
          body: en ? template.body_en : template.body,
        };
      }
      if (!text.body) throw c.error('V21_MESSAGE_UNKNOWN', 503);
      const screen =
        job.kind === 'coin_card' || job.kind.startsWith('coin_')
          ? '/coins'
          : job.payload.checkinId
            ? `/checkin?checkin_id=${job.payload.checkinId}`
            : job.payload.scheduleId
              ? `/medication/consent?schedule=${job.payload.scheduleId}`
              : '/medication';
      const saved = await reserveNotification(pool, {
        userId: recipient,
        type: job.kind,
        title: text.title,
        body: text.body,
        data: { eventId: job.event_key, patientId: owner, screen, ...job.payload },
        cooldownMinutes: 10080,
      });
      if (!saved) throw c.error('V21_MESSAGE_RETRY', 503);
      const sent = await deliverNotification(pool, saved.notificationId);
      if (job.kind === 'coin_card') {
        if (!(await c.hasConnection(pool, owner, recipient))) {
          await coins.refund(pool, job.payload.redemptionId);
        } else if (sent.ok)
          await pool.query(
            "UPDATE reward_redemptions SET status='DELIVERED',delivered_at=NOW() WHERE id=$1 AND status='PENDING'",
            [job.payload.redemptionId]
          );
        else if (job.attempts >= 5) {
          await coins.refund(pool, job.payload.redemptionId);
        } else throw c.error('V21_MESSAGE_RETRY', 503);
      }
      await pool.query(
        'UPDATE v21_message_outbox SET completed_at=NOW(),notification_id=$2 WHERE id=$1',
        [job.id, saved.notificationId]
      );
    } catch {
      if (job.attempts >= 5 && job.kind === 'coin_card') {
        await coins.refund(pool, job.payload.redemptionId);
        await pool.query('UPDATE v21_message_outbox SET completed_at=NOW() WHERE id=$1', [job.id]);
      }
    }
  }
}
async function weekly(pool) {
  const people = (
    await pool.query(
      "SELECT id FROM users WHERE deleted_at IS NULL AND (v21_allowed(id,'medication') OR v21_allowed(id,'coins'))"
    )
  ).rows;
  for (const { id: user } of people) {
    const report = (
      await pool.query(
        `SELECT
   (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state<>'CANCELLED' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-7 AND local_date<date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int total,
   (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state='TAKEN' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-7 AND local_date<date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int taken,
   (SELECT count(*) FROM med_dose_events WHERE patient_user_id=$1 AND has_medicine AND state='SKIPPED' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-7 AND local_date<date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int skipped,
   (SELECT COALESCE(sum(delta),0) FROM coin_ledger WHERE user_id=$1 AND delta>0 AND reason<>'REFUND' AND local_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-7 AND local_date<date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int coins,
   date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text week`,
        [user]
      )
    ).rows[0];
    const family = (
      await pool.query(
        `SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END id FROM user_connections
   WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1) AND COALESCE((permissions->>'can_receive_alerts')::boolean,FALSE)`,
        [user]
      )
    ).rows;
    for (const f of family)
      await c.message(pool, {
        key: `v21.weekly:${user}:${report.week}:${f.id}`,
        subject: user,
        recipient: f.id,
        kind: 'weekly_v21',
        payload: report,
      });
  }
}
module.exports = { processMessages, weekly, copy };
