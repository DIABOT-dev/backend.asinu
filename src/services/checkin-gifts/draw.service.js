'use strict';
const { giftError } = require('./gift.service');

async function publish(pool, periodId, ticketNumbers) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const config = (await db.query('SELECT lucky_draw_enabled FROM gift_config WHERE id=1'))
      .rows[0];
    if (!config?.lucky_draw_enabled) throw giftError('DRAW_DISABLED', 404);
    const period = (
      await db.query(
        'SELECT * FROM gift_draw_periods WHERE id=$1 AND locked_at IS NOT NULL AND draw_at <= NOW() FOR UPDATE',
        [periodId]
      )
    ).rows[0];
    if (!period) throw giftError('DRAW_NOT_READY', 409);
    const published = (
      await db.query('SELECT ticket_no FROM gift_draw_results WHERE draw_period=$1', [periodId])
    ).rows;
    if (
      published.length &&
      (published.length !== new Set(ticketNumbers).size ||
        published.some((row) => !ticketNumbers.includes(row.ticket_no)))
    )
      throw giftError('DRAW_ALREADY_PUBLISHED', 409);
    const tickets = (
      await db.query(
        'SELECT * FROM draw_tickets WHERE draw_period=$1 AND ticket_no=ANY($2::text[])',
        [periodId, ticketNumbers]
      )
    ).rows;
    if (tickets.length !== new Set(ticketNumbers).size) throw giftError('INVALID_DRAW_TICKET');
    for (const ticket of tickets) {
      await db.query(
        'INSERT INTO gift_draw_results (draw_period,ticket_no,household_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [periodId, ticket.ticket_no, ticket.household_id]
      );
      await db.query(
        `INSERT INTO gift_draw_result_outbox (draw_period,ticket_no,recipient_id)
        SELECT $1::bigint,$2::text,owner_user_id FROM subscription_households WHERE id=$3
        UNION SELECT $1::bigint,$2::text,user_id FROM gift_events WHERE id=$4
        UNION SELECT $1::bigint,$2::text,$5::integer WHERE $5::integer IS NOT NULL ON CONFLICT DO NOTHING`,
        [periodId, ticket.ticket_no, ticket.household_id, ticket.gift_event_id, ticket.user_id || null]
      );
    }
    await db.query('COMMIT');
    return { published: tickets.length };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
async function results(pool, periodId) {
  const period = (
    await pool.query(
      `SELECT p.code,p.prize_name,p.draw_at FROM gift_draw_periods p
    CROSS JOIN gift_config c WHERE c.id=1 AND c.lucky_draw_enabled AND p.id=$1`,
      [periodId]
    )
  ).rows[0];
  if (!period) throw giftError('DRAW_DISABLED', 404);
  const winners = (
    await pool.query(
      'SELECT ticket_no,published_at FROM gift_draw_results WHERE draw_period=$1 ORDER BY ticket_no',
      [periodId]
    )
  ).rows;
  return { period: period.code, prize: period.prize_name, drawAt: period.draw_at, winners };
}
async function deliverResults(pool) {
  const pending = (
    await pool.query(`SELECT o.*,p.prize_name,r.published_at,COALESCE(u.language_preference,'vi') AS lang FROM gift_draw_result_outbox o
    JOIN gift_draw_results r ON r.draw_period=o.draw_period AND r.ticket_no=o.ticket_no
    JOIN gift_draw_periods p ON p.id=o.draw_period JOIN users u ON u.id=o.recipient_id AND u.deleted_at IS NULL
    CROSS JOIN gift_config c
    WHERE c.id=1 AND c.enabled AND c.lucky_draw_enabled AND o.notification_id IS NULL AND r.published_at > NOW()-INTERVAL '7 days' ORDER BY r.published_at LIMIT 30`)
  ).rows;
  const {
    reserveNotification,
    deliverNotification,
  } = require('../notification/notification-dispatch.service');
  for (const row of pending) {
    const en = String(row.lang || 'vi').startsWith('en');
    const saved = await reserveNotification(pool, {
      userId: row.recipient_id,
      type: 'gift_draw_result',
      priority: 'low',
      cooldownMinutes: 10080,
      title: en ? 'Your family won a prize' : 'Gia đình bạn đã trúng thưởng',
      body: en
        ? `Ticket ${row.ticket_no} won ${row.prize_name}. Open Asinu for the published results.`
        : `Phiếu ${row.ticket_no} đã trúng ${row.prize_name}. Mở Asinu để xem kết quả công khai.`,
      data: {
        eventId: `draw.result:${row.draw_period}:${row.ticket_no}`,
        drawPeriodId: String(row.draw_period),
        screen: `/checkin-rewards/results?period=${row.draw_period}`,
      },
    });
    if (saved) {
      await pool.query(
        'UPDATE gift_draw_result_outbox SET notification_id=$4 WHERE draw_period=$1 AND ticket_no=$2 AND recipient_id=$3',
        [row.draw_period, row.ticket_no, row.recipient_id, saved.notificationId]
      );
      await deliverNotification(pool, saved.notificationId);
    }
  }
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
function publicPage(pool) {
  return async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) {
      res.sendStatus(404);
      return;
    }
    try {
      const data = await results(pool, req.params.id);
      res
        .set('Cache-Control', 'no-cache')
        .type('html')
        .send(
          `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kết quả quay thưởng Asinu</title><style>body{font:20px/1.6 system-ui,sans-serif;color:#173b35;background:#f4fbf7;margin:0}main{max-width:640px;margin:48px auto;padding:24px}h1{font-size:32px}li{padding:12px 0;border-bottom:1px solid #c6ded5}</style><main><p>Asinu · ${escape(data.period)}</p><h1>Kết quả quay thưởng</h1><p>Giải thưởng: ${escape(data.prize)}</p><p>Ngày quay: ${escape(new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'long' }).format(new Date(data.drawAt)))}</p>${data.winners.length ? '<ul>' + data.winners.map((x) => '<li>Phiếu trúng thưởng: <strong>' + escape(x.ticket_no) + '</strong></li>').join('') + '</ul>' : '<p>Kết quả chưa được công bố.</p>'}<p>Apple không phải nhà tài trợ và không liên quan đến chương trình này.</p></main></html>`
        );
    } catch (error) {
      res.sendStatus(error.statusCode || 503);
    }
  };
}
module.exports = { publish, results, deliverResults, publicPage };
