const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { alertCareCircle, runDailyMonitor, runUserMonitor } = require('../controllers/health.controller');

function healthRoutes(pool) {
  const router = express.Router();

  router.post('/monitor/daily', (req, res) => runDailyMonitor(pool, req, res));
  router.post('/alert-care-circle', requireAuth, (req, res) => alertCareCircle(pool, req, res));
  router.post('/monitor/user/:userId', requireAuth, (req, res) => runUserMonitor(pool, req, res));

  return router;
}

module.exports = healthRoutes;
