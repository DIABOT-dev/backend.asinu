'use strict';

const { randomInt, randomUUID } = require('node:crypto');
const entitlement = require('../payment/entitlement.service');
const { selectExtra, selectLoc, SCALE } = require('./gift-policy');
const { enqueueCrmEvent } = require('../integrations/crm-event.service');
const logger = require('../../lib/logger');
const DAY_SQL = "(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const calendarDate = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value);

function giftError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
async function transaction(pool, work) {
  const owns = typeof pool.connect === 'function' && typeof pool.release !== 'function';
  const nested = !owns && typeof pool.release === 'function';
  const db = owns ? await pool.connect() : pool;
  try {
    if (owns) await db.query('BEGIN');
    if (nested) await db.query('SAVEPOINT optional_checkin_gift');
    const result = await work(db);
    if (owns) await db.query('COMMIT');
    if (nested) await db.query('RELEASE SAVEPOINT optional_checkin_gift');
    return result;
  } catch (error) {
    if (owns) await db.query('ROLLBACK');
    if (nested) {
      await db.query('ROLLBACK TO SAVEPOINT optional_checkin_gift');
      await db.query('RELEASE SAVEPOINT optional_checkin_gift');
    }
    throw error;
  } finally {
    if (owns) db.release();
  }
}
async function householdFor(db, userId) {
  return (
    (await entitlement.householdProtecting(db, userId)) ||
    (await entitlement.ensureHousehold(db, userId))
  );
}
async function configFor(db) {
  return (await db.query('SELECT * FROM gift_config WHERE id = 1')).rows[0] || null;
}

/** Idempotent under retries, concurrent family members, devices and workers. */
async function assign(pool, userId, session) {
  if (!session?.id || Number(session.user_id) !== Number(userId)) return null;
  return transaction(pool, async (db) => {
    const config = await configFor(db);
    if (!config?.enabled) return null;
    const household = await householdFor(db, userId);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('gift-household:' || $1::text))", [
      household.id,
    ]);
    // The per-user constraint also prevents moving between households to draw again.
    const existing = await db.query(
      `SELECT * FROM gift_events WHERE (household_id = $1 OR user_id = $2) AND date_vn = ${DAY_SQL}`,
      [household.id, userId]
    );
    if (existing.rows[0]) return existing.rows[0];
    const eligible = await db.query(
      `SELECT l.* FROM loc_items l
       WHERE l.active AND (l.type <> 'health_tip' OR (l.reviewed_at IS NOT NULL AND l.reviewed_by IS NOT NULL))
         AND (cardinality(l.conditions) = 0 OR l.conditions && ARRAY(
           SELECT jsonb_array_elements_text(COALESCE(p.medical_conditions,'[]'::jsonb))
           FROM user_onboarding_profiles p WHERE p.user_id = $2))
         AND NOT EXISTS (SELECT 1 FROM gift_events g WHERE (g.household_id = $1 OR g.user_id = $2) AND g.loc_id = l.id AND g.date_vn >= ${DAY_SQL} - 29)
       ORDER BY l.id`,
      [household.id, userId]
    );
    // An exhausted/empty catalog must never silently repeat a recent fortune.
    if (!eligible.rows.length) return null;
    const loc = selectLoc(eligible.rows);
    const period = config.lucky_draw_enabled
      ? (
          await db.query(
            `SELECT * FROM gift_draw_periods WHERE active AND locked_at IS NULL
       AND starts_at <= NOW() AND closes_at > NOW()
       AND date_trunc('month', starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND date_trunc('month', draw_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')
       ORDER BY starts_at DESC LIMIT 1 FOR SHARE`
          )
        ).rows[0]
      : null;
    const randomValue = randomInt(SCALE);
    // Coupon capability is intentionally off for V2. Enabling it requires the
    // store-backed issuer; no fake discount or wallet credit can be awarded.
    const extra = selectExtra(config, { ticket: Boolean(period), coupon: false }, randomValue);
    const id = randomUUID();
    const saved = await db.query(
      `INSERT INTO gift_events (id, household_id, user_id, checkin_id, date_vn, loc_id, loc_snapshot, extra, answer, random_value, config_snapshot)
       VALUES ($1,$2,$3,$4,${DAY_SQL},$5,$6::jsonb,$7,$8,$9,$10::jsonb)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        id,
        household.id,
        userId,
        session.id,
        loc.id,
        JSON.stringify({ type: loc.type, text: loc.text, text_en: loc.text_en, serif: loc.serif }),
        extra,
        session.current_status,
        randomValue,
        JSON.stringify(config),
      ]
    );
    if (!saved.rows[0])
      return (
        (
          await db.query(`SELECT * FROM gift_events WHERE user_id=$1 AND date_vn=${DAY_SQL}`, [
            userId,
          ])
        ).rows[0] || null
      );
    if (extra === 'ticket') {
      const ticket = (
        await db.query(
          'INSERT INTO draw_tickets (household_id, draw_period, gift_event_id) VALUES ($1,$2,$3) RETURNING ticket_no',
          [household.id, period.id, id]
        )
      ).rows[0];
      await enqueueCrmEvent(
        db,
        'ticket.issued',
        {
          user_id: String(userId),
          household_id: String(household.id),
          gift_event_id: id,
          ticket_no: ticket.ticket_no,
          draw_period: period.code,
        },
        { event_id: `ticket.issued:${id}` }
      );
    }
    return saved.rows[0];
  });
}

// Health saves and safety alerts are authoritative; a gift subsystem outage
// must not turn a successfully saved check-in into an error/retry loop.
async function safeAssign(pool, userId, session) {
  try {
    return await assign(pool, userId, session);
  } catch (error) {
    logger.warn('gift.assignment_failed', { code: error.code });
    return null;
  }
}

async function publicGift(db, gift, lang = 'vi') {
  if (!gift) return null;
  const opened = Boolean(gift.opened_at);
  const loc = gift.loc_snapshot;
  let ticket = null;
  if (opened && gift.extra === 'ticket') {
    const config = await configFor(db);
    if (config?.lucky_draw_enabled) {
      const row = (
        await db.query(
          `SELECT t.ticket_no, p.id, p.code, p.prize_name, p.draw_at FROM draw_tickets t
         JOIN gift_draw_periods p ON p.id=t.draw_period WHERE t.gift_event_id=$1`,
          [gift.id]
        )
      ).rows[0];
      if (row)
        ticket = {
          number: row.ticket_no,
          periodId: String(row.id),
          period: row.code,
          prize: row.prize_name,
          drawAt: row.draw_at,
        };
    }
  }
  return {
    id: gift.id,
    day: calendarDate(gift.date_vn),
    openedAt: gift.opened_at,
    box: gift.selected_box,
    loc: opened
      ? {
          type: loc.type,
          text: lang.startsWith('en') ? loc.text_en || loc.text : loc.text,
          serif: loc.serif,
        }
      : null,
    extra: opened ? (gift.extra === 'ticket' && !ticket ? 'none' : gift.extra) : null,
    ticket,
  };
}

async function today(pool, userId, lang) {
  const config = await configFor(pool);
  if (!config?.enabled) return { enabled: false, gift: null, streak: 0, week: [] };
  const session = // Health monitoring has a 05:00 day boundary. Gifts still reset at 00:00 VN:
    // a response after midnight can belong to yesterday's monitoring session.
    (
      await pool.query(
        `SELECT * FROM health_checkins WHERE user_id=$1 AND
      (session_date=${DAY_SQL} OR (last_response_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=${DAY_SQL})
      ORDER BY last_response_at DESC NULLS LAST LIMIT 1`,
        [userId]
      )
    ).rows[0];
  // Repairs a crash between the accepted check-in/call response and assignment.
  if (session) await safeAssign(pool, userId, session);
  const household = await householdFor(pool, userId);
  const row = (
    await pool.query(
      `SELECT * FROM gift_events WHERE (household_id=$1 OR user_id=$2) AND date_vn=${DAY_SQL}`,
      [household.id, userId]
    )
  ).rows[0];
  const calendar = (await pool.query(`SELECT ${DAY_SQL}::text AS today`)).rows[0].today;
  const history = (
    await pool.query(
      `SELECT date_vn::text AS day FROM gift_events WHERE household_id=$1 OR user_id=$2
       UNION SELECT COALESCE((last_response_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,session_date)::text AS day
       FROM health_checkins WHERE user_id=$2 AND last_response_at IS NOT NULL ORDER BY day DESC`,
      [household.id, userId]
    )
  ).rows.map((x) => x.day);
  const days = new Set(history);
  const shift = (date, n) =>
    new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let cursor = days.has(calendar) ? calendar : shift(calendar, -1),
    streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = shift(cursor, -1);
  }
  const monday = shift(calendar, -((new Date(calendar + 'T00:00:00Z').getUTCDay() + 6) % 7));
  return {
    enabled: true,
    gift: await publicGift(pool, row, lang),
    offerOnAppOpen: Boolean(row && !row.opened_at && session?.occurrence_source === 'checkin_call'),
    checkinStatus: session?.current_status || null,
    familyAlerted: session?.family_alerted === true,
    streak,
    week: Array.from({ length: 7 }, (_, i) => ({
      day: shift(monday, i),
      checked: days.has(shift(monday, i)),
    })),
  };
}

async function open(pool, userId, giftId, box, lang) {
  if (
    typeof giftId !== 'string' ||
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(giftId) ||
    !Number.isInteger(box) ||
    box < 0 ||
    box > 5
  )
    throw giftError('INVALID_GIFT_REQUEST');
  const result = await transaction(pool, async (db) => {
    const config = await configFor(db);
    if (!config?.enabled) throw giftError('GIFTS_DISABLED', 404);
    const household = await householdFor(db, userId);
    const row = (
      await db.query(
        'SELECT * FROM gift_events WHERE id=$1 AND (household_id=$2 OR user_id=$3) FOR UPDATE',
        [giftId, household.id, userId]
      )
    ).rows[0];
    if (!row) throw giftError('GIFT_NOT_FOUND', 404);
    if (row.opened_at) return row;
    const valid = (
      await db.query(`SELECT 1 FROM gift_events WHERE id=$1 AND date_vn=${DAY_SQL}`, [giftId])
    ).rowCount;
    if (!valid) throw giftError('GIFT_DAY_ENDED', 409);
    const updated = (
      await db.query(
        'UPDATE gift_events SET opened_at=NOW(),opened_by=$2,selected_box=$3 WHERE id=$1 RETURNING *',
        [giftId, userId, box]
      )
    ).rows[0];
    await db.query(
      `INSERT INTO gift_family_outbox (gift_event_id,recipient_id)
       SELECT $1, CASE WHEN c.requester_id=$2 THEN c.addressee_id ELSE c.requester_id END FROM user_connections c
       WHERE (c.requester_id=$2 OR c.addressee_id=$2) AND c.status='accepted'
         AND COALESCE((c.permissions->>'can_receive_alerts')::boolean,FALSE) ON CONFLICT DO NOTHING`,
      [giftId, row.user_id]
    );
    await enqueueCrmEvent(
      db,
      'gift.opened',
      {
        user_id: String(row.user_id),
        household_id: String(row.household_id),
        gift_event_id: giftId,
        loc_id: String(row.loc_id),
        extra: row.extra,
        answer: row.answer,
        date_vn: calendarDate(row.date_vn),
      },
      { event_id: `gift.opened:${giftId}` }
    );
    return updated;
  });
  return publicGift(pool, result, lang);
}

async function history(pool, userId, before, lang) {
  if (
    before &&
    (typeof before !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(before) ||
      !Number.isFinite(Date.parse(before)) ||
      new Date(before).toISOString().slice(0, 10) !== before)
  )
    throw giftError('INVALID_DATE');
  const household = await householdFor(pool, userId);
  const rows = (
    await pool.query(
      'SELECT * FROM gift_events WHERE (household_id=$1 OR user_id=$3) AND opened_at IS NOT NULL AND ($2::date IS NULL OR date_vn < $2::date) ORDER BY date_vn DESC LIMIT 30',
      [household.id, before || null, userId]
    )
  ).rows;
  return {
    items: await Promise.all(rows.map((row) => publicGift(pool, row, lang))),
    nextBefore: rows.length === 30 ? calendarDate(rows.at(-1).date_vn) : null,
  };
}

async function deliverFamilyEvents(pool) {
  const config = await configFor(pool);
  if (!config?.enabled) return;
  const pending = (
    await pool.query(
      `SELECT o.*,g.user_id,g.extra,g.loc_snapshot,g.opened_at,COALESCE(u.language_preference,'vi') AS lang FROM gift_family_outbox o
     JOIN gift_events g ON g.id=o.gift_event_id JOIN users u ON u.id=o.recipient_id
     WHERE o.notification_id IS NULL AND o.cancelled_at IS NULL ORDER BY g.opened_at LIMIT 30`
    )
  ).rows;
  const {
    reserveNotification,
    deliverNotification,
  } = require('../notification/notification-dispatch.service');
  for (const event of pending) {
    const connected = (
      await pool.query(
        `SELECT 1 FROM user_connections WHERE status='accepted'
      AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
      AND COALESCE((permissions->>'can_receive_alerts')::boolean,FALSE)`,
        [event.user_id, event.recipient_id]
      )
    ).rowCount;
    if (!connected || Date.now() - new Date(event.opened_at).getTime() > 86400000) {
      await pool.query(
        'UPDATE gift_family_outbox SET cancelled_at=NOW() WHERE gift_event_id=$1 AND recipient_id=$2',
        [event.gift_event_id, event.recipient_id]
      );
      continue;
    }
    const english = String(event.lang || 'vi').startsWith('en');
    const kind =
      event.loc_snapshot.type === 'proverb'
        ? english
          ? 'a proverb'
          : 'một câu ca dao, tục ngữ'
        : event.loc_snapshot.type === 'health_tip'
          ? english
            ? 'a health tip'
            : 'một mẹo sức khỏe'
          : english
            ? 'a warm wish'
            : 'một lời chúc';
    const body = english
      ? `Your loved one opened today's gift: ${kind}${config.lucky_draw_enabled && event.extra === 'ticket' ? ', plus a draw ticket' : ''}.`
      : `Người thân vừa mở hộp quà: ${kind}${config.lucky_draw_enabled && event.extra === 'ticket' ? ', kèm phiếu bốc thăm' : ''}.`;
    const saved = await reserveNotification(pool, {
      userId: event.recipient_id,
      type: 'gift_opened',
      title: english ? 'A little joy today' : 'Niềm vui nhỏ hôm nay',
      body,
      data: {
        eventId: `gift.opened:${event.gift_event_id}`,
        giftId: event.gift_event_id,
        sourceUserId: event.user_id,
        screen: '/checkin-rewards/history',
      },
      cooldownMinutes: 1440,
      priority: 'low',
    });
    if (saved) {
      await pool.query(
        'UPDATE gift_family_outbox SET notification_id=$3 WHERE gift_event_id=$1 AND recipient_id=$2 AND notification_id IS NULL',
        [event.gift_event_id, event.recipient_id, saved.notificationId]
      );
      await deliverNotification(pool, saved.notificationId);
    }
  }
}

async function rules(pool, periodId, lang) {
  const result = await pool.query(
    `SELECT p.code,p.prize_name,p.draw_at,p.rules FROM gift_draw_periods p
    CROSS JOIN gift_config c WHERE c.id=1 AND c.lucky_draw_enabled AND p.id=$1`,
    [periodId]
  );
  if (!result.rows[0]) throw giftError('DRAW_DISABLED', 404);
  const row = result.rows[0];
  return {
    period: row.code,
    prize: row.prize_name,
    drawAt: row.draw_at,
    rules: row.rules[lang.startsWith('en') ? 'en' : 'vi'],
  };
}
async function receipt(pool, userId, giftId, lang) {
  if (typeof giftId !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(giftId))
    throw giftError('INVALID_GIFT_REQUEST');
  const gift = (
    await pool.query(
      `SELECT g.* FROM gift_events g JOIN users u ON u.id=g.user_id AND u.deleted_at IS NULL
    WHERE g.id=$1 AND g.opened_at IS NOT NULL AND (g.user_id=$2
      OR EXISTS (SELECT 1 FROM subscription_households h WHERE h.id=g.household_id AND h.owner_user_id=$2)
      OR EXISTS (SELECT 1 FROM subscription_household_members m WHERE m.household_id=g.household_id AND m.user_id=$2 AND m.status='active')
      OR EXISTS (SELECT 1 FROM user_connections c WHERE c.status='accepted'
        AND ((c.requester_id=$2 AND c.addressee_id=g.user_id) OR (c.addressee_id=$2 AND c.requester_id=g.user_id))
        AND COALESCE((c.permissions->>'can_receive_alerts')::boolean,FALSE)))`,
      [giftId, userId]
    )
  ).rows[0];
  if (!gift) throw giftError('GIFT_NOT_FOUND', 404);
  return { gift: await publicGift(pool, gift, lang) };
}
module.exports = {
  assign,
  safeAssign,
  publicGift,
  today,
  open,
  history,
  deliverFamilyEvents,
  householdFor,
  giftError,
  rules,
  receipt,
};
