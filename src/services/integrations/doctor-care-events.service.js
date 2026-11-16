'use strict';
const { z } = require('zod');
const { verifyDoctorSignature } = require('./doctor-profile.service');
const { assertTenantAllowed } = require('./doctor-task.service');
const {
  reserveNotification,
  deliverNotification,
} = require('../notification/notification-dispatch.service');
const { t } = require('../../i18n');
const schema = z
  .object({
    event_id: z.string().uuid(),
    event_type: z.literal('doctor.care.updated'),
    kind: z.enum(['invited', 'plan_proposed', 'item_due', 'item_reviewed', 'care_stopped']),
    tenant_id: z.string().min(1).max(120),
    app_user_id: z.string().regex(/^\d+$/),
    relationship_id: z.string().uuid(),
    occurred_at: z.string().datetime({ offset: true }),
  })
  .strict();
async function careEvent(pool, req) {
  verifyDoctorSignature(req);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    throw Object.assign(new Error(t('error.invalid_data', 'vi')), { statusCode: 400 });
  const event = parsed.data;
  assertTenantAllowed(event.tenant_id);
  const user = (
    await pool.query(
      "SELECT id,COALESCE(language_preference,'vi') AS language FROM users WHERE id=$1 AND deleted_at IS NULL",
      [Number(event.app_user_id)]
    )
  ).rows[0];
  if (!user) return { ok: true, data: { ignored: true } };
  const lang = user.language === 'en' ? 'en' : 'vi';
  const notification = await reserveNotification(pool, {
    userId: user.id,
    type: 'doctor_care',
    title: t('doctor.care_notice_title', lang),
    body: t('doctor.care_notice_body', lang),
    data: {
      type: 'doctor_care',
      event_id: event.event_id,
      relationship_id: event.relationship_id,
      tenant_id: event.tenant_id,
    },
    priority: 'medium',
    push: true,
  });
  if (notification) await deliverNotification(pool, notification.notificationId);
  return { ok: true, data: { accepted: true } };
}
module.exports = { careEvent, schema };
