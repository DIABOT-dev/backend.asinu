/**
 * In-process scheduler powered by node-cron.
 *
 * Cron expressions all run in Asia/Ho_Chi_Minh timezone so config matches the
 * product spec ("7AM Vietnam time" etc.) instead of UTC.
 *
 * Limitation: still in-process — jobs missed during downtime are not replayed.
 * Tracked in audit (#16). When traffic justifies the cost, swap for BullMQ
 * (Redis-backed, durable, distributed).
 */

const cron = require('node-cron');
const logger = require('../lib/logger');
const { captureException } = require('../lib/sentry');
const { runBasicNotifications } = require('../services/notification/basic.notification.service');
const { runNightlyCycle } = require('../services/checkin/rnd-cycle.service');
const { updateAllSegments } = require('../services/profile/lifecycle.service');
const { runDailyLifecycleNotifications } = require('../services/notification/lifecycle.notification.service');
const { dispatchPendingNotifications, runHealthFeedCycle } = require('../services/health_feed/service');

const TZ = 'Asia/Ho_Chi_Minh';

/**
 * Schedule a cron job with a single-flight guard (prevents overlap if a
 * previous tick is still running) and central error capture.
 *
 * Successful runs are NOT logged by default — for jobs that tick every
 * minute that would be ~1.4k log lines/day with no signal. The handler
 * itself is expected to log when it did meaningful work. Failures are
 * always logged + sent to Sentry.
 */
function safeCron(expression, name, handler) {
  let running = false;
  cron.schedule(
    expression,
    async () => {
      if (running) {
        logger.debug('cron.skipped', { job: name, reason: 'still_running' });
        return;
      }
      running = true;
      const started = Date.now();
      try {
        await handler();
        logger.debug('cron.completed', { job: name, elapsed_ms: Date.now() - started });
      } catch (err) {
        logger.error('cron.failed', { job: name, err, elapsed_ms: Date.now() - started });
        captureException(err, { job: name });
      } finally {
        running = false;
      }
    },
    { timezone: TZ }
  );
}

function startScheduler(pool) {
  // Per-minute notification tick — sends notifications for users whose configured HH:MM == now.
  safeCron('* * * * *', 'basic_notifications', async () => {
    const result = await runBasicNotifications(pool);
    if (result?.totalSent > 0) {
      logger.info('cron.basic_notifications.sent', {
        sent: result.totalSent,
        time: `${result.hour}:${String(result.minute).padStart(2, '0')}`,
      });
    }
  });

  safeCron('* * * * *', 'health_feed_notifications', async () => {
    const result = await dispatchPendingNotifications(pool);
    if (result?.sent > 0) {
      logger.info('cron.health_feed_notifications.sent', {
        sent: result.sent,
        scanned: result.scanned,
        skipped: result.skipped,
      });
    }
  });

  // Daily chat history cleanup at 03:00 VN time.
  safeCron('0 3 * * *', 'chat_history_cleanup', async () => {
    await pool.query('SELECT cleanup_chat_histories()');
  });

  // Lifecycle segment update at 01:00 VN time (before R&D cycle).
  safeCron('0 1 * * *', 'lifecycle_update', async () => {
    const stats = await updateAllSegments(pool);
    logger.info('cron.lifecycle_update.stats', { stats });
  });

  // R&D nightly cycle at 02:00 VN time.
  safeCron('0 2 * * *', 'rnd_cycle', async () => {
    const stats = await runNightlyCycle(pool);
    logger.info('cron.rnd_cycle.stats', { stats });
  });

  // Daily lifecycle notifications at 07:00 VN time.
  safeCron('0 7 * * *', 'lifecycle_notifications', async () => {
    const dayOfWeek = new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).getDay();
    const stats = await runDailyLifecycleNotifications(pool, { dayOfWeek });
    logger.info('cron.lifecycle_notifications.stats', { stats });
  });

  safeCron('0 */6 * * *', 'health_feed_cycle', async () => {
    const stats = await runHealthFeedCycle(pool);
    logger.info('cron.health_feed_cycle.stats', { stats });
  });

  // Daily database log cleanup at 03:30 VN time.
  safeCron('30 3 * * *', 'database_log_cleanup', async () => {
    // Giữ ai_logs trong 90 ngày
    await pool.query("DELETE FROM ai_logs WHERE created_at < NOW() - INTERVAL '90 days'");
    // Giữ fallback_logs trong 30 ngày
    await pool.query("DELETE FROM fallback_logs WHERE created_at < NOW() - INTERVAL '30 days'");
    // Giữ user_activity_logs trong 90 ngày
    await pool.query("DELETE FROM user_activity_logs WHERE created_at < NOW() - INTERVAL '90 days'");
    logger.info('cron.database_log_cleanup.completed');
  });
}

module.exports = { startScheduler };
