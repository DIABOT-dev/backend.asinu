require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const { dispatchPendingNotifications, ensureUserFeed, runHealthFeedCycle } = require('../src/services/health_feed/service');

const DATABASE_URL = process.env.DATABASE_URL;

function parseArgs(argv) {
  const args = { userId: 1, reset: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--user-id' && argv[index + 1]) {
      args.userId = Number(argv[index + 1]);
      index += 1;
    } else if (token === '--no-reset') {
      args.reset = false;
    }
  }
  return args;
}

async function ensureUserContext(pool, userId) {
  const userResult = await pool.query(
    `SELECT id, email, COALESCE(display_name, full_name, email) AS label
       FROM users
      WHERE id = $1
        AND deleted_at IS NULL`,
    [userId]
  );

  if (!userResult.rows[0]) {
    throw new Error(`User ${userId} not found. Create a local test user first.`);
  }

  await pool.query(
    `INSERT INTO user_onboarding_profiles (
       user_id,
       age,
       medical_conditions,
       post_meal_drowsy,
       user_group,
       risk_score,
       birth_year,
       onboarding_completed_at
     )
     VALUES (
       $1,
       '50-59',
       '["tieu_duong","cao_huyet_ap"]'::jsonb,
       'Thường xuyên',
       'metabolic',
       7,
       1972,
       NOW() - INTERVAL '7 days'
     )
     ON CONFLICT (user_id) DO UPDATE SET
       age = EXCLUDED.age,
       medical_conditions = EXCLUDED.medical_conditions,
       post_meal_drowsy = EXCLUDED.post_meal_drowsy,
       user_group = EXCLUDED.user_group,
       risk_score = EXCLUDED.risk_score,
       birth_year = EXCLUDED.birth_year,
       onboarding_completed_at = COALESCE(user_onboarding_profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at),
       updated_at = NOW()`,
    [userId]
  );

  await pool.query(
    `INSERT INTO user_lifecycle (user_id, segment, last_checkin_at, last_app_open_at, inactive_days, updated_at)
     VALUES ($1, 'inactive', NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 days', 4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       segment = EXCLUDED.segment,
       last_checkin_at = EXCLUDED.last_checkin_at,
       last_app_open_at = EXCLUDED.last_app_open_at,
       inactive_days = EXCLUDED.inactive_days,
       updated_at = NOW()`,
    [userId]
  );

  await pool.query(
    `INSERT INTO user_baselines (user_id, timezone, source, updated_at)
     VALUES ($1, 'Asia/Ho_Chi_Minh', 'health-feed-test-script', NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = EXCLUDED.timezone,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [userId]
  );

  await pool.query(
    `INSERT INTO user_notification_preferences (user_id, reminders_enabled, updated_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       reminders_enabled = true,
       updated_at = NOW()`,
    [userId]
  );

  return userResult.rows[0];
}

async function resetHealthFeedState(pool, userId) {
  await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'health_feed'`, [userId]);
  await pool.query(`DELETE FROM health_feed_notification_jobs WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM health_feed_feed_items WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM health_feed_user_flow WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM health_feed_content_events WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM health_feed_saved_content WHERE user_id = $1`, [userId]);
}

async function getSummary(pool, userId) {
  const [feedItems, notifications, jobs] = await Promise.all([
    pool.query(
      `SELECT id, title, message, action_target, created_at, read_at
         FROM health_feed_feed_items
        WHERE user_id = $1
          AND dismissed_at IS NULL
          AND expires_at > NOW()
        ORDER BY priority DESC, created_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT id, title, message, priority, is_read, data, created_at
         FROM notifications
        WHERE user_id = $1
          AND type = 'health_feed'
        ORDER BY created_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT id, template_id, status, dispatched_at, payload
         FROM health_feed_notification_jobs
        WHERE user_id = $1
        ORDER BY id DESC`,
      [userId]
    ),
  ]);

  return {
    feedItems: feedItems.rows,
    notifications: notifications.rows,
    jobs: jobs.rows,
  };
}

async function ensureNotificationJob(pool, userId) {
  const feedResult = await pool.query(
    `SELECT id, content_id, title, message, action_target
       FROM health_feed_feed_items
      WHERE user_id = $1
        AND dismissed_at IS NULL
        AND expires_at > NOW()
      ORDER BY priority DESC, created_at DESC
      LIMIT 1`,
    [userId]
  );

  const feedItem = feedResult.rows[0];
  if (!feedItem) {
    return false;
  }

  const existingJob = await pool.query(
    `SELECT id
       FROM health_feed_notification_jobs
      WHERE user_id = $1
        AND feed_item_id = $2
      LIMIT 1`,
    [userId, feedItem.id]
  );

  if (existingJob.rows[0]) {
    return true;
  }

  await pool.query(
    `INSERT INTO health_feed_notification_jobs (
       user_id,
       feed_item_id,
       template_id,
       payload,
       scheduled_for
     )
     VALUES (
       $1,
       $2,
       'health_feed_onboarding',
       $3::jsonb,
       NOW()
     )`,
    [
      userId,
      feedItem.id,
      JSON.stringify({
        title: feedItem.title,
        body: feedItem.message,
        action_target: feedItem.action_target,
        content_id: feedItem.content_id,
        feed_item_id: feedItem.id,
        flow: 'FLOW_ONBOARDING',
      }),
    ]
  );

  return true;
}

async function main() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const { userId, reset } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Use a positive integer with --user-id');
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const user = await ensureUserContext(pool, userId);
    if (reset) {
      await resetHealthFeedState(pool, userId);
    }

    const cycle = await runHealthFeedCycle(pool);
    const feed = await ensureUserFeed(pool, userId);
    await ensureNotificationJob(pool, userId);
    const dispatch = await dispatchPendingNotifications(pool);
    const summary = await getSummary(pool, userId);

    console.log(JSON.stringify({
      ok: true,
      user,
      reset,
      cycle,
      dispatch,
      feedCount: feed.feed.length,
      notificationCount: summary.notifications.length,
      jobCount: summary.jobs.length,
      feedItems: summary.feedItems.map((item) => ({
        id: item.id,
        title: item.title,
        actionTarget: item.action_target,
        createdAt: item.created_at,
      })),
      notifications: summary.notifications.map((item) => ({
        id: item.id,
        title: item.title,
        priority: item.priority,
        data: item.data,
        createdAt: item.created_at,
      })),
      jobs: summary.jobs.map((item) => ({
        id: item.id,
        templateId: item.template_id,
        status: item.status,
        dispatchedAt: item.dispatched_at,
      })),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
