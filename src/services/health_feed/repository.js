'use strict';

const { DEFAULT_TIMEZONE } = require('./config');

async function getContentCatalog(pool) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, body, checklist, content_type, target_conditions,
            target_flow, target_cluster_key, topic_category, flow_step,
            severity_level, engagement_score, shareable, saveable, status,
            action_label, action_target
       FROM health_feed_content_items
      WHERE status = 'active'`
  );
  return rows.map((row) => ({
    ...row,
    checklist: Array.isArray(row.checklist) ? row.checklist : [],
    target_conditions: Array.isArray(row.target_conditions) ? row.target_conditions : [],
  }));
}

async function getUserContexts(pool, userIds) {
  if (!userIds.length) return [];

  const [{ rows: users }, { rows: clusters }, { rows: sessions }, { rows: familyRows }, { rows: adherence }, { rows: engagement }, { rows: flowRows }, { rows: historyRows }, { rows: activeFeedRows }, { rows: recentFeedPushRows }, { rows: recentTemplateRows }, { rows: recentReengagementRows }] = await Promise.all([
    pool.query(
      `SELECT u.id, u.created_at, u.push_token, u.language_preference, u.display_name, u.full_name,
              uop.medical_conditions, uop.birth_year, uop.age, uop.post_meal_drowsy, uop.user_group,
              uop.risk_score, uop.onboarding_completed_at,
              ul.segment, ul.inactive_days, ul.last_checkin_at,
              ub.timezone,
              COALESCE(unp.reminders_enabled, true) AS reminders_enabled
         FROM users u
         LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
         LEFT JOIN user_lifecycle ul ON ul.user_id = u.id
         LEFT JOIN user_baselines ub ON ub.user_id = u.id
         LEFT JOIN user_notification_preferences unp ON unp.user_id = u.id
        WHERE u.id = ANY($1::int[])
          AND u.deleted_at IS NULL`,
      [userIds]
    ),
    pool.query(
      `SELECT DISTINCT ON (user_id) user_id, cluster_key, display_name, count_7d, trend, priority
         FROM problem_clusters
        WHERE user_id = ANY($1::int[]) AND is_active = TRUE
        ORDER BY user_id, priority DESC, updated_at DESC`,
      [userIds]
    ),
    pool.query(
      `SELECT DISTINCT ON (ss.user_id)
              ss.user_id, ss.needs_doctor, ss.severity
         FROM script_sessions ss
        WHERE ss.user_id = ANY($1::int[])
        ORDER BY ss.user_id, ss.created_at DESC`,
      [userIds]
    ),
    pool.query(
      `SELECT candidate.user_id,
              linked.id AS patient_id,
              COALESCE(linked.display_name, linked.full_name, 'Người thân') AS patient_name,
              COALESCE(linked_lifecycle.inactive_days, 0) AS patient_inactive_days
         FROM (
           SELECT requester_id AS user_id, addressee_id AS patient_id
             FROM user_connections
            WHERE requester_id = ANY($1::int[]) AND status = 'accepted'
           UNION ALL
           SELECT addressee_id AS user_id, requester_id AS patient_id
             FROM user_connections
            WHERE addressee_id = ANY($1::int[]) AND status = 'accepted'
         ) candidate
         JOIN users linked ON linked.id = candidate.patient_id AND linked.deleted_at IS NULL
         LEFT JOIN user_lifecycle linked_lifecycle ON linked_lifecycle.user_id = linked.id`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id,
              AVG(CASE WHEN status = 'taken' THEN 1.0 ELSE 0.0 END) AS adherence_rate
         FROM medication_adherence
        WHERE user_id = ANY($1::int[])
          AND medication_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY user_id`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id,
              COUNT(*) FILTER (WHERE event_type = 'checkin_response' AND occurred_at >= NOW() - INTERVAL '7 days') AS checkin_days_7d
         FROM user_engagement
        WHERE user_id = ANY($1::int[])
        GROUP BY user_id`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id, current_flow, current_step, flow_entered_at, last_content_at, last_content_topic
         FROM health_feed_user_flow
        WHERE user_id = ANY($1::int[])`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id, content_id, patient_id, dismissed_at
         FROM health_feed_feed_items
        WHERE user_id = ANY($1::int[])`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id, content_id, patient_id
         FROM health_feed_feed_items
        WHERE user_id = ANY($1::int[])
          AND dismissed_at IS NULL
          AND expires_at > NOW()`,
      [userIds]
    ),
    pool.query(
      `SELECT DISTINCT user_id
         FROM health_feed_notification_jobs
        WHERE user_id = ANY($1::int[])
          AND dispatched_at >= NOW() - INTERVAL '24 hours'`,
      [userIds]
    ),
    pool.query(
      `SELECT user_id, template_id
         FROM health_feed_notification_jobs
        WHERE user_id = ANY($1::int[])
          AND dispatched_at >= NOW() - INTERVAL '72 hours'`,
      [userIds]
    ),
    pool.query(
      `SELECT DISTINCT user_id
         FROM notifications
        WHERE user_id = ANY($1::int[])
          AND type = 'reengagement'
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      [userIds]
    ),
  ]);

  const clusterMap = new Map(clusters.map((row) => [row.user_id, row]));
  const sessionMap = new Map(sessions.map((row) => [row.user_id, row]));
  const adherenceMap = new Map(adherence.map((row) => [row.user_id, Number(row.adherence_rate || 0)]));
  const engagementMap = new Map(engagement.map((row) => [row.user_id, Number(row.checkin_days_7d || 0)]));
  const flowMap = new Map(flowRows.map((row) => [row.user_id, row]));
  const recentFeedPushSet = new Set(recentFeedPushRows.map((row) => row.user_id));
  const recentReengagementSet = new Set(recentReengagementRows.map((row) => row.user_id));
  const recentTemplateMap = new Map();
  for (const row of recentTemplateRows) {
    if (!recentTemplateMap.has(row.user_id)) recentTemplateMap.set(row.user_id, new Set());
    recentTemplateMap.get(row.user_id).add(row.template_id);
  }
  const familyMap = new Map();
  for (const row of familyRows) {
    if (!familyMap.has(row.user_id)) familyMap.set(row.user_id, []);
    familyMap.get(row.user_id).push(row);
  }
  for (const list of familyMap.values()) {
    list.sort((a, b) => Number(b.patient_inactive_days || 0) - Number(a.patient_inactive_days || 0));
  }
  const historyMap = new Map();
  for (const row of historyRows) {
    if (!historyMap.has(row.user_id)) historyMap.set(row.user_id, []);
    historyMap.get(row.user_id).push(row);
  }
  const activeMap = new Map();
  for (const row of activeFeedRows) {
    if (!activeMap.has(row.user_id)) activeMap.set(row.user_id, []);
    activeMap.get(row.user_id).push(row);
  }

  return users.map((user) => ({
    ...user,
    language_preference: user.language_preference || 'vi',
    medical_conditions: Array.isArray(user.medical_conditions) ? user.medical_conditions : [],
    segment: user.segment || 'inactive',
    inactive_days: Number(user.inactive_days || 0),
    timezone: user.timezone || DEFAULT_TIMEZONE,
    reminders_enabled: Boolean(user.reminders_enabled),
    top_cluster: clusterMap.get(user.id) || null,
    latest_session: sessionMap.get(user.id) || null,
    related_patients: familyMap.get(user.id) || [],
    recent_health_feed_push: recentFeedPushSet.has(user.id),
    recent_reengagement_push: recentReengagementSet.has(user.id),
    recent_template_ids: recentTemplateMap.get(user.id) || new Set(),
    medication_adherence_rate: adherenceMap.get(user.id) ?? 1,
    checkin_days_7d: engagementMap.get(user.id) ?? 0,
    flow_state: flowMap.get(user.id) || null,
    feed_history: historyMap.get(user.id) || [],
    active_feed: activeMap.get(user.id) || [],
  }));
}

async function getEligibleUserIds(pool) {
  const { rows } = await pool.query(
    `SELECT u.id
       FROM users u
      WHERE u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM user_onboarding_profiles uop WHERE uop.user_id = u.id)`
  );
  return rows.map((row) => row.id);
}

async function upsertUserFlow(pool, userId, nextFlow, selectedItems) {
  const nextStep = Math.min(
    5,
    Math.max(
      1,
      ...selectedItems.map((item) => Number(item.content.flow_step || 1))
    ) + 1
  );
  const lastTopic = selectedItems.find((item) => item.content.topic_category)?.content.topic_category || null;
  await pool.query(
    `INSERT INTO health_feed_user_flow (user_id, current_flow, current_step, flow_entered_at, last_content_at, last_content_topic, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW(), $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       current_flow = EXCLUDED.current_flow,
       current_step = CASE
         WHEN health_feed_user_flow.current_flow <> EXCLUDED.current_flow THEN 1
         ELSE EXCLUDED.current_step
       END,
       flow_entered_at = CASE
         WHEN health_feed_user_flow.current_flow <> EXCLUDED.current_flow THEN NOW()
         ELSE health_feed_user_flow.flow_entered_at
       END,
       last_content_at = NOW(),
       last_content_topic = EXCLUDED.last_content_topic,
       updated_at = NOW()`,
    [userId, nextFlow, nextStep, lastTopic]
  );
}

async function insertFeedItems(pool, user, selectedItems) {
  const inserted = [];
  for (const item of selectedItems) {
    const content = item.content;
    const patientId = item.patient_id || null;
    const priority = content.content_type === 'warning'
      ? 100
      : item.flow === 'FLOW_FAMILY' && patientId && user.related_patients.find((p) => p.patient_id === patientId)?.patient_inactive_days >= 3
        ? 80
        : 40;

    const message = content.summary || content.body.slice(0, 180);
    const result = await pool.query(
      `INSERT INTO health_feed_feed_items (
         user_id, content_id, patient_id, feed_type, title, message, priority, action_label, action_target, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + INTERVAL '7 days')
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, content_id, patient_id, feed_type, title, message, priority, action_label, action_target, created_at, expires_at`,
      [
        user.id,
        content.id,
        patientId,
        content.content_type,
        content.title,
        message,
        priority,
        content.action_label || 'Đọc chi tiết',
        content.action_target || `/feed/${content.id}`,
      ]
    );
    if (result.rows[0]) {
      inserted.push({ ...result.rows[0], flow: item.flow, content });
    }
  }
  return inserted;
}

async function listFeed(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, content_id, patient_id, feed_type, title, message, priority,
            action_label, action_target, created_at, read_at, dismissed_at, expires_at,
            CASE WHEN priority >= 100 THEN 'warning' ELSE 'info' END AS severity_level
       FROM health_feed_feed_items
      WHERE user_id = $1
        AND dismissed_at IS NULL
        AND expires_at > NOW()
      ORDER BY priority DESC, created_at DESC
      LIMIT 5`,
    [userId]
  );
  return rows;
}

async function getContent(pool, userId, contentId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.summary, c.body, c.checklist, c.content_type, c.severity_level,
            c.shareable, c.saveable, c.action_label AS cta_label, c.action_target AS cta_target,
            EXISTS(
              SELECT 1 FROM health_feed_saved_content sc
               WHERE sc.user_id = $1 AND sc.content_id = c.id
            ) AS is_saved
       FROM health_feed_content_items c
      WHERE c.id = $2
        AND c.status = 'active'
      LIMIT 1`,
    [userId, contentId]
  );
  return rows[0] || null;
}

async function markRead(pool, userId, feedItemId) {
  const { rowCount } = await pool.query(
    `UPDATE health_feed_feed_items
        SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2`,
    [feedItemId, userId]
  );
  return rowCount > 0;
}

async function dismiss(pool, userId, feedItemId) {
  const { rowCount } = await pool.query(
    `UPDATE health_feed_feed_items
        SET dismissed_at = COALESCE(dismissed_at, NOW())
      WHERE id = $1 AND user_id = $2`,
    [feedItemId, userId]
  );
  return rowCount > 0;
}

async function saveContent(pool, userId, contentId) {
  await pool.query(
    `INSERT INTO health_feed_saved_content(user_id, content_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, contentId]
  );
}

async function unsaveContent(pool, userId, contentId) {
  await pool.query(
    `DELETE FROM health_feed_saved_content
      WHERE user_id = $1 AND content_id = $2`,
    [userId, contentId]
  );
}

async function listSaved(pool, userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.summary, c.content_type, sc.saved_at
       FROM health_feed_saved_content sc
       JOIN health_feed_content_items c ON c.id = sc.content_id
      WHERE sc.user_id = $1
      ORDER BY sc.saved_at DESC`,
    [userId]
  );
  return rows;
}

async function trackEvent(pool, userId, { content_id, feed_item_id = null, event_type, metadata = {} }) {
  await pool.query(
    `INSERT INTO health_feed_content_events(user_id, content_id, feed_item_id, event_type, metadata)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, content_id, feed_item_id, event_type, JSON.stringify(metadata || {})]
  );
}

async function enqueueNotification(pool, userId, feedItemId, templateId, payload) {
  await pool.query(
    `INSERT INTO health_feed_notification_jobs(user_id, feed_item_id, template_id, payload, scheduled_for)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (feed_item_id) DO NOTHING`,
    [userId, feedItemId, templateId, JSON.stringify(payload)]
  );
}

async function getNotificationTemplate(pool, templateId) {
  const { rows } = await pool.query(
    `SELECT id, target_flow, title_template, body_template
       FROM health_feed_notification_templates
      WHERE id = $1`,
    [templateId]
  );
  return rows[0] || null;
}

async function getPendingNotificationJobs(pool, limit = 50) {
  const { rows } = await pool.query(
    `SELECT j.id, j.user_id, j.feed_item_id, j.template_id, j.payload, j.scheduled_for,
            u.push_token, COALESCE(u.language_preference, 'vi') AS language_preference,
            ub.timezone, COALESCE(unp.reminders_enabled, true) AS reminders_enabled
       FROM health_feed_notification_jobs j
       JOIN users u ON u.id = j.user_id
       LEFT JOIN user_baselines ub ON ub.user_id = u.id
       LEFT JOIN user_notification_preferences unp ON unp.user_id = u.id
      WHERE j.status = 'pending'
        AND j.dispatched_at IS NULL
        AND j.scheduled_for <= NOW()
      ORDER BY j.scheduled_for ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function markNotificationJobDispatched(pool, jobId, status) {
  await pool.query(
    `UPDATE health_feed_notification_jobs
        SET status = $2,
            dispatched_at = CASE
              WHEN $2 = 'pending' THEN dispatched_at
              ELSE COALESCE(dispatched_at, NOW())
            END
      WHERE id = $1`,
    [jobId, status]
  );
}

module.exports = {
  dismiss,
  enqueueNotification,
  getContent,
  getContentCatalog,
  getEligibleUserIds,
  getNotificationTemplate,
  getPendingNotificationJobs,
  getUserContexts,
  insertFeedItems,
  listFeed,
  listSaved,
  markNotificationJobDispatched,
  markRead,
  saveContent,
  trackEvent,
  unsaveContent,
  upsertUserFlow,
};
