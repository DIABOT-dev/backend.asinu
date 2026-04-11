const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { alertCareCircle, runDailyMonitor, runUserMonitor } = require('../controllers/health.controller');
const lifecycle = require('../services/profile/lifecycle.service');
const notifIntel = require('../services/notification/notification-intelligence.service');
const illusionLayer = require('../core/checkin/illusion-layer');
const reengagement = require('../services/notification/reengagement.service');
const { runReengagement, sendAndSave } = require('../services/notification/basic.notification.service');
const { getNextQuestion, getNextQuestionWithIllusion } = require('../core/checkin/script-runner');
const scriptCache = require('../services/checkin/script-cache.service');
const { runNightlyCycle } = require('../services/checkin/rnd-cycle.service');
const modelRouter = require('../core/ai/model-router');
const contextCache = require('../core/ai/context-cache');
const { streamChunked } = require('../core/ai/streaming');
const distillation = require('../core/ai/distillation');

function healthRoutes(pool) {
  const router = express.Router();

  router.post('/monitor/daily', (req, res) => runDailyMonitor(pool, req, res));
  router.post('/alert-care-circle', requireAuth, (req, res) => alertCareCircle(pool, req, res));
  router.post('/monitor/user/:userId', (req, res) => runUserMonitor(pool, req, res));

  // ─── Lifecycle endpoints ────────────────────────────────────────────────
  // GET /api/health/lifecycle — toàn bộ user lifecycle summary
  router.get('/lifecycle', async (req, res) => {
    try {
      const summary = await lifecycle.getLifecycleSummary(pool);
      const stats = { active: 0, semi_active: 0, inactive: 0, churned: 0 };
      for (const row of summary) stats[row.segment]++;
      res.json({ ok: true, stats, users: summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/lifecycle/:userId — lifecycle cho 1 user
  router.get('/lifecycle/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const data = await lifecycle.getLifecycle(pool, userId);
      res.json({ ok: true, lifecycle: data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/health/lifecycle/update-all — trigger update segments thủ công
  router.post('/lifecycle/update-all', async (req, res) => {
    try {
      const stats = await lifecycle.updateAllSegments(pool);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/lifecycle/check-script/:userId — kiểm tra user có nên generate script không
  router.get('/lifecycle/check-script/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const should = await lifecycle.shouldGenerateScript(pool, userId);
      const data = await lifecycle.getLifecycle(pool, userId);
      res.json({ ok: true, shouldGenerateScript: should, lifecycle: data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── LLM Optimization endpoints ──────────────────────────────────

  // POST /api/health/ai/route — test model routing
  router.post('/ai/route', (req, res) => {
    const route = modelRouter.routeModel(req.body || {});
    modelRouter.trackRouteDecision(route);
    res.json({ ok: true, route });
  });

  // GET /api/health/ai/route-stats — routing stats
  router.get('/ai/route-stats', (req, res) => {
    res.json({ ok: true, stats: modelRouter.getRouteStats() });
  });

  // POST /api/health/ai/route-triage — route for specific triage scenario
  router.post('/ai/route-triage', (req, res) => {
    const { status, answerCount, profile } = req.body || {};
    const route = modelRouter.routeForTriage(status || 'fine', answerCount || 0, profile || {});
    res.json({ ok: true, route });
  });

  // GET /api/health/ai/cache-stats — context cache stats
  router.get('/ai/cache-stats', (req, res) => {
    res.json({ ok: true, stats: contextCache.getCacheStats() });
  });

  // POST /api/health/ai/cache-test — test context cache hit/miss
  router.post('/ai/cache-test', async (req, res) => {
    const { messages, model } = req.body || {};
    if (!messages) return res.status(400).json({ ok: false, error: 'messages required' });
    const result = await contextCache.getOrCallAI(messages, model || 'test', async () => {
      return { text: 'cached test response', timestamp: Date.now() };
    }, 60);
    res.json({ ok: true, cacheHit: result.cacheHit, response: result.response });
  });

  // GET /api/health/ai/stream-test — test SSE streaming (with cached text)
  router.get('/ai/stream-test', async (req, res) => {
    const text = 'Chú Hùng ơi, hôm nay chú thấy thế nào? Cháu muốn hỏi thăm chú nhé. Mấy hôm nay chú có đỡ hơn không?';
    await streamChunked(res, text, { chunkSize: 15, delayMs: 50, metadata: { source: 'test' } });
  });

  // GET /api/health/ai/distillation-stats — distillation stats
  router.get('/ai/distillation-stats', async (req, res) => {
    try {
      const stats = await distillation.getGlobalDistillationStats(pool);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/health/ai/distillation-collect — test data collection
  router.post('/ai/distillation-collect', async (req, res) => {
    const { taskType, model, input, output } = req.body || {};
    if (!taskType || !input || !output) return res.status(400).json({ ok: false, error: 'taskType, input, output required' });
    try {
      const quality = distillation.autoRateQuality(output);
      const id = await distillation.collectOutput(pool, taskType, model || 'gpt-4o', input, output, quality);
      res.json({ ok: true, id, quality });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/ai/few-shot/:taskType — get few-shot examples
  router.get('/ai/few-shot/:taskType', async (req, res) => {
    try {
      const examples = await distillation.getFewShotExamples(pool, req.params.taskType, 5);
      res.json({ ok: true, count: examples.length, examples });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Phase 6: Cache reuse + Priority compute endpoints ───────────
  // GET /api/health/cache/global — global reuse stats
  router.get('/cache/global', async (req, res) => {
    try {
      const stats = await scriptCache.getGlobalReuseStats(pool);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/cache/user/:userId — reuse stats for one user
  router.get('/cache/user/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const stats = await scriptCache.getReuseStatsForUser(pool, userId);
      res.json({ ok: true, userId, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/cache/top-reused?limit=10 — top reused scripts
  router.get('/cache/top-reused', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const scripts = await scriptCache.getTopReusedScripts(pool, limit);
      res.json({ ok: true, scripts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/health/cache/reuse — reuse cached script for user+cluster (test endpoint)
  router.post('/cache/reuse', async (req, res) => {
    const { userId, clusterKey, scriptType } = req.body || {};
    if (!userId || !clusterKey) return res.status(400).json({ ok: false, error: 'userId and clusterKey required' });
    try {
      const result = await scriptCache.getOrReuseScript(pool, userId, clusterKey, {
        scriptType: scriptType || 'initial',
        allowGenerate: false,
      });
      res.json({ ok: true, source: result.source, hasScript: !!result.script,
                 reuseCount: result.script?.reuse_count, lastReusedAt: result.script?.last_reused_at });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/health/rnd-cycle/run — manually trigger R&D cycle (priority)
  router.post('/rnd-cycle/run', async (req, res) => {
    try {
      const stats = await runNightlyCycle(pool);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/rnd-cycle/last — last cycle log
  router.get('/rnd-cycle/last', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM rnd_cycle_logs ORDER BY id DESC LIMIT 1`
      );
      res.json({ ok: true, log: rows[0] || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Re-engagement endpoints (test/debug) ────────────────────────
  // GET /api/health/reengagement-preview/:userId — preview message cho 1 user
  router.get('/reengagement-preview/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const { rows: users } = await pool.query(
        `SELECT u.id, u.display_name, u.full_name,
                COALESCE(u.language_preference,'vi') AS lang,
                uop.birth_year, uop.gender
         FROM users u
         LEFT JOIN user_onboarding_profiles uop ON uop.user_id = u.id
         WHERE u.id = $1`, [userId]
      );
      if (users.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const user = users[0];

      const ctx = await reengagement.buildReengagementContext(pool, userId);
      const escalation = reengagement.getEscalationLevel(ctx.lifecycle.inactive_days);

      if (!escalation) {
        return res.json({ ok: true, lifecycle: ctx.lifecycle, escalation: null, message: null, reason: 'user is active' });
      }

      const result = await reengagement.generateReengagementMessage(pool, userId, user);
      res.json({
        ok: true,
        lifecycle: ctx.lifecycle,
        escalation,
        message: result?.message || null,
        context: result?.context || ctx,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/health/reengagement/run — chạy thử run cho toàn bộ users
  router.post('/reengagement/run', async (req, res) => {
    try {
      const result = await runReengagement(pool, sendAndSave);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/escalation-level/:days — test escalation logic
  router.get('/escalation-level/:days', (req, res) => {
    const days = parseInt(req.params.days);
    if (isNaN(days)) return res.status(400).json({ ok: false, error: 'Invalid days' });
    res.json({ ok: true, days, escalation: reengagement.getEscalationLevel(days) });
  });

  // ─── Illusion Layer endpoints (test/debug) ───────────────────────
  // GET /api/health/illusion-preview/:userId — preview illusion layer cho user
  router.get('/illusion-preview/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      // Get user profile
      const { rows: users } = await pool.query(
        `SELECT u.id, u.display_name, u.full_name, COALESCE(u.language_preference,'vi') AS lang,
                uop.birth_year, uop.gender
         FROM users u JOIN user_onboarding_profiles uop ON uop.user_id = u.id
         WHERE u.id = $1`, [userId]
      );
      if (users.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const user = users[0];

      // Get illusion context
      const ctx = await illusionLayer.buildCheckinContext(pool, userId);

      // Get user's latest active script
      const { rows: scripts } = await pool.query(
        `SELECT script_data, cluster_key FROM triage_scripts
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (scripts.length === 0) {
        return res.json({ ok: true, context: ctx, message: 'No active script found', illusion: null });
      }

      const scriptData = scripts[0].script_data;

      // Get original output (no illusion)
      const original = getNextQuestion(scriptData, [], {
        sessionType: 'initial',
        profile: user,
      });

      // Get illusion output
      const illusion = getNextQuestionWithIllusion(scriptData, [], {
        sessionType: 'initial',
        profile: user,
        illusionContext: ctx,
        user,
      });

      // Also get step 1 with empathy (simulate answering step 0)
      const lastAnswer = { question_id: 'fu1', answer: 'Vẫn vậy' };
      const illusionStep1 = getNextQuestionWithIllusion(scriptData,
        [{ question_id: original.question?.id || 'q1', answer: 5 }],
        { sessionType: 'initial', profile: user, illusionContext: ctx, user, lastAnswer }
      );

      // Also get conclusion with progress
      const allAnswers = (scriptData.questions || scriptData.followup_questions || []).map((q, i) =>
        ({ question_id: q.id, answer: i === 0 ? 5 : 'Vẫn vậy' })
      );
      const illusionConclusion = getNextQuestionWithIllusion(scriptData, allAnswers,
        { sessionType: 'initial', profile: user, illusionContext: ctx, user }
      );

      res.json({
        ok: true,
        context: ctx,
        clusterKey: scripts[0].cluster_key,
        original: {
          greeting: scriptData.greeting,
          question: original.question,
        },
        illusion: {
          greeting: illusion._greeting || null,
          continuity: illusion._continuity || null,
          question: illusion.question,
          _illusion: illusion._illusion,
        },
        step1_empathy: illusionStep1._empathy || null,
        conclusion_progress: illusionConclusion._progress || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Notification Intelligence endpoints (test/debug) ────────────
  // GET /api/health/notif-preview/:userId/:triggerType
  router.get('/notif-preview/:userId/:triggerType', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { triggerType } = req.params;
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    if (!['morning', 'afternoon', 'evening', 'alert_severity', 'alert_trend'].includes(triggerType)) {
      return res.status(400).json({ ok: false, error: 'Invalid triggerType. Use: morning, afternoon, evening, alert_severity, alert_trend' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.display_name, u.full_name, COALESCE(u.language_preference,'vi') AS lang,
                uop.birth_year, uop.gender
         FROM users u JOIN user_onboarding_profiles uop ON uop.user_id = u.id
         WHERE u.id = $1`, [userId]
      );
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const msg = await notifIntel.generateMessage(pool, userId, triggerType, rows[0]);
      res.json({ ok: true, message: msg.text, templateId: msg.templateId, context: msg.context });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/notif-context/:userId — raw context cho debug
  router.get('/notif-context/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const ctx = await notifIntel.buildUserContext(pool, userId);
      res.json({ ok: true, context: ctx });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/health/notif-alerts/:userId — check if user has pending alerts
  router.get('/notif-alerts/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId || isNaN(userId)) return res.status(400).json({ ok: false, error: 'Invalid userId' });
    try {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const result = await notifIntel.checkAlertTriggers(pool, userId);
      res.json({ ok: true, hasAlert: !!result, alert: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = healthRoutes;
