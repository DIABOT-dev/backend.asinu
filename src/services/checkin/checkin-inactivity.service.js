'use strict';

const { t } = require('../../i18n');
const logger = require('../../lib/logger');
const { formatPersonName } = require('../../lib/text-format');
const {
  reserveNotification,
  deliverNotification,
} = require('../notification/notification-dispatch.service');
const { INACTIVITY_NOTICE_TYPE, inactivityStateSql } = require('./checkin-inactivity.policy');

async function notifyInactiveCareCircles(pool, limit = 200) {
  const { rows } = await pool.query(
    `SELECT DISTINCT subject.id AS patient_id, COALESCE(subject.full_name, subject.display_name) AS patient_name,
       relative.id AS recipient_id, COALESCE(relative.language_preference, 'vi') AS lang,
       inactivity.inactive_since_date
     FROM users subject
     CROSS JOIN LATERAL (${inactivityStateSql('subject.id')}) inactivity
     JOIN user_connections uc ON (uc.requester_id = subject.id OR uc.addressee_id = subject.id)
       AND uc.status = 'accepted'
       AND COALESCE((uc.permissions->>'can_receive_alerts')::boolean, false) = true
     JOIN users relative ON relative.id = CASE WHEN uc.requester_id = subject.id THEN uc.addressee_id ELSE uc.requester_id END
     WHERE subject.deleted_at IS NULL AND relative.deleted_at IS NULL AND inactivity.paused
       AND NOT EXISTS (SELECT 1 FROM checkin_inactivity_notices receipt
         WHERE receipt.subject_user_id = subject.id AND receipt.recipient_user_id = relative.id
           AND receipt.inactive_since_date = inactivity.inactive_since_date::date)
     ORDER BY subject.id, relative.id LIMIT $1`,
    [limit]
  );
  let created = 0;
  for (const row of rows) {
    try {
      const data = {
        type: INACTIVITY_NOTICE_TYPE,
        patient_id: row.patient_id,
        inactive_since_date: row.inactive_since_date,
        event_id: `checkin-inactivity:${row.patient_id}:${row.inactive_since_date}`,
      };
      const patientName =
        formatPersonName(row.patient_name) ||
        t('notification.reengagement.family_fallback', row.lang);
      const reserved = await reserveNotification(pool, {
        userId: row.recipient_id,
        type: INACTIVITY_NOTICE_TYPE,
        title: t('notification.checkin_inactivity.title', row.lang),
        body: t('notification.checkin_inactivity.body', row.lang, { patientName }),
        data,
        priority: 'high',
      });
      if (!reserved) continue;
      if (!reserved.existing) created++;
      await deliverNotification(pool, reserved.notificationId);
    } catch (err) {
      logger.error('checkin_inactivity.notice_failed', {
        patientId: row.patient_id,
        recipientId: row.recipient_id,
        err,
      });
    }
  }
  return { scanned: rows.length, created };
}

module.exports = { notifyInactiveCareCircles };
