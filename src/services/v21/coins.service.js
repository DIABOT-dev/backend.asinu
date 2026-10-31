'use strict';
const c = require('./common');
const entitlement = require('../payment/entitlement.service');

async function addCredit(db, user, reason, ref, amount, date, expires) {
  const saved = (
    await db.query(
      `INSERT INTO coin_ledger(user_id,delta,reason,ref_id,local_date,expires_at)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,
      [user, amount, reason, String(ref), date, expires]
    )
  ).rows[0];
  if (!saved) return null;
  await db.query(
    'INSERT INTO coin_lots(ledger_id,user_id,remaining,expires_at) VALUES($1,$2,$3,$4)',
    [saved.id, user, amount, expires]
  );
  await db.query('UPDATE coin_balances SET balance=balance+$2,updated_at=NOW() WHERE user_id=$1', [
    user,
    amount,
  ]);
  return saved;
}
async function expireLocked(db, user) {
  const lots = (
    await db.query(
      'SELECT * FROM coin_lots WHERE user_id=$1 AND remaining>0 AND expires_at<=NOW() FOR UPDATE',
      [user]
    )
  ).rows;
  for (const lot of lots) {
    const inserted = await db.query(
      `INSERT INTO coin_ledger(user_id,delta,reason,ref_id,local_date)
   VALUES($1,$2,'EXPIRE',$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) ON CONFLICT DO NOTHING RETURNING id`,
      [user, -lot.remaining, String(lot.ledger_id)]
    );
    if (inserted.rowCount) {
      await db.query(
        'UPDATE coin_balances SET balance=balance-$2,updated_at=NOW() WHERE user_id=$1',
        [user, lot.remaining]
      );
      await db.query('UPDATE coin_lots SET remaining=0 WHERE ledger_id=$1', [lot.ledger_id]);
    }
  }
}
async function award(db, user, reason, ref, date, issuedAt = new Date()) {
  if (!(await c.config(db, user)).coins) return null;
  await c.balanceLock(db, user);
  await expireLocked(db, user);
  const rule = (await db.query('SELECT * FROM coin_rules WHERE task_code=$1 AND active', [reason]))
    .rows[0];
  if (!rule) return null;
  const existing = await db.query(
    'SELECT 1 FROM coin_ledger WHERE user_id=$1 AND reason=$2 AND ref_id=$3',
    [user, reason, String(ref)]
  );
  if (existing.rowCount) return null;
  const limit = reason === 'WEEKLY' ? rule.weekly_limit : rule.daily_limit;
  const count = (
    await db.query(
      `SELECT count(*)::int n FROM coin_ledger WHERE user_id=$1 AND reason=$2 AND delta>0
 AND ${reason === 'WEEKLY' ? "date_trunc('week',local_date::timestamp)=date_trunc('week',$3::date::timestamp)" : 'local_date=$3::date'}`,
      [user, reason, date]
    )
  ).rows[0].n;
  if (count >= limit) return null;
  // The original event time determines expiry; delayed workers cannot extend it.
  const expires = (
    await db.query("SELECT $1::timestamptz+INTERVAL '12 months' expires", [issuedAt])
  ).rows[0].expires;
  const row = await addCredit(db, user, reason, ref, rule.coins, date, expires);
  return row;
}
async function processEvents(pool, limit = 100, onlyUser = null) {
  const pending = (
    await pool.query(
      "SELECT id FROM coin_event_outbox WHERE completed_at IS NULL AND v21_allowed(user_id,'coins') AND($2::integer IS NULL OR user_id=$2) ORDER BY id LIMIT $1",
      [limit, onlyUser]
    )
  ).rows;
  for (const event of pending)
    await c.transaction(pool, async (db) => {
      const e = (
        await db.query(
          'SELECT *,local_date::text calendar_date FROM coin_event_outbox WHERE id=$1 AND completed_at IS NULL FOR UPDATE SKIP LOCKED',
          [event.id]
        )
      ).rows[0];
      if (!e) return;
      await award(db, e.user_id, e.reason, e.ref_id, e.calendar_date, e.created_at);
      if (e.reason === 'CHECKIN') {
        const date = e.calendar_date;
        const week = (
          await db.query(
            `SELECT date_trunc('week',$2::date::timestamp)::date::text start,
    count(DISTINCT local_date)::int n FROM coin_event_outbox WHERE user_id=$1 AND reason='CHECKIN'
    AND date_trunc('week',local_date::timestamp)=date_trunc('week',$2::date::timestamp)`,
            [e.user_id, date]
          )
        ).rows[0];
        if (week.n >= 5) await award(db, e.user_id, 'WEEKLY', week.start, date, e.created_at);
      }
      await db.query('UPDATE coin_event_outbox SET completed_at=NOW() WHERE id=$1', [e.id]);
    });
  return pending.length;
}
async function today(pool, user) {
  await c.assertFeature(pool, user, 'coins');
  await processEvents(pool, 30, user);
  return c.transaction(pool, async (db) => {
    await c.balanceLock(db, user);
    await expireLocked(db, user);
    const balance = (await db.query('SELECT balance FROM coin_balances WHERE user_id=$1', [user]))
      .rows[0].balance;
    const tasks = (
      await db.query(
        `SELECT r.*,COALESCE(n.n,0)::int done FROM coin_rules r LEFT JOIN
   (SELECT reason,count(*) n FROM coin_ledger WHERE user_id=$1 AND delta>0 AND
    ((reason<>'WEEKLY' AND local_date=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
      OR(reason='WEEKLY' AND date_trunc('week',local_date::timestamp)=date_trunc('week',(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')))) GROUP BY reason) n
    ON n.reason=r.task_code WHERE r.active ORDER BY array_position(ARRAY['CHECKIN','MED_ANSWER','VITAL','GIFT_OPEN','WEEKLY'],r.task_code)`,
        [user]
      )
    ).rows;
    return {
      balance,
      tasks,
      serverDate: c.localDate(),
      weeklyDays: (
        await db.query(
          `SELECT count(DISTINCT session_date)::int n FROM health_checkins
   WHERE user_id=$1 AND session_date>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND last_response_at IS NOT NULL`,
          [user]
        )
      ).rows[0].n,
    };
  });
}
async function history(pool, user, before) {
  await c.assertFeature(pool, user, 'coins');
  const cursor = before == null || before === '' ? null : c.idSchema.parse(before);
  return {
    items: (
      await pool.query(
        'SELECT l.*,r.status reward_status,t.ticket_no FROM coin_ledger l LEFT JOIN reward_redemptions r ON r.ledger_id=l.id LEFT JOIN draw_tickets t ON t.redemption_id=r.id WHERE l.user_id=$1 AND ($2::bigint IS NULL OR l.id<$2) ORDER BY l.id DESC LIMIT 30',
        [user, cursor]
      )
    ).rows,
  };
}
async function catalog(db, user) {
  await c.assertFeature(db, user, 'coins');
  const connected = !!(
    await db.query(
      "SELECT 1 FROM user_connections WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1) LIMIT 1",
      [user]
    )
  ).rowCount;
  const templates = (
    await db.query(
      'SELECT code,title,title_en FROM greeting_templates WHERE active AND approved_at IS NOT NULL ORDER BY code'
    )
  ).rows;
  const draw = (
    await db.query(`SELECT p.id FROM gift_draw_periods p CROSS JOIN gift_config g
  WHERE g.id=1 AND g.lucky_draw_enabled AND p.active AND p.locked_at IS NULL AND p.starts_at<=NOW() AND p.closes_at>NOW() LIMIT 1`)
  ).rows[0];
  const items = (
    await db.query('SELECT * FROM reward_catalog WHERE active ORDER BY cost')
  ).rows.filter((r) =>
    r.code === 'GREETING_CARD'
      ? connected && templates.length
      : r.code === 'DRAW_TICKET'
        ? !!draw
        : false
  );
  const recipients = connected
    ? (
        await db.query(
          `SELECT u.id,COALESCE(u.full_name,u.display_name) name FROM user_connections c JOIN users u
  ON u.id=CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END AND u.deleted_at IS NULL
  WHERE c.status='accepted' AND (c.requester_id=$1 OR c.addressee_id=$1) ORDER BY u.id`,
          [user]
        )
      ).rows
    : [];
  return { items, templates, recipients, drawPeriodId: draw ? String(draw.id) : null };
}
const redemptionSchema = c.z
  .object({
    request_id: c.uuid,
    payload: c.z
      .object({ recipientId: c.idSchema.optional(), templateCode: c.z.string().max(40).optional() })
      .strict()
      .default({}),
  })
  .strict();
async function redeem(pool, user, code, body) {
  const input = redemptionSchema.parse(body);
  await c.assertFeature(pool, user, 'coins');
  return c.transaction(pool, async (db) => {
    const old = (
      await db.query('SELECT * FROM reward_redemptions WHERE user_id=$1 AND request_id=$2', [
        user,
        input.request_id,
      ])
    ).rows[0];
    if (old) {
      if (
        old.catalog_code !== code ||
        !require('node:util').isDeepStrictEqual(old.payload, input.payload)
      )
        throw c.error('COIN_REQUEST_CHANGED', 409);
      return { redemption: old };
    }
    await c.balanceLock(db, user);
    await expireLocked(db, user);
    // The user lock also serializes a retry whose first request just committed.
    const raced = (
      await db.query('SELECT * FROM reward_redemptions WHERE user_id=$1 AND request_id=$2', [
        user,
        input.request_id,
      ])
    ).rows[0];
    if (raced) {
      if (
        raced.catalog_code !== code ||
        !require('node:util').isDeepStrictEqual(raced.payload, input.payload)
      )
        throw c.error('COIN_REQUEST_CHANGED', 409);
      return { redemption: raced };
    }
    const item = (
      await db.query('SELECT * FROM reward_catalog WHERE code=$1 AND active FOR SHARE', [code])
    ).rows[0];
    if (!item) throw c.error('COIN_REWARD_UNAVAILABLE', 404);
    let period, household;
    if (code === 'GREETING_CARD') {
      if (
        !input.payload.recipientId ||
        !input.payload.templateCode ||
        !(await c.hasConnection(db, user, input.payload.recipientId))
      )
        throw c.error('COIN_RECIPIENT_UNAVAILABLE', 409);
      if (
        !(
          await db.query(
            'SELECT 1 FROM greeting_templates WHERE code=$1 AND active AND approved_at IS NOT NULL',
            [input.payload.templateCode]
          )
        ).rowCount
      )
        throw c.error('COIN_TEMPLATE_UNAVAILABLE', 409);
    } else if (code === 'DRAW_TICKET') {
      const flag = (
        await db.query('SELECT lucky_draw_enabled FROM gift_config WHERE id=1 FOR SHARE')
      ).rows[0];
      if (!flag?.lucky_draw_enabled) throw c.error('COIN_DRAW_CLOSED', 409);
      period = (
        await db.query(`SELECT * FROM gift_draw_periods WHERE active AND locked_at IS NULL AND starts_at<=NOW() AND closes_at>NOW()
    ORDER BY closes_at LIMIT 1 FOR SHARE`)
      ).rows[0];
      if (!period) throw c.error('COIN_DRAW_CLOSED', 409);
      household =
        (await entitlement.householdProtecting(db, user)) ||
        (await entitlement.ensureHousehold(db, user));
    } else throw c.error('COIN_REWARD_UNAVAILABLE', 404);
    const usage = (
      await db.query(
        `SELECT count(*) FILTER(WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int today,
   count(*) FILTER(WHERE date_trunc('month',created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')=date_trunc('month',NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int month_count
   FROM reward_redemptions WHERE user_id=$1 AND catalog_code=$2 AND status<>'REFUNDED'`,
        [user, code]
      )
    ).rows[0];
    if (
      (item.daily_limit && usage.today >= item.daily_limit) ||
      (item.monthly_limit && usage.month_count >= item.monthly_limit)
    )
      throw c.error('COIN_REWARD_LIMIT', 409);
    const balance = (await db.query('SELECT balance FROM coin_balances WHERE user_id=$1', [user]))
      .rows[0].balance;
    if (balance < item.cost) throw c.error('COIN_INSUFFICIENT', 409);
    const id = c.randomUUID();
    await db.query(
      `INSERT INTO reward_redemptions(id,user_id,catalog_code,cost,request_id,payload,status)
   VALUES($1,$2,$3,$4,$5,$6,'PENDING')`,
      [id, user, code, item.cost, input.request_id, JSON.stringify(input.payload)]
    );
    const ledger = (
      await db.query(
        `INSERT INTO coin_ledger(user_id,delta,reason,ref_id,local_date)
   VALUES($1,$2,'REDEEM',$3,(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) RETURNING id`,
        [user, -item.cost, id]
      )
    ).rows[0];
    let remaining = item.cost;
    const lots = (
      await db.query(
        'SELECT * FROM coin_lots WHERE user_id=$1 AND remaining>0 AND expires_at>NOW() ORDER BY expires_at,ledger_id FOR UPDATE',
        [user]
      )
    ).rows;
    for (const lot of lots) {
      if (!remaining) break;
      const amount = Math.min(remaining, lot.remaining);
      remaining -= amount;
      await db.query('UPDATE coin_lots SET remaining=remaining-$2 WHERE ledger_id=$1', [
        lot.ledger_id,
        amount,
      ]);
      await db.query(
        'INSERT INTO coin_redemption_allocations(redemption_id,lot_id,amount) VALUES($1,$2,$3)',
        [id, lot.ledger_id, amount]
      );
    }
    if (remaining) throw c.error('COIN_BALANCE_INCONSISTENT', 503);
    await db.query(
      'UPDATE coin_balances SET balance=balance-$2,updated_at=NOW() WHERE user_id=$1',
      [user, item.cost]
    );
    await db.query('UPDATE reward_redemptions SET ledger_id=$2 WHERE id=$1', [id, ledger.id]);
    if (period) {
      await db.query(
        `INSERT INTO draw_tickets(household_id,draw_period,user_id,source,redemption_id) VALUES($1,$2,$3,'coin',$4)`,
        [household.id, period.id, user, id]
      );
      await db.query(
        "UPDATE reward_redemptions SET status='DELIVERED',delivered_at=NOW() WHERE id=$1",
        [id]
      );
    } else
      await c.message(db, {
        key: 'coin.card:' + id,
        subject: user,
        recipient: input.payload.recipientId,
        kind: 'coin_card',
        payload: { redemptionId: id, templateCode: input.payload.templateCode },
      });
    return {
      redemption: (await db.query('SELECT * FROM reward_redemptions WHERE id=$1', [id])).rows[0],
      balance: balance - item.cost,
    };
  });
}
async function refund(pool, id) {
  return c.transaction(pool, async (db) => {
    // The consistent order is balance -> redemption -> lots, also used by redeem.
    const subject = (await db.query('SELECT user_id FROM reward_redemptions WHERE id=$1', [id]))
      .rows[0];
    if (!subject) return;
    await c.balanceLock(db, subject.user_id);
    const r = (await db.query('SELECT * FROM reward_redemptions WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!r || r.status !== 'PENDING') return;
    const allocations = (
      await db.query(
        'SELECT a.*,l.expires_at FROM coin_redemption_allocations a JOIN coin_lots l ON l.ledger_id=a.lot_id WHERE a.redemption_id=$1',
        [id]
      )
    ).rows;
    for (const lot of allocations)
      await addCredit(
        db,
        r.user_id,
        'REFUND',
        r.id + ':' + lot.lot_id,
        lot.amount,
        c.localDate(),
        lot.expires_at
      );
    await db.query("UPDATE reward_redemptions SET status='REFUNDED' WHERE id=$1", [id]);
    await expireLocked(db, r.user_id);
    await c.message(db, {
      key: 'coin.refund:' + id,
      subject: r.user_id,
      recipient: r.user_id,
      kind: 'coin_refund',
    });
  });
}
async function daily(pool) {
  const users = (
    await pool.query('SELECT user_id FROM coin_lots WHERE remaining>0 GROUP BY user_id')
  ).rows;
  for (const { user_id: user } of users)
    await c.transaction(pool, async (db) => {
      await c.balanceLock(db, user);
      await expireLocked(db, user);
      const lots = (
        await db.query(
          "SELECT * FROM coin_lots WHERE user_id=$1 AND remaining>0 AND expires_at>NOW() AND expires_at<=NOW()+INTERVAL '7 days' AND reminded_at IS NULL FOR UPDATE",
          [user]
        )
      ).rows;
      for (const lot of lots) {
        await c.message(db, {
          key: 'coin.expiry:' + lot.ledger_id,
          subject: user,
          recipient: user,
          kind: 'coin_expiring',
          payload: { coins: lot.remaining },
        });
        await db.query('UPDATE coin_lots SET reminded_at=NOW() WHERE ledger_id=$1', [
          lot.ledger_id,
        ]);
      }
    });
}
module.exports = {
  award,
  processEvents,
  today,
  history,
  catalog,
  redeem,
  refund,
  daily,
  expireLocked,
};
