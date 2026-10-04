'use strict';

async function lockPurchaseChain(db, purchase) {
  const chain = purchase.originalTransactionId || purchase.transactionId;
  if (!chain || !['apple', 'google'].includes(purchase.platform)) {
    throw new Error('A verified Store transaction is required');
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `iap-chain:${purchase.platform}:${chain}`,
  ]);
}

async function lockPurchaseOwner(db, userId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`iap-owner:${userId}`]);
}

async function assertNotRevoked(db, purchase) {
  const result = await db.query(
    'SELECT 1 FROM iap_transaction_revocations WHERE platform = $1 AND transaction_id = $2',
    [purchase.platform, purchase.transactionId]
  );
  if (result.rows.length) {
    throw Object.assign(new Error('This Store transaction was refunded or revoked'), {
      code: 'IAP_PURCHASE_REVOKED',
    });
  }
}

async function recordRevocation(pool, event) {
  if (!event.transactionId) throw new Error('A revoked transaction ID is required');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await lockPurchaseChain(db, event);
    await db.query(
      `INSERT INTO iap_transaction_revocations
         (platform, transaction_id, original_transaction_id, product_id, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, transaction_id) DO NOTHING`,
      [
        event.platform,
        event.transactionId,
        event.originalTransactionId,
        event.productId,
        event.action,
      ]
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

module.exports = { lockPurchaseChain, lockPurchaseOwner, assertNotRevoked, recordRevocation };
