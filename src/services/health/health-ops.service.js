'use strict';

const lifecycle = require('../profile/lifecycle.service');
const notifIntel = require('../notification/notification-intelligence.service');
const illusionLayer = require('../../core/checkin/illusion-layer');
const reengagement = require('../notification/reengagement.service');
const { runReengagement, sendAndSave } = require('../notification/basic.notification.service');
const { getNextQuestion, getNextQuestionWithIllusion } = require('../../core/checkin/script-runner');
const scriptCache = require('../checkin/script-cache.service');
const { runNightlyCycle } = require('../checkin/rnd-cycle.service');
const modelRouter = require('../../core/ai/model-router');
const contextCache = require('../../core/ai/context-cache');
const distillation = require('../../core/ai/distillation');

async function userExists(pool, userId) {
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  return rows.length > 0;
}

async function lifecycleSummary(pool) {
  const users = await lifecycle.getLifecycleSummary(pool);
  const stats = { active: 0, semi_active: 0, inactive: 0, churned: 0 };
  for (const row of users) stats[row.segment]++;
  return { stats, users };
}

async function lifecycleUser(pool, userId) {
  if (!(await userExists(pool, userId))) return null;
  return lifecycle.getLifecycle(pool, userId);
}

async function checkScript(pool, userId) {
  if (!(await userExists(pool, userId))) return null;
  const shouldGenerateScript = await lifecycle.shouldGenerateScript(pool, userId);
  const data = await lifecycle.getLifecycle(pool, userId);
  return { shouldGenerateScript, lifecycle: data };
}

function routeModel(input) {
  const route = modelRouter.routeModel(input || {});
  modelRouter.trackRouteDecision(route);
  return route;
}

function routeTriage(input) {
  const { status, answerCount, profile } = input || {};
  return modelRouter.routeForTriage(status || 'fine', answerCount || 0, profile || {});
}

async function cacheTest(messages, model) {
  return contextCache.getOrCallAI(
    messages,
    model || 'test',
    async () => ({ text: 'cached test response', timestamp: Date.now() }),
    60
  );
}

async function collectDistillation(pool, { taskType, model, input, output }) {
  const quality = distillation.autoRateQuality(output);
  const id = await distillation.collectOutput(
    pool,
    taskType,
    model || 'gpt-4o',
    input,
    output,
    quality
  );
  return { id, quality };
}

async function reuseStats(pool, userId) {
  if (!(await userExists(pool, userId))) return null;
  return scriptCache.getReuseStatsForUser(pool, userId);
}

async function reuseScript(pool, { userId, clusterKey, scriptType }) {
  const result = await scriptCache.getOrReuseScript(pool, userId, clusterKey, {
    scriptType: scriptType || 'initial',
    allowGenerate: false,
  });
  return {
    source: result.source,
    hasScript: !!result.script,
    reuseCount: result.script?.reuse_count,
    lastReusedAt: result.script?.last_reused_at,
  };
}

async function lastCycle(pool) {
  const { rows } = await pool.query('SELECT * FROM rnd_cycle_logs ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

async function reengagementPreview(pool, userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, u.full_name,
            COALESCE(u.language_preference,'vi') AS lang,
            uop.birth_year, uop.gender
       FROM users u
       LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const user = rows[0];
  const ctx = await reengagement.buildReengagementContext(pool, userId);
  const escalation = reengagement.getEscalationLevel(ctx.lifecycle.inactive_days);
  if (!escalation) {
    return { lifecycle: ctx.lifecycle, escalation: null, message: null, reason: 'user is active' };
  }
  const result = await reengagement.generateReengagementMessage(pool, userId, user);
  return {
    lifecycle: ctx.lifecycle,
    escalation,
    message: result?.message || null,
    context: result?.context || ctx,
  };
}

async function illusionPreview(pool, userId, lang) {
  const { rows: users } = await pool.query(
    `SELECT u.id, u.display_name, u.full_name, COALESCE(u.language_preference,'vi') AS lang,
            uop.birth_year, uop.gender
       FROM users u JOIN user_onboarding_profiles uop ON uop.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  if (!users.length) return null;
  const user = users[0];
  const ctx = await illusionLayer.buildCheckinContext(pool, userId);
  const { rows: scripts } = await pool.query(
    `SELECT script_data, cluster_key FROM triage_scripts
      WHERE user_id = $1 AND is_active = TRUE
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!scripts.length) {
    const { t } = require('../../i18n');
    return { context: ctx, message: t('health.ops.no_active_script', lang), illusion: null };
  }

  const scriptData = scripts[0].script_data;
  const original = getNextQuestion(scriptData, [], { sessionType: 'initial', profile: user });
  const illusionContext = { sessionType: 'initial', profile: user, illusionContext: ctx, user };
  const illusion = getNextQuestionWithIllusion(scriptData, [], illusionContext);
  const lastAnswer = { question_id: 'fu1', answer: 'Vẫn vậy' };
  const illusionStep1 = getNextQuestionWithIllusion(
    scriptData,
    [{ question_id: original.question?.id || 'q1', answer: 5 }],
    { ...illusionContext, lastAnswer }
  );
  const allAnswers = (scriptData.questions || scriptData.followup_questions || []).map(
    (question, index) => ({ question_id: question.id, answer: index === 0 ? 5 : 'Vẫn vậy' })
  );
  const illusionConclusion = getNextQuestionWithIllusion(scriptData, allAnswers, illusionContext);

  return {
    context: ctx,
    clusterKey: scripts[0].cluster_key,
    original: { greeting: scriptData.greeting, question: original.question },
    illusion: {
      greeting: illusion._greeting || null,
      continuity: illusion._continuity || null,
      question: illusion.question,
      _illusion: illusion._illusion,
    },
    step1_empathy: illusionStep1._empathy || null,
    conclusion_progress: illusionConclusion._progress || null,
  };
}

async function notificationPreview(pool, userId, triggerType) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, u.full_name, COALESCE(u.language_preference,'vi') AS lang,
            uop.birth_year, uop.gender
       FROM users u JOIN user_onboarding_profiles uop ON uop.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const msg = await notifIntel.generateMessage(pool, userId, triggerType, rows[0]);
  return { message: msg.text, templateId: msg.templateId, context: msg.context };
}

async function pendingNotificationAlerts(pool, userId) {
  if (!(await userExists(pool, userId))) return null;
  const result = await notifIntel.checkAlertTriggers(pool, userId);
  return { hasAlert: !!result, alert: result };
}

module.exports = {
  lifecycleSummary,
  lifecycleUser,
  checkScript,
  routeModel,
  routeTriage,
  cacheTest,
  collectDistillation,
  reuseStats,
  reuseScript,
  lastCycle,
  reengagementPreview,
  illusionPreview,
  notificationPreview,
  pendingNotificationAlerts,
  getGlobalDistillationStats: distillation.getGlobalDistillationStats,
  getFewShotExamples: distillation.getFewShotExamples,
  getGlobalReuseStats: scriptCache.getGlobalReuseStats,
  getTopReusedScripts: scriptCache.getTopReusedScripts,
  updateLifecycle: lifecycle.updateAllSegments,
  getRouteStats: modelRouter.getRouteStats,
  getCacheStats: contextCache.getCacheStats,
  runNightlyCycle,
  runReengagement: (pool) => runReengagement(pool, sendAndSave),
  getEscalationLevel: reengagement.getEscalationLevel,
  buildNotificationContext: notifIntel.buildUserContext,
};
