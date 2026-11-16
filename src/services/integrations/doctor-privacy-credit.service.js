'use strict';
const { z } = require('zod');
const { settleConsultationCredit } = require('../payment/consultation-credit.service');

const settlementsSchema = z
  .array(
    z
      .object({
        doctor_task_id: z.string().uuid(),
        task_id: z.string().min(1).max(160),
        status: z.enum(['completed', 'cancelled', 'expired']),
      })
      .strict()
  )
  .max(1000);

// The authenticated Doctor privacy response carries only financial references,
// never clinical content. Persist the ledger outcome and acknowledge it before
// the local privacy pass removes ordinary consultation identifiers.
async function settlePrivacyCredits(pool, { userId, tenantId, settlements, version }, sendReceipt) {
  if (settlements === undefined) return;
  const parsed = settlementsSchema.safeParse(settlements);
  if (!parsed.success)
    throw Object.assign(new Error('Invalid consultation settlement response.'), {
      statusCode: 502,
      code: 'DOCTOR_PRIVACY_SETTLEMENT_INVALID',
    });
  for (const item of parsed.data) {
    const credit = await settleConsultationCredit(
      pool,
      userId,
      tenantId,
      item.task_id,
      item.status
    );
    if (['consumed', 'released'].includes(credit.state))
      await sendReceipt('credit-status', {
        tenant_id: tenantId,
        app_user_id: String(userId),
        task_id: item.task_id,
        doctor_task_id: item.doctor_task_id,
        state: credit.state,
      });
  }
  if (version === 1) {
    // A pending delivery absent from the authoritative Doctor receipt did not
    // create a consultation before consent was revoked. It cannot be replayed
    // under a later consent grant, so release the local hold without a debit.
    const pending = await pool.query(
      `SELECT r.task_id FROM doctor_consultation_credit_reservations r
      WHERE r.user_id=$1 AND r.tenant_id=$2 AND r.state='reserved'
        AND NOT (r.task_id=ANY($3::text[])) AND EXISTS(
          SELECT 1 FROM doctor_task_outbox o WHERE o.tenant_id=r.tenant_id AND o.status<>'sent'
            AND o.payload->'payload'->>'task_id'=r.task_id
            AND o.payload->'payload'->>'app_user_id'=$4
        )`,
      [userId, tenantId, parsed.data.map((item) => item.task_id), String(userId)]
    );
    for (const item of pending.rows)
      await settleConsultationCredit(pool, userId, tenantId, item.task_id, 'cancelled');
  }
}
module.exports = { settlePrivacyCredits };
