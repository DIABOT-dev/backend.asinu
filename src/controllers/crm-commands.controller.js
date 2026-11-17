'use strict';
const { z } = require('zod');
const { executeCommand } = require('../services/integrations/crm-commands.service');
const schema = z
  .object({
    command_id: z.string().uuid(),
    action: z.enum(['snapshot', 'reward.refund', 'notification.retry']),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(25).optional(),
    resource_id: z.string().min(1).max(160).optional(),
    actor_ref: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action === 'reward.refund' && !z.string().uuid().safeParse(body.resource_id).success)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resource_id'],
        message: 'Invalid reward reference',
      });
    if (body.action === 'notification.retry' && !body.resource_id)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resource_id'],
        message: 'Missing notification reference',
      });
  });
async function crmCommand(pool, req, res) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, code: 'INVALID_CRM_COMMAND' });
  return res.json({ ok: true, data: await executeCommand(pool, parsed.data) });
}
module.exports = { crmCommand };
