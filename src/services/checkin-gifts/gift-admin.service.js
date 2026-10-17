'use strict';
const { z } = require('zod');
const { giftError } = require('./gift.service');
const configSchema = z
  .object({
    enabled: z.boolean(),
    loc_weight: z.number().int().min(0).max(100),
    ticket_weight: z.number().int().min(0).max(100),
    coupon_weight: z.number().int().min(0).max(100),
    lucky_draw_enabled: z.boolean(),
    coupon_enabled: z.literal(false),
    coupon_max_vnd: z.number().int().min(0).max(100000),
  })
  .strict()
  .refine((x) => x.loc_weight + x.ticket_weight + x.coupon_weight === 100);
const locSchema = z
  .object({
    type: z.enum(['wish', 'proverb', 'health_tip']),
    text: z.string().trim().min(1).max(1000),
    text_en: z.string().trim().min(1).max(1000),
    conditions: z.array(z.string().trim().min(1).max(80)).max(20),
    serif: z.boolean(),
    active: z.boolean(),
    reviewed_by: z.string().trim().min(1).max(150).nullable(),
  })
  .strict()
  .refine((x) => x.type !== 'health_tip' || !x.active || Boolean(x.reviewed_by));
const id = (value) =>
  z
    .string()
    .regex(/^\d{1,18}$/)
    .parse(value);
async function getConfig(pool) {
  return { config: (await pool.query('SELECT * FROM gift_config WHERE id=1')).rows[0] };
}
async function saveConfig(pool, body) {
  const c = configSchema.parse(body);
  const saved = await pool.query(
    'UPDATE gift_config SET enabled=$1,loc_weight=$2,ticket_weight=$3,coupon_weight=$4,lucky_draw_enabled=$5,coupon_enabled=$6,coupon_max_vnd=$7,updated_at=NOW() WHERE id=1 RETURNING *',
    [
      c.enabled,
      c.loc_weight,
      c.ticket_weight,
      c.coupon_weight,
      c.lucky_draw_enabled,
      c.coupon_enabled,
      c.coupon_max_vnd,
    ]
  );
  return { config: saved.rows[0] };
}
async function listLocs(pool) {
  return { items: (await pool.query('SELECT * FROM loc_items ORDER BY id')).rows };
}
async function saveLoc(pool, code, body) {
  z.string()
    .regex(/^[a-z0-9_-]{1,80}$/)
    .parse(code);
  const x = locSchema.parse(body);
  const saved = await pool.query(
    `INSERT INTO loc_items (code,type,text,text_en,conditions,serif,active,reviewed_by,reviewed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END)
    ON CONFLICT (code) DO UPDATE SET type=$2,text=$3,text_en=$4,conditions=$5,serif=$6,active=$7,reviewed_by=$8,
    reviewed_at=CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END,updated_at=NOW() RETURNING *`,
    [code, x.type, x.text, x.text_en, x.conditions, x.serif, x.active, x.reviewed_by]
  );
  return { item: saved.rows[0] };
}
async function saveDraw(pool, code, body) {
  z.string()
    .regex(/^[a-z0-9_-]{1,80}$/i)
    .parse(code);
  const x = z
    .object({
      prize_name: z.string().trim().min(1).max(300),
      starts_at: z.string().datetime(),
      closes_at: z.string().datetime(),
      draw_at: z.string().datetime(),
      rules: z.object({
        vi: z.string().trim().min(30).max(20000),
        en: z.string().trim().min(30).max(20000),
      }),
      registration_reference: z.string().trim().min(1).max(300),
      active: z.boolean(),
    })
    .strict()
    .parse(body);
  if (
    new Date(x.starts_at) >= new Date(x.closes_at) ||
    new Date(x.closes_at) >= new Date(x.draw_at)
  )
    throw giftError('INVALID_DRAW_DATES');
  const drawDateVn = new Date(Date.parse(x.draw_at) + 7 * 3600000).toISOString().slice(0, 10);
  const expectedClose = Date.parse(drawDateVn + 'T00:00:00+07:00') - 60000;
  if (Date.parse(x.closes_at) !== expectedClose)
    throw giftError('DRAW_CLOSE_MUST_BE_PREVIOUS_DAY_2359_VN');
  const saved = await pool.query(
    `INSERT INTO gift_draw_periods (code,prize_name,starts_at,closes_at,draw_at,rules,registration_reference,active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO UPDATE SET prize_name=$2,starts_at=$3,closes_at=$4,draw_at=$5,rules=$6,registration_reference=$7,active=$8
    WHERE gift_draw_periods.locked_at IS NULL AND NOT EXISTS (SELECT 1 FROM draw_tickets WHERE draw_period=gift_draw_periods.id) RETURNING *`,
    [
      code,
      x.prize_name,
      x.starts_at,
      x.closes_at,
      x.draw_at,
      JSON.stringify(x.rules),
      x.registration_reference,
      x.active,
    ]
  );
  if (!saved.rows[0]) throw giftError('DRAW_ALREADY_HAS_TICKETS', 409);
  return { period: saved.rows[0] };
}
async function exportTickets(pool, periodId) {
  id(periodId);
  const period = (
    await pool.query(
      'UPDATE gift_draw_periods SET locked_at=COALESCE(locked_at,NOW()) WHERE id=$1 AND closes_at <= NOW() RETURNING id',
      [periodId]
    )
  ).rows[0];
  if (!period) throw giftError('DRAW_NOT_CLOSED', 409);
  const rows = (
    await pool.query(
      'SELECT ticket_no,household_id,issued_at FROM draw_tickets WHERE draw_period=$1 ORDER BY ticket_no',
      [periodId]
    )
  ).rows;
  return (
    'ticket_no,household_id,issued_at\n' +
    rows.map((x) => `${x.ticket_no},${x.household_id},${x.issued_at.toISOString()}`).join('\n')
  );
}
async function publish(pool, periodId, body) {
  id(periodId);
  const tickets = z
    .array(z.string().regex(/^A\d{1,20}$/))
    .min(1)
    .max(100)
    .parse(body?.ticket_numbers);
  return require('./draw.service').publish(pool, periodId, tickets);
}
module.exports = { getConfig, saveConfig, listLocs, saveLoc, saveDraw, exportTickets, publish };
