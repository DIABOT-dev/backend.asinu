'use strict';
const express = require('express'),
  c = require('../services/v21/common'),
  ops = require('../services/v21/ops.service');
const { requireCronSecret } = require('../middleware/cron-auth');
const safe = (work) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await work(req)) });
  } catch (e) {
    c.captureUnexpected(e, req.route?.path);
    res.status(e instanceof c.z.ZodError ? 400 : e.statusCode || 503).json({
      ok: false,
      code:
        e instanceof c.z.ZodError
          ? 'V21_INVALID_CONFIG'
          : e.statusCode
            ? e.code
            : 'V21_UNAVAILABLE',
    });
  }
};
module.exports = (pool) => {
  const r = express.Router();
  r.use(requireCronSecret);
  r.get(
    '/config',
    safe(() => ops.getConfig(pool))
  );
  r.put(
    '/config',
    safe((req) => ops.updateConfig(pool, req.body))
  );
  r.get(
    '/coins/rules',
    safe(() => ops.rules(pool))
  );
  r.put(
    '/coins/rules',
    safe((req) => ops.updateRules(pool, req.body))
  );
  r.get(
    '/rewards',
    safe(() => ops.rewards(pool))
  );
  r.put(
    '/rewards/:code',
    safe((req) => ops.updateReward(pool, req.params.code, req.body))
  );
  r.put(
    '/greeting-templates/:code',
    safe((req) => ops.updateTemplate(pool, req.params.code, req.body))
  );
  return r;
};
