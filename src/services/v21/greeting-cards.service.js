'use strict';

const c = require('./common');

function snapshot(template) {
  return Object.fromEntries(
    ['code', 'title', 'title_en', 'body', 'body_en'].map((key) => [key, template[key]])
  );
}

async function canDeliver(db, notification) {
  const data = notification.data || {};
  if (!c.uuid.safeParse(data.redemptionId).success) return false;
  const row = (
    await db.query(
      "SELECT user_id,payload,status FROM reward_redemptions WHERE id=$1 AND catalog_code='GREETING_CARD'",
      [data.redemptionId]
    )
  ).rows[0];
  return Boolean(
    row &&
    row.status !== 'REFUNDED' &&
    String(row.user_id) === String(data.patientId) &&
    String(row.payload.recipientId) === String(notification.user_id) &&
    (await c.hasConnection(db, row.user_id, notification.user_id))
  );
}

async function read(pool, actor, id) {
  c.uuid.parse(id);
  const row = (
    await pool.query(
      `SELECT r.*,COALESCE(u.full_name,u.display_name) sender_name
       FROM reward_redemptions r JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL
       WHERE r.id=$1 AND r.catalog_code='GREETING_CARD'`,
      [id]
    )
  ).rows[0];
  if (!row) throw c.error('COIN_CARD_UNAVAILABLE', 404);
  const isSender = String(row.user_id) === String(actor);
  const isRecipient = String(row.payload.recipientId) === String(actor);
  if (
    !isSender &&
    (!isRecipient ||
      row.status === 'REFUNDED' ||
      !(await c.hasConnection(pool, row.user_id, actor)))
  )
    throw c.error('COIN_CARD_UNAVAILABLE', 404);
  const template =
    row.payload.card ||
    (
      await pool.query(
        'SELECT code,title,title_en,body,body_en FROM greeting_templates WHERE code=$1',
        [row.payload.templateCode]
      )
    ).rows[0];
  if (!template) throw c.error('COIN_CARD_UNAVAILABLE', 404);
  return {
    card: {
      id: row.id,
      template: snapshot(template),
      senderName: row.sender_name || '',
      createdAt: row.created_at,
      status: row.status,
      isSender,
      isRecipient,
    },
  };
}

async function open(pool, actor, id) {
  c.uuid.parse(id);
  return c.transaction(pool, async (db) => {
    const row = (
      await db.query(
        "SELECT * FROM reward_redemptions WHERE id=$1 AND catalog_code='GREETING_CARD' FOR UPDATE",
        [id]
      )
    ).rows[0];
    // The sender can preview their own card without claiming that it arrived.
    if (row && String(row.user_id) === String(actor))
      return { received: false, ...(await read(db, actor, id)) };
    if (
      !row ||
      String(row.payload.recipientId) !== String(actor) ||
      row.status === 'REFUNDED' ||
      !(await c.hasConnection(db, row.user_id, actor))
    )
      throw c.error('COIN_CARD_UNAVAILABLE', 404);
    await db.query(
      "UPDATE reward_redemptions SET status='DELIVERED',delivered_at=COALESCE(delivered_at,NOW()) WHERE id=$1 AND status='PENDING'",
      [id]
    );
    await db.query(
      `UPDATE notification_push_outbox o SET state='CANCELLED',updated_at=NOW()
       FROM notifications n WHERE n.id=o.notification_id AND n.type='coin_card'
        AND n.data->>'redemptionId'=$1 AND o.state IN('PENDING','RETRY')`,
      [id]
    );
    return { received: true, ...(await read(db, actor, id)) };
  });
}

module.exports = { snapshot, canDeliver, read, open };
