const { bindController } = require('../middleware/controller-handler.middleware');
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getStatus, getPlans, getHistory } = require('../controllers/subscription.controller');

function subscriptionRoutes(pool) {
  const router = express.Router();

  router.get('/status', requireAuth, bindController(getStatus, pool));
  router.get('/plans', bindController(getPlans, pool));
  router.get('/history', requireAuth, bindController(getHistory, pool));

  return router;
}

module.exports = subscriptionRoutes;
