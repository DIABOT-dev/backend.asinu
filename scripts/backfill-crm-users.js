/**
 * Replay the approved user projection to CRM for all non-deleted users.
 *
 * Safe by default: without --confirm this only reads ASINU users and prints
 * the planned count. The confirmed path writes only crm_event_outbox; the
 * CRM database is changed by the normal signed webhook delivery path.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createPool } = require('../src/lib/db');
const { enqueueCrmEvent, flushCrmEventOutbox } = require('../src/services/integrations/crm-event.service');

const confirmed = process.argv.includes('--confirm');
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 3 });

const toIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const buildPayload = (user) => ({
  user_id: String(user.id),
  full_name: user.full_name || user.display_name || `Người dùng ASINU ${user.id}`,
  phone: user.phone_number || null,
  email: user.email || null,
  avatar_url: user.avatar_url || null,
  birth_year: user.birth_year == null ? null : Number(user.birth_year),
  gender: user.gender || null,
  zalo_user_id: user.zalo_id || null,
  lead_source: 'asinu_app',
  consent_ads: false,
  timezone: 'Asia/Ho_Chi_Minh',
  account_tier: user.subscription_tier === 'premium' ? 'premium' : user.subscription_tier || 'free',
  subscription_expires_at: toIso(user.subscription_expires_at),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (confirmed && (!process.env.CRM_INTEGRATION_URL || !process.env.CRM_INTEGRATION_SECRET)) {
    throw new Error('CRM_INTEGRATION_URL and CRM_INTEGRATION_SECRET are required for --confirm');
  }

  const result = await pool.query(
    `SELECT u.id, u.phone_number, u.email, u.full_name, u.display_name, u.avatar_url,
            u.zalo_id, u.subscription_tier, u.subscription_expires_at,
            uop.birth_year, uop.gender
       FROM users u
       LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
      WHERE u.deleted_at IS NULL
      ORDER BY u.id`,
  );

  const users = result.rows;
  const preview = users.map((user) => String(user.id));
  console.log(JSON.stringify({ mode: confirmed ? 'confirm' : 'dry-run', count: users.length, user_ids: preview }));
  if (!confirmed) return;

  let queued = 0;
  for (const user of users) {
    const outcome = await enqueueCrmEvent(pool, 'user.created', buildPayload(user), {
      event_id: `backfill:user.created:${user.id}`,
      source: 'asinu-backfill',
    });
    if (outcome.queued) queued += 1;
  }

  let sent = 0;
  let failed = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await flushCrmEventOutbox(pool, 100);
    sent += result.sent;
    failed += result.failed;
    if (!result.failed && sent >= queued) break;
    await sleep(1000);
  }

  const status = await pool.query(
    "SELECT status, count(*)::int AS count FROM crm_event_outbox WHERE event_id LIKE 'backfill:user.created:%' GROUP BY status ORDER BY status",
  );
  console.log(JSON.stringify({ queued, sent, failed, status: status.rows }));
}

run()
  .catch((error) => {
    console.error('[crm-backfill]', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
