'use strict';

const logger = require('../../lib/logger');
const { sendPushNotification } = require('../notification/push.notification.service');
const { saveInAppNotification } = require('../notification/notification.service');
const { DEFAULT_TIMEZONE, getTimeParts, isHealthFeedEnabled, isWithinPushWindow, resolveTimezone } = require('./config');
const { FLOWS, PUSHABLE_FLOWS, getSelfFlow, selectContentForPlan } = require('./logic');
const repo = require('./repository');

function getTemplateIdForFlow(flow) {
  if (flow === FLOWS.ALERT) return 'health_feed_alert';
  if (flow === FLOWS.FAMILY) return 'health_feed_family';
  return 'health_feed_onboarding';
}

async function buildFeedForUsers(pool, userIds) {
  if (!isHealthFeedEnabled()) {
    return { enabled: false, processed: 0, inserted: 0, queued: 0 };
  }

  const [catalog, contexts] = await Promise.all([
    repo.getContentCatalog(pool),
    repo.getUserContexts(pool, userIds),
  ]);

  let inserted = 0;
  let queued = 0;

  for (const user of contexts) {
    const nowParts = getTimeParts(resolveTimezone(user.timezone));
    const historyKeys = new Set(
      (user.feed_history || []).map((row) => `${row.content_id}:${row.patient_id || 'self'}`)
    );
    const dismissedKeys = new Set(
      (user.feed_history || [])
        .filter((row) => row.dismissed_at)
        .map((row) => `${row.content_id}:${row.patient_id || 'self'}`)
    );
    const activeKeys = new Set(
      (user.active_feed || []).map((row) => `${row.content_id}:${row.patient_id || 'self'}`)
    );

    const context = {
      ...user,
      current_step: user.flow_state?.current_step || 1,
    };

    const selectedItems = selectContentForPlan({
      catalog,
      context,
      historyKeys,
      dismissedKeys,
      activeKeys,
      nowParts,
    });

    if (selectedItems.length === 0) continue;

    const nextFlow = getSelfFlow(context);
    const newlyInserted = await repo.insertFeedItems(pool, user, selectedItems);
    if (newlyInserted.length === 0) continue;

    inserted += newlyInserted.length;
    await repo.upsertUserFlow(pool, user.id, nextFlow, selectedItems);

    if (!user.reminders_enabled) continue;

    const recentHealthFeed = user.recent_health_feed_push;
    const recentReengagement = user.recent_reengagement_push;
    if (recentHealthFeed || recentReengagement) continue;

    const topInserted = newlyInserted.find((row) => PUSHABLE_FLOWS.has(row.flow));
    if (!topInserted) continue;

    const templateId = getTemplateIdForFlow(topInserted.flow);
    const recentTemplate = user.recent_template_ids?.has(templateId);
    if (recentTemplate) continue;

    await repo.enqueueNotification(pool, user.id, topInserted.id, templateId, {
      title: topInserted.title,
      body: topInserted.message,
      action_target: topInserted.action_target,
      content_id: topInserted.content_id,
      feed_item_id: topInserted.id,
      flow: topInserted.flow,
    });
    queued += 1;
  }

  return { enabled: true, processed: contexts.length, inserted, queued };
}

async function ensureUserFeed(pool, userId) {
  if (!isHealthFeedEnabled()) return { enabled: false, feed: [] };
  const current = await repo.listFeed(pool, userId);
  if (current.length > 0) return { enabled: true, feed: current };
  await buildFeedForUsers(pool, [userId]);
  const feed = await repo.listFeed(pool, userId);
  return { enabled: true, feed };
}

async function runHealthFeedCycle(pool) {
  if (!isHealthFeedEnabled()) {
    return { enabled: false, processed: 0, inserted: 0, queued: 0 };
  }
  const userIds = await repo.getEligibleUserIds(pool);
  return buildFeedForUsers(pool, userIds);
}

async function dispatchPendingNotifications(pool) {
  if (!isHealthFeedEnabled()) {
    return { enabled: false, scanned: 0, sent: 0, skipped: 0 };
  }

  const jobs = await repo.getPendingNotificationJobs(pool);
  let sent = 0;
  let skipped = 0;

  for (const job of jobs) {
    const payload = job.payload || {};
    await saveHealthFeedInAppNotification(pool, job, payload);

    const timezone = resolveTimezone(job.timezone || DEFAULT_TIMEZONE);
    if (!job.reminders_enabled) {
      await repo.markNotificationJobDispatched(pool, job.id, 'skipped_opt_out');
      skipped += 1;
      continue;
    }
    if (!isWithinPushWindow(timezone)) {
      skipped += 1;
      continue;
    }
    if (!job.push_token) {
      await repo.markNotificationJobDispatched(pool, job.id, 'skipped_no_token');
      skipped += 1;
      continue;
    }

    const result = await sendPushNotification(
      [job.push_token],
      payload.title || 'Asinu nhắc bạn',
      payload.body || 'Có một bản tin sức khỏe mới dành cho bạn',
      {
        type: 'health_feed',
        screen: 'feed',
        contentId: String(payload.content_id || ''),
        feedItemId: String(payload.feed_item_id || ''),
        actionTarget: payload.action_target || '/feed',
      }
    );

    if (result?.ok) {
      await repo.markNotificationJobDispatched(pool, job.id, 'sent');
      sent += 1;
    } else {
      logger.warn('health_feed.push_failed', { jobId: job.id, error: result?.error || 'unknown' });
      await repo.markNotificationJobDispatched(pool, job.id, 'failed');
      skipped += 1;
    }
  }

  return { enabled: true, scanned: jobs.length, sent, skipped };
}

async function saveHealthFeedInAppNotification(pool, job, payload) {
  const feedItemId = String(payload.feed_item_id || '');
  const contentId = String(payload.content_id || '');
  const existing = await pool.query(
    `SELECT id
       FROM notifications
      WHERE user_id = $1
        AND type = 'health_feed'
        AND (
          data->>'feedItemId' = $2
          OR ($3 <> '' AND data->>'contentId' = $3)
        )
      LIMIT 1`,
    [job.user_id, feedItemId, contentId]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const priority = payload.flow === FLOWS.ALERT ? 'high' : payload.flow === FLOWS.FAMILY ? 'medium' : 'low';
  const title = payload.title || 'Asinu nhắc bạn';
  const message = payload.body || 'Có một bản tin sức khỏe mới dành cho bạn';
  const data = {
    type: 'health_feed',
    screen: 'feed',
    contentId,
    feedItemId,
    actionTarget: payload.action_target || '/feed',
    flow: payload.flow || null,
  };

  await saveInAppNotification(pool, job.user_id, 'health_feed', title, message, data, priority);
  return null;
}

module.exports = {
  dispatchPendingNotifications,
  ensureUserFeed,
  runHealthFeedCycle,
};
