'use strict';

const { t } = require('../../i18n');
const {
  withNotificationTransaction,
  deliverNotification,
} = require('../notification/notification-dispatch.service');
const {
  DEFAULT_TIMEZONE,
  getTimeParts,
  isHealthFeedEnabled,
  isWithinPushWindow,
  resolveTimezone,
} = require('./config');
const { FLOWS, PUSHABLE_FLOWS, getSelfFlow, selectContentForPlan } = require('./logic');
const repo = require('./repository');
const { hasReachedDailyCap } = require('../notification/notification.policy');

function getTemplateIdForFlow(flow) {
  if (flow === FLOWS.ALERT) return 'health_feed_alert';
  if (flow === FLOWS.FAMILY) return 'health_feed_family';
  return 'health_feed_onboarding';
}

function getNotificationCopy(job, payload) {
  const lang = job.language_preference === 'en' ? 'en' : 'vi';
  const content = repo.localizeContent(
    {
      title: job.content_title,
      summary: job.content_summary,
      body: job.content_body,
      action_label: job.content_action_label,
      action_target: job.content_action_target,
      translations: job.content_translations,
    },
    lang
  );

  return {
    title: content.title || payload.title || t('health_feed.push_fallback_title', lang),
    body:
      content.summary || content.body || payload.body || t('health_feed.push_fallback_body', lang),
    actionTarget: content.action_target || payload.action_target || '/feed',
  };
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
    const localizedCatalog = catalog.map((content) =>
      repo.localizeContent(content, user.language_preference)
    );
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
      catalog: localizedCatalog,
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

    if (!user.health_feed_enabled || !user.reminders_enabled) continue;

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
  if (!isHealthFeedEnabled()) return { enabled: false, scanned: 0, sent: 0, skipped: 0 };
  const jobs = await repo.getPendingNotificationJobs(pool);
  let sent = 0;
  let skipped = 0;
  for (const job of jobs) {
    const payload = job.payload || {};
    const copy = getNotificationCopy(job, payload);
    const timezone = resolveTimezone(job.timezone || DEFAULT_TIMEZONE);
    if (!job.health_feed_enabled) {
      await repo.markNotificationJobDispatched(pool, job.id, 'skipped_feed_disabled');
      skipped++;
      continue;
    }
    const reservation = await withNotificationTransaction(pool, job.user_id, async (client) => {
      const notificationId = await saveHealthFeedInAppNotification(client, job, payload);
      const capped = await hasReachedDailyCap(client, job.user_id, notificationId);
      const inWindow = isWithinPushWindow(timezone);
      const eligible = job.reminders_enabled && !capped && inWindow;
      await client.query('UPDATE notifications SET counts_toward_cap = $2 WHERE id = $1', [
        notificationId,
        eligible,
      ]);
      if (eligible) {
        await client.query(
          'INSERT INTO notification_push_outbox (notification_id, push_body) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [notificationId, copy.body]
        );
      }
      return { notificationId, capped, inWindow };
    });
    if (!job.reminders_enabled || reservation.capped) {
      await repo.markNotificationJobDispatched(
        pool,
        job.id,
        !job.reminders_enabled ? 'skipped_opt_out' : 'skipped_daily_cap'
      );
      skipped++;
      continue;
    }
    if (!reservation.inWindow) {
      skipped++;
      continue;
    }
    // The durable retry worker owns delivery after this point, not the feed job.
    await repo.markNotificationJobDispatched(pool, job.id, 'queued');
    const result = await deliverNotification(pool, reservation.notificationId);
    if (result.ok && !result.skipped) sent++;
    else skipped++;
  }
  return { enabled: true, scanned: jobs.length, sent, skipped };
}

async function saveHealthFeedInAppNotification(pool, job, payload) {
  const feedItemId = String(payload.feed_item_id || '');
  const contentId = String(payload.content_id || '');
  const existing = await pool.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND type = 'health_feed'
      AND (data->>'feedItemId' = $2 OR ($3 <> '' AND data->>'contentId' = $3)) LIMIT 1`,
    [job.user_id, feedItemId, contentId]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const priority =
    payload.flow === FLOWS.ALERT ? 'high' : payload.flow === FLOWS.FAMILY ? 'medium' : 'low';
  const copy = getNotificationCopy(job, payload);
  const data = {
    type: 'health_feed',
    screen: 'feed',
    contentId,
    feedItemId,
    actionTarget: copy.actionTarget,
    flow: payload.flow || null,
  };
  const inserted = await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data, priority, counts_toward_cap)
     VALUES ($1,'health_feed',$2,$3,$4::jsonb,$5,false) RETURNING id`,
    [job.user_id, copy.title, copy.body, JSON.stringify(data), priority]
  );
  return inserted.rows[0].id;
}

module.exports = {
  dispatchPendingNotifications,
  ensureUserFeed,
  runHealthFeedCycle,
};
