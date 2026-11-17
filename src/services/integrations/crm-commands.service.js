'use strict';
const crypto = require('crypto');
const failure = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
async function executeCommand(pool, body) {
  if (body.action === 'snapshot') return require('./crm-snapshot.service').snapshot(pool, body);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'crm-command:' + body.command_id,
    ]);
    const prior = (
      await db.query('SELECT payload_hash,response FROM crm_command_receipts WHERE command_id=$1', [
        body.command_id,
      ])
    ).rows[0];
    if (prior) {
      if (prior.payload_hash !== hash) throw failure(409, 'CRM_COMMAND_CONFLICT');
      await db.query('COMMIT');
      return prior.response;
    }
    let result;
    if (body.action === 'reward.refund') {
      const existing = (
        await db.query('SELECT status FROM reward_redemptions WHERE id=$1', [body.resource_id])
      ).rows[0];
      if (!existing) throw failure(404, 'REWARD_NOT_FOUND');
      result = (await require('../v21/coins.service').refund(db, body.resource_id)) || {
        state: existing.status,
      };
    } else {
      const updated = await db.query(
        `UPDATE notification_push_outbox SET state='RETRY',attempts=0,lease_until=NULL,next_attempt_at=NOW(),updated_at=NOW()
        WHERE notification_id::text=$1 AND state='FAILED' AND expires_at>NOW() RETURNING notification_id`,
        [body.resource_id]
      );
      result = { queued: Boolean(updated.rowCount) };
    }
    const type =
      body.action === 'reward.refund' ? 'reward.updated' : 'notification.delivery_updated';
    const events = await db.query(
      `SELECT event_id,event_type,source,version,occurred_at,payload FROM crm_event_outbox
      WHERE event_type=$1 AND payload->>'resource_id'=$2 ORDER BY id DESC LIMIT 1`,
      [type, body.resource_id]
    );
    result = {
      ...result,
      events: events.rows.map((row) => ({
        ...row,
        occurred_at: new Date(row.occurred_at).toISOString(),
      })),
    };
    await db.query(
      'INSERT INTO crm_command_receipts(command_id,payload_hash,response) VALUES($1,$2,$3::jsonb)',
      [body.command_id, hash, JSON.stringify(result)]
    );
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
module.exports = { executeCommand };
