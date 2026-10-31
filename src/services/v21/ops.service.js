'use strict';
const c = require('./common');
const getConfig = async (pool) => ({
  config: (await pool.query('SELECT * FROM v21_config WHERE id=1')).rows[0],
});
async function updateConfig(pool, body) {
  const x = c.z
    .object({
      medication_enabled: c.z.boolean(),
      coins_enabled: c.z.boolean(),
      scan_enabled: c.z.boolean(),
      native_call_enabled: c.z.boolean(),
      rollout_user_ids: c.z.array(c.idSchema).max(10000),
    })
    .strict()
    .parse(body);
  if (x.scan_enabled || x.medication_enabled) require('./medication.service').requireEncryption();
  return {
    config: (
      await pool.query(
        `UPDATE v21_config SET medication_enabled=$1,coins_enabled=$2,scan_enabled=$3,native_call_enabled=$4,rollout_user_ids=$5,updated_at=NOW() WHERE id=1 RETURNING *`,
        [
          x.medication_enabled,
          x.coins_enabled,
          x.scan_enabled,
          x.native_call_enabled,
          x.rollout_user_ids,
        ]
      )
    ).rows[0],
  };
}
const rules = async (pool) => ({
  rules: (await pool.query('SELECT * FROM coin_rules ORDER BY task_code')).rows,
});
async function updateRules(pool, body) {
  const items = c.z
    .array(
      c.z
        .object({
          task_code: c.z.enum(['CHECKIN', 'MED_ANSWER', 'VITAL', 'GIFT_OPEN', 'WEEKLY']),
          coins: c.z.number().int().min(1).max(100),
          daily_limit: c.z.number().int().min(0).max(4),
          weekly_limit: c.z.number().int().min(0).max(1),
          active: c.z.boolean(),
        })
        .strict()
    )
    .min(1)
    .max(5)
    .refine((a) => new Set(a.map((x) => x.task_code)).size === a.length)
    .parse(body.rules);
  return c.transaction(pool, async (db) => {
    for (const x of items) {
      const max = { CHECKIN: 1, MED_ANSWER: 4, VITAL: 2, GIFT_OPEN: 1, WEEKLY: 0 }[x.task_code];
      if (x.daily_limit > max || (x.task_code !== 'WEEKLY' && x.weekly_limit))
        throw c.error('V21_INVALID_CONFIG');
      await db.query(
        'UPDATE coin_rules SET coins=$2,daily_limit=$3,weekly_limit=$4,active=$5 WHERE task_code=$1',
        [x.task_code, x.coins, x.daily_limit, x.weekly_limit, x.active]
      );
    }
    return { updated: true };
  });
}
const rewards = async (pool) => ({
  items: (await pool.query('SELECT * FROM reward_catalog ORDER BY code')).rows,
  templates: (await pool.query('SELECT * FROM greeting_templates ORDER BY code')).rows,
});
async function updateReward(pool, code, body) {
  const x = c.z
    .object({ cost: c.z.number().int().positive().max(100000), active: c.z.boolean() })
    .strict()
    .parse(body);
  const result = await pool.query(
    'UPDATE reward_catalog SET cost=$2,active=$3 WHERE code=$1 RETURNING *',
    [code, x.cost, x.active]
  );
  if (!result.rowCount) throw c.error('COIN_REWARD_UNAVAILABLE', 404);
  return { reward: result.rows[0] };
}
async function updateTemplate(pool, code, body) {
  const x = c.z
    .object({
      title: c.z.string().trim().min(1).max(100),
      title_en: c.z.string().trim().min(1).max(100),
      body: c.z.string().trim().min(1).max(500),
      body_en: c.z.string().trim().min(1).max(500),
      active: c.z.boolean(),
      approved_by: c.z.string().trim().min(1).max(100),
    })
    .strict()
    .parse(body);
  const result = await pool.query(
    'UPDATE greeting_templates SET title=$2,title_en=$3,body=$4,body_en=$5,active=$6,approved_by=$7,approved_at=NOW() WHERE code=$1 RETURNING *',
    [code, x.title, x.title_en, x.body, x.body_en, x.active, x.approved_by]
  );
  if (!result.rowCount) throw c.error('COIN_TEMPLATE_UNAVAILABLE', 404);
  return { template: result.rows[0] };
}
module.exports = {
  getConfig,
  updateConfig,
  rules,
  updateRules,
  rewards,
  updateReward,
  updateTemplate,
};
