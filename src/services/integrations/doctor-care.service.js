'use strict';
const { z } = require('zod');
const {
  deliverDoctorRequest,
  configuredTenantIds,
  assertTenantAllowed,
  assertPatientOwnsTask,
} = require('./doctor-task.service');
const {
  consultationCreditSummary,
  settleConsultationCredit,
} = require('../payment/consultation-credit.service');
const { t, getLang } = require('../../i18n');

const action = z.object({ action_id: z.string().uuid() });
const schema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('get'), relationship_id: z.string().uuid() }).strict(),
  action
    .extend({
      operation: z.literal('consent'),
      relationship_id: z.string().uuid(),
      decision: z.enum(['accept', 'decline', 'revoke']),
      consent_version: z.literal('care-v1'),
    })
    .strict(),
  action
    .extend({
      operation: z.literal('accept_plan'),
      relationship_id: z.string().uuid(),
      plan_id: z.string().uuid(),
      expected_version: z.number().int().positive(),
    })
    .strict(),
  action
    .extend({
      operation: z.literal('submit'),
      relationship_id: z.string().uuid(),
      item_id: z.string().uuid(),
      expected_version: z.number().int().positive(),
      response: z.string().trim().min(1).max(3000),
    })
    .strict(),
]);
async function patientCare(pool, req) {
  const parsed = schema.safeParse(req.method === 'GET' ? { operation: 'list' } : req.body);
  if (!parsed.success)
    throw Object.assign(new Error(t('error.invalid_data', req.lang || 'vi')), { statusCode: 400 });
  const patient = (
    await pool.query(
      'SELECT display_name,full_name FROM users WHERE id=$1 AND deleted_at IS NULL',
      [req.user.id]
    )
  ).rows[0];
  if (!patient)
    throw Object.assign(new Error(t('error.patient_not_found', req.lang || 'vi')), {
      statusCode: 404,
    });
  const payload = {
    ...parsed.data,
    app_user_id: String(req.user.id),
    tenant_ids: configuredTenantIds(),
  };
  if (payload.operation === 'consent' && payload.decision === 'accept')
    payload.patient_label = patient.display_name || patient.full_name || '';
  const result = await deliverDoctorRequest('care', payload, parsed.data.action_id, getLang(req));
  return { ok: true, data: result.data };
}
async function patientCredits(pool, req) {
  return { ok: true, data: await consultationCreditSummary(pool, req.user.id) };
}
const taskInput = z.object({ tenant_id: z.string().trim().min(1).max(120) }).strict();
async function ownedTask(pool, req, input) {
  assertTenantAllowed(input.tenant_id);
  await assertPatientOwnsTask(pool, input.tenant_id, req.params.taskId, req.user.id);
  return {
    tenant_id: input.tenant_id,
    app_user_id: String(req.user.id),
    task_id: req.params.taskId,
  };
}
async function reconsultationContext(pool, req) {
  const parsed = taskInput.safeParse(req.query);
  if (!parsed.success)
    throw Object.assign(new Error(t('error.invalid_data', getLang(req))), { statusCode: 400 });
  const input = await ownedTask(pool, req, parsed.data);
  const { data } = await deliverDoctorRequest('status', input);
  if (data.status !== 'completed')
    throw Object.assign(new Error(t('doctor.reconsultation_unavailable', getLang(req))), {
      statusCode: 409,
      code: 'DOCTOR_PREVIOUS_TASK_NOT_COMPLETED',
    });
  const source = (
    await pool.query(
      `SELECT payload->'payload'->>'specialty' AS specialty FROM doctor_task_outbox
    WHERE tenant_id=$1 AND payload->'payload'->>'task_id'=$2 AND payload->'payload'->>'app_user_id'=$3 LIMIT 1`,
      [input.tenant_id, input.task_id, input.app_user_id]
    )
  ).rows[0];
  return {
    ok: true,
    data: {
      previous_task_id: input.task_id,
      tenant_id: input.tenant_id,
      specialty: source.specialty,
    },
  };
}
async function cancelPatientTask(pool, req) {
  const parsed = taskInput.safeParse(req.body);
  if (!parsed.success)
    throw Object.assign(new Error(t('error.invalid_data', getLang(req))), { statusCode: 400 });
  const input = await ownedTask(pool, req, parsed.data);
  const { data } = await deliverDoctorRequest('cancel', input);
  const { stopPatientTaskIvr } = require('./doctor-task-closure.service');
  await stopPatientTaskIvr(pool, req.user.id, input.tenant_id, input.task_id);
  const credit = await settleConsultationCredit(
    pool,
    req.user.id,
    input.tenant_id,
    input.task_id,
    data.status
  );
  if (credit.state === 'released')
    await deliverDoctorRequest('credit-status', { ...input, state: 'released' });
  return { ok: true, data: { ...data, credit_state: credit.state } };
}
module.exports = { patientCare, patientCredits, reconsultationContext, cancelPatientTask, schema };
