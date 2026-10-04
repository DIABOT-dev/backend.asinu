const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireCronSecret } = require('../middleware/cron-auth');
const { alertCareCircle, runDailyMonitor, runUserMonitor } = require('../controllers/health.controller');
const ops = require('../services/health/health-ops.service');
const { streamChunked } = require('../core/ai/streaming');
const { t, getLang } = require('../i18n');

function healthRoutes(pool) {
  const router = express.Router();
  const handle = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      console.error('[HealthOps] request failed:', error);
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
      }
    }
  };
  const invalid = (req, res, key = 'error.invalid_data') =>
    res.status(400).json({ ok: false, error: t(key, getLang(req)) });
  const notFound = (req, res) =>
    res.status(404).json({ ok: false, error: t('error.user_not_found', getLang(req)) });
  const userId = (req) => parseInt(req.params.userId);
  const validUserId = (id) => id && !isNaN(id);

  router.post('/monitor/daily', requireCronSecret, (req, res) => runDailyMonitor(pool, req, res));
  router.post('/alert-care-circle', requireAuth, (req, res) => alertCareCircle(pool, req, res));
  router.post('/monitor/user/:userId', requireCronSecret, (req, res) =>
    runUserMonitor(pool, req, res)
  );

  // Operational/debug endpoints are not part of the public mobile API.
  router.use(requireCronSecret);

  router.get('/lifecycle', handle(async (_req, res) =>
    res.json({ ok: true, ...(await ops.lifecycleSummary(pool)) })
  ));
  router.get('/lifecycle/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const lifecycle = await ops.lifecycleUser(pool, id);
    if (!lifecycle) return notFound(req, res);
    return res.json({ ok: true, lifecycle });
  }));
  router.post('/lifecycle/update-all', handle(async (_req, res) =>
    res.json({ ok: true, stats: await ops.updateLifecycle(pool) })
  ));
  router.get('/lifecycle/check-script/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const result = await ops.checkScript(pool, id);
    if (!result) return notFound(req, res);
    return res.json({ ok: true, ...result });
  }));

  router.post('/ai/route', handle(async (req, res) =>
    res.json({ ok: true, route: ops.routeModel(req.body) })
  ));
  router.get('/ai/route-stats', handle(async (_req, res) =>
    res.json({ ok: true, stats: ops.getRouteStats() })
  ));
  router.post('/ai/route-triage', handle(async (req, res) =>
    res.json({ ok: true, route: ops.routeTriage(req.body) })
  ));
  router.get('/ai/cache-stats', handle(async (_req, res) =>
    res.json({ ok: true, stats: ops.getCacheStats() })
  ));
  router.post('/ai/cache-test', handle(async (req, res) => {
    const { messages, model } = req.body || {};
    if (!messages) return invalid(req, res, 'error.invalid_payload');
    const result = await ops.cacheTest(messages, model);
    return res.json({ ok: true, cacheHit: result.cacheHit, response: result.response });
  }));
  router.get('/ai/stream-test', handle(async (req, res) =>
    streamChunked(res, t('health.ops.stream_test', getLang(req)), {
      chunkSize: 15,
      delayMs: 50,
      metadata: { source: 'test' },
    })
  ));
  router.get('/ai/distillation-stats', handle(async (_req, res) =>
    res.json({ ok: true, stats: await ops.getGlobalDistillationStats(pool) })
  ));
  router.post('/ai/distillation-collect', handle(async (req, res) => {
    const { taskType, input, output } = req.body || {};
    if (!taskType || !input || !output) return invalid(req, res, 'error.invalid_payload');
    return res.json({ ok: true, ...(await ops.collectDistillation(pool, req.body)) });
  }));
  router.get('/ai/few-shot/:taskType', handle(async (req, res) => {
    const examples = await ops.getFewShotExamples(pool, req.params.taskType, 5);
    return res.json({ ok: true, count: examples.length, examples });
  }));

  router.get('/cache/global', handle(async (_req, res) =>
    res.json({ ok: true, stats: await ops.getGlobalReuseStats(pool) })
  ));
  router.get('/cache/user/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const stats = await ops.reuseStats(pool, id);
    if (!stats) return notFound(req, res);
    return res.json({ ok: true, userId: id, stats });
  }));
  router.get('/cache/top-reused', handle(async (req, res) =>
    res.json({ ok: true, scripts: await ops.getTopReusedScripts(pool, parseInt(req.query.limit) || 10) })
  ));
  router.post('/cache/reuse', handle(async (req, res) => {
    const { userId: targetUserId, clusterKey } = req.body || {};
    if (!targetUserId || !clusterKey) return invalid(req, res, 'error.invalid_payload');
    return res.json({ ok: true, ...(await ops.reuseScript(pool, req.body)) });
  }));
  router.post('/rnd-cycle/run', handle(async (_req, res) =>
    res.json({ ok: true, stats: await ops.runNightlyCycle(pool) })
  ));
  router.get('/rnd-cycle/last', handle(async (_req, res) =>
    res.json({ ok: true, log: await ops.lastCycle(pool) })
  ));

  router.get('/reengagement-preview/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const result = await ops.reengagementPreview(pool, id);
    if (!result) return notFound(req, res);
    return res.json({ ok: true, ...result });
  }));
  router.post('/reengagement/run', handle(async (_req, res) =>
    res.json({ ok: true, result: await ops.runReengagement(pool) })
  ));
  router.get('/escalation-level/:days', handle(async (req, res) => {
    const days = parseInt(req.params.days);
    if (isNaN(days)) return invalid(req, res);
    return res.json({ ok: true, days, escalation: ops.getEscalationLevel(days) });
  }));

  router.get('/illusion-preview/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const result = await ops.illusionPreview(pool, id, getLang(req));
    if (!result) return notFound(req, res);
    return res.json({ ok: true, ...result });
  }));
  router.get('/notif-preview/:userId/:triggerType', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    if (!['morning', 'afternoon', 'evening', 'alert_severity', 'alert_trend'].includes(req.params.triggerType)) {
      return invalid(req, res);
    }
    const result = await ops.notificationPreview(pool, id, req.params.triggerType);
    if (!result) return notFound(req, res);
    return res.json({ ok: true, ...result });
  }));
  router.get('/notif-context/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    return res.json({ ok: true, context: await ops.buildNotificationContext(pool, id) });
  }));
  router.get('/notif-alerts/:userId', handle(async (req, res) => {
    const id = userId(req);
    if (!validUserId(id)) return invalid(req, res, 'error.invalid_user_id');
    const result = await ops.pendingNotificationAlerts(pool, id);
    if (!result) return notFound(req, res);
    return res.json({ ok: true, ...result });
  }));

  return router;
}

module.exports = healthRoutes;
