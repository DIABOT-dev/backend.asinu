'use strict';

const { z } = require('zod');

const healthAccessSchema = z.object({ can_view_logs: z.boolean() }).strict();
const memberCalendarSchema = z.object({
  memberId: z.coerce.number().int().positive().safe(),
  month: z.string().regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/),
});

module.exports = { healthAccessSchema, memberCalendarSchema };
